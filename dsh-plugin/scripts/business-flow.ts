/* The acceptance fixture reads JSON envelopes dynamically; production DTOs stay strict. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer } from 'node:http';
import { strict as assert } from 'node:assert';
import type { InvokeInput, ApiResult } from '../src/shared/protocol.js';
export async function businessFlow(
  workspaceId: string,
  invoke: (input: InvokeInput) => Promise<ApiResult>,
) {
  let failRequests = false;
  const fixture = createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.end('User-agent: *\nAllow: /');
      return;
    }
    if (failRequests) {
      response.writeHead(503);
      response.end('Intentional local monitoring failure');
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    const rows = Array.from(
      { length: 12 },
      (_, i) =>
        `<article><h2> Item ${i} </h2><span class="price"> ${i + 1} </span><p>Local acceptance document number ${i}. This text verifies corpus building from collected data.</p></article>`,
    ).join('');
    response.end(
      request.url === '/dynamic'
        ? `<!doctype html><main id="rows"></main><script>setTimeout(()=>document.querySelector('main').innerHTML=${JSON.stringify(rows)},50)</script>`
        : `<!doctype html><main>${rows}</main>`,
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  const call = async (
    operationId: string,
    path: Record<string, string> = {},
    body?: any,
    headers?: Record<string, string>,
    expected = 200,
  ): Promise<any> => {
    const result = await invoke({
      workspaceId,
      operationId,
      path,
      ...(body === undefined ? {} : { body }),
      ...(headers ? { headers } : {}),
    });
    assert.equal(result.status, expected, `${operationId}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const terminal = async (operationId: string, path: Record<string, string>) => {
    for (let attempt = 0; attempt < 240; attempt++) {
      const job = await call(operationId, path);
      const state = job.state ?? job.status;
      if (['failed', 'canceled', 'cancelled'].includes(state)) throw new Error(JSON.stringify(job));
      if (['succeeded', 'completed'].includes(state)) return job;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Job did not finish: ${operationId}`);
  };
  try {
    const definition = {
      type: 'css',
      container: 'article',
      fields: {
        name: { selector: 'h2', value: 'text', dataType: 'string' },
        price: { selector: '.price', value: 'text', dataType: 'string' },
        body: { selector: 'p', value: 'text', dataType: 'string' },
      },
    };
    const taskIds: string[] = [];
    let datasetId = '';
    for (const dynamic of [false, true]) {
      const task = await call(
        'createTask',
        {},
        {
          name: `DSH ${dynamic ? 'dynamic' : 'manual'} ${Date.now()}`,
          startUrl: origin + (dynamic ? '/dynamic' : '/static'),
          instruction: 'Collect name, price and body',
          schedule: { mode: 'manual', timezone: 'Asia/Singapore' },
          requestSettings: {
            headers: {},
            cookies: [],
            timeoutMs: 10000,
            retries: 0,
            retryBackoffMs: 100,
            concurrency: 1,
            delayMs: 0,
            maxRequests: 1,
            maxRuntimeMs: 30000,
            domainRateLimitPerMinute: 60,
            respectRobotsTxt: true,
            maxResponseBytes: 20971520,
            redirectLimit: 5,
          },
          browserSettings: {
            enabled: dynamic,
            waitUntil: 'domcontentloaded',
            waitForSelector: 'article',
            actions: [],
          },
          pagination: { type: 'none' },
          outputSettings: { persistRecords: true },
          networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
        },
        undefined,
        201,
      );
      taskIds.push(task.id);
      await call(
        'updateTask',
        { taskId: task.id },
        { name: 'Stale update must fail' },
        { 'if-match': '"999999"' },
        412,
      );
      const rule = await call(
        'createRule',
        { taskId: task.id },
        { name: 'Manual fixture rule', definition, generatedBy: 'human' },
        undefined,
        201,
      );
      assert.ok(rule.version.id);
      const key = crypto.randomUUID();
      const run = await call(
        'createRun',
        { taskId: task.id },
        undefined,
        { 'idempotency-key': key },
        202,
      );
      assert.equal(
        (await call('createRun', { taskId: task.id }, undefined, { 'idempotency-key': key }, 202))
          .runId,
        run.runId,
      );
      await terminal('getRun', { runId: run.runId });
      const records = await call('listRunRecords', { runId: run.runId });
      assert.equal(records.items.length, 12);
      const datasets = await call('listDatasets');
      datasetId =
        datasets.items.find((row: any) => row.sourceTaskId === task.id)?.id ?? datasets.items[0].id;
      console.log('COLLECTED', dynamic ? 'dynamic' : 'manual', run.runId, datasetId);
    }
    if (process.env.DSH_TEST_MODEL_FIXTURE === '1') {
      const suggested = await call(
        'analyzeTaskRule',
        { taskId: taskIds[0]! },
        { useAi: true, forceBrowser: false },
      );
      assert.equal(suggested.aiUsed, true);
      console.log('DSH_MODEL_FIXTURE_PASSED');
    }
    console.log('VERSION_CONFLICT_AND_IDEMPOTENCY_PASSED');
    const snapshot = await call('createDatasetSnapshot', { datasetId }, {}, undefined, 201);
    assert.equal(snapshot.status, 'ready');
    const steps = [
      { type: 'trim', fields: ['price'] },
      { type: 'convert', fields: ['price'], targetType: 'number' },
    ];
    const recipe = await call(
      'saveDatasetCleaningRecipe',
      { datasetId },
      { name: 'Numeric prices', steps, expectedFields: { price: 'string' } },
      undefined,
      201,
    );
    const preview = await call(
      'previewDatasetCleaning',
      { datasetId },
      { mode: 'steps', snapshotId: snapshot.id, steps, expectedFields: { price: 'string' } },
    );
    assert.ok(preview.steps.length);
    const cleaning = await call(
      'applyDatasetCleaning',
      { datasetId },
      { snapshotId: snapshot.id, recipeVersionId: recipe.version.id },
      undefined,
      201,
    );
    const cleanedId = cleaning.session.selectedSnapshotId;
    assert.notEqual(cleanedId, snapshot.id);
    const job = await call(
      'createAnalysisJob',
      {},
      {
        datasetId,
        snapshotId: cleanedId,
        questionId: 'distribution',
        methodId: 'stats.descriptive',
        methodVersion: '1.0.0',
        parameters: { fields: ['price'] },
      },
      undefined,
      202,
    );
    const finished = await terminal('getAnalysisJob', { jobId: job.id });
    assert.ok(finished.resultId);
    const source = await call('getDatasetSnapshot', { datasetId, snapshotId: snapshot.id });
    assert.equal(source.fingerprint, snapshot.fingerprint);
    const corpus = await call(
      'createCorpus',
      {},
      { name: 'DSH acceptance corpus', datasetId },
      undefined,
      201,
    );
    const corpusInput = {
      name: 'Text chunks',
      snapshotPolicy: { mode: 'pinned', snapshotId: cleanedId },
      selectedTextFields: ['body'],
      metadataFields: ['name'],
      stripHtml: true,
      unicodeNormalization: 'NFKC',
      deduplication: 'none',
      nearDuplicateThreshold: 0.9,
      chunkSize: 2000,
      chunkOverlap: 100,
      languagePolicy: 'generic',
      outputFormats: ['parquet', 'jsonl'],
    };
    const corpusRecipe = await call(
      'createCorpusRecipe',
      { corpusId: corpus.id },
      corpusInput,
      undefined,
      201,
    );
    await call(
      'previewCorpus',
      { corpusId: corpus.id },
      { snapshotId: cleanedId, recipe: corpusInput },
    );
    const build = await call(
      'createCorpusBuild',
      { corpusId: corpus.id },
      { recipeId: corpusRecipe.id, snapshotId: cleanedId },
      undefined,
      202,
    );
    const built = await terminal('getCorpusBuild', { buildId: build.id });
    assert.ok(built.versionId);
    const exported = await call(
      'exportDataset',
      { datasetId },
      { format: 'json', jsonMode: 'jsonl', fields: ['name', 'price'] },
      undefined,
      201,
    );
    assert.ok(exported.id);
    console.log('SNAPSHOT_CLEANING_ANALYSIS_CORPUS_EXPORT_PASSED');
    const monitoredTask = taskIds.at(-1)!;
    await call(
      'updateTaskQualityPolicy',
      { taskId: monitoredTask },
      {
        enabled: true,
        baselineRuns: 1,
        minimumBaselineRuns: 1,
        rules: [
          { kind: 'run-failed', enabled: true, cooldownSeconds: 0, aggregationSeconds: 3600 },
        ],
      },
    );
    failRequests = true;
    const failedRun = await call('createRun', { taskId: monitoredTask }, undefined, undefined, 202);
    let state = 'queued';
    for (let attempt = 0; attempt < 480 && state !== 'failed'; attempt++) {
      state = (await call('getRun', { runId: failedRun.runId })).status;
      if (state !== 'failed') await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(state, 'failed');
    let alerts: any[] = [];
    for (let attempt = 0; attempt < 100 && !alerts.length; attempt++) {
      alerts = (await call('listTaskMonitoringAlerts', { taskId: monitoredTask })).items;
      if (!alerts.length) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(alerts.length);
    await call('getTaskHealth', { taskId: monitoredTask });
    console.log('PERSISTENT_MONITORING_PASSED');

    console.log(
      'BUSINESS_FLOW_PASSED',
      JSON.stringify({
        taskIds,
        datasetId,
        snapshotId: snapshot.id,
        cleanedId,
        analysisJobId: job.id,
        corpusBuildId: build.id,
        artifactId: exported.id,
      }),
    );
    return { datasetId, taskId: taskIds[0]!, artifact: exported };
  } finally {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}
