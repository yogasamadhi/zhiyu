import { createHash } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  max,
  ne,
  or,
  sql as dsql,
} from 'drizzle-orm';
import { migrate as runMigrations } from 'drizzle-orm/postgres-js/migrator';
import type {
  ActiveRuleRecord,
  ApiToken,
  ArtifactDescriptor,
  CrawlRun,
  CrawlTask,
  DatasetDiffPage,
  DatasetRecord,
  DatasetRecordPage,
  DatasetSettings,
  DatasetStats,
  DeliveryAttempt,
  DomainEvent,
  DomainEventPage,
  ExtractedRecord,
  GeneratedBy,
  OutputDestination,
  PreferenceSignal,
  PreferenceSignalInput,
  PreferenceSignalPage,
  RecordChange,
  RecordChangePage,
  RecordPage,
  Repository,
  RetentionPolicy,
  RuleRecord,
  RuleDefinitionInput,
  RuleRepairProposal,
  RuleVersionRecord,
  RunLogEntry,
  RunLogPage,
  RunRequestEntry,
  RunRequestPage,
  RunSuccessOutcome,
  RuntimeJob,
  TaskCreate,
  TaskDetail,
  TaskListItem,
  TaskUpdate,
  TrendSourceBinding,
} from '@zhiyun/contracts';
import { normalizeCrawlPlan, preferenceContentSchema, scheduleSchema } from '@zhiyun/contracts';
import { db, sql } from './database.js';
import {
  artifacts,
  apiTokens,
  crawlRuns,
  datasetRecords,
  datasets,
  deliveryAttempts,
  domainEvents,
  extractedRecords,
  extractionRules,
  idempotencyKeys,
  outputDestinations,
  preferenceSignals,
  recordChanges,
  ruleVersions,
  ruleRepairProposals,
  runLogs,
  runRequests,
  runtimeJobs,
  runtimeSettings,
  taskSchedules,
  taskOutputBindings,
  tasks,
  trendSources,
} from './schema.js';

type PostgresTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function taskRow(row: typeof tasks.$inferSelect): CrawlTask {
  return {
    ...row,
    schedule: scheduleSchema.parse(row.schedule),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function runRow(row: typeof crawlRuns.$inferSelect): CrawlRun {
  return {
    ...row,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    createdAt: iso(row.createdAt)!,
    cancelRequestedAt: iso(row.cancelRequestedAt),
    deliveryStatus: row.deliveryStatus as CrawlRun['deliveryStatus'],
  };
}

function ruleRow(row: typeof extractionRules.$inferSelect): RuleRecord {
  return { ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! };
}

function versionRow(row: typeof ruleVersions.$inferSelect): RuleVersionRecord {
  return {
    ...row,
    definition: normalizeCrawlPlan(row.definition),
    createdAt: iso(row.createdAt)!,
  };
}

function trendSourceRow(row: typeof trendSources.$inferSelect): TrendSourceBinding {
  return {
    ...row,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function preferenceSignalRow(row: typeof preferenceSignals.$inferSelect): PreferenceSignal {
  return {
    id: row.id,
    targetKey: row.targetKey,
    kind: row.kind,
    content: preferenceContentSchema.parse(row.content),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function recordRow(row: typeof extractedRecords.$inferSelect): ExtractedRecord {
  return { ...row, createdAt: iso(row.createdAt)! };
}

function eventRow(row: typeof domainEvents.$inferSelect): DomainEvent {
  return {
    ...row,
    aggregateType: row.aggregateType as DomainEvent['aggregateType'],
    createdAt: iso(row.createdAt)!,
  };
}

function artifactRow(
  row: typeof artifacts.$inferSelect,
): ArtifactDescriptor & { storageKey: string } {
  return {
    ...row,
    format: row.format as ArtifactDescriptor['format'],
    createdAt: iso(row.createdAt)!,
  };
}

function datasetRecordRow(row: typeof datasetRecords.$inferSelect): DatasetRecord {
  return {
    ...row,
    firstSeenAt: iso(row.firstSeenAt)!,
    lastSeenAt: iso(row.lastSeenAt)!,
  };
}

function recordChangeRow(row: typeof recordChanges.$inferSelect): RecordChange {
  return {
    ...row,
    type: row.type as RecordChange['type'],
    before: row.before ?? null,
    after: row.after ?? null,
    createdAt: iso(row.createdAt)!,
  };
}

function runLogRow(row: typeof runLogs.$inferSelect): RunLogEntry {
  return {
    ...row,
    level: row.level as RunLogEntry['level'],
    createdAt: iso(row.createdAt)!,
  };
}

function runRequestRow(row: typeof runRequests.$inferSelect): RunRequestEntry {
  return {
    ...row,
    kind: row.kind as RunRequestEntry['kind'],
    status: row.status as RunRequestEntry['status'],
    createdAt: iso(row.createdAt)!,
  };
}

function outputDestinationRow(row: typeof outputDestinations.$inferSelect): OutputDestination {
  return {
    ...row,
    type: row.type as OutputDestination['type'],
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function deliveryAttemptRow(row: typeof deliveryAttempts.$inferSelect): DeliveryAttempt {
  return {
    ...row,
    status: row.status as DeliveryAttempt['status'],
    nextAttemptAt: iso(row.nextAttemptAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function apiTokenRow(row: typeof apiTokens.$inferSelect): ApiToken {
  return {
    id: row.id,
    name: row.name,
    taskIds: row.taskIds,
    rateLimitPerMinute: row.rateLimitPerMinute,
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    createdAt: iso(row.createdAt)!,
  };
}

function repairProposalRow(row: typeof ruleRepairProposals.$inferSelect): RuleRepairProposal {
  return {
    ...row,
    status: row.status as RuleRepairProposal['status'],
    runId: row.runId,
    definition: normalizeCrawlPlan(row.definition),
    testedAt: iso(row.testedAt),
    createdAt: iso(row.createdAt)!,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function recordKey(data: Record<string, unknown>, settings: DatasetSettings): string {
  return contentHash(
    settings.keyFields.length > 0 ? settings.keyFields.map((field) => data[field] ?? null) : data,
  );
}

export class PostgresRepository implements Repository {
  private async completeRunInTransaction(
    tx: PostgresTransaction,
    runId: string,
    taskId: string,
    outcome: RunSuccessOutcome,
    settings: DatasetSettings = { mode: 'snapshot', keyFields: [], detectRemoved: true },
  ): Promise<void> {
    for (let offset = 0; offset < outcome.records.length; offset += 1_000) {
      const batch = outcome.records.slice(offset, offset + 1_000);
      await tx.insert(extractedRecords).values(
        batch.map((record, index) => {
          const absoluteIndex = offset + index;
          const baseKey = recordKey(record.data, settings);
          return {
            taskId,
            runId,
            ...record,
            recordKey:
              settings.mode === 'append' ? `${runId}:${baseKey}:${absoluteIndex}` : baseKey,
            contentHash: contentHash(record.data),
          };
        }),
      );
    }
    const [completed] = await tx
      .update(crawlRuns)
      .set({
        status: 'succeeded',
        finishedAt: new Date(),
        requestCount: outcome.requestCount,
        recordCount: outcome.recordCount,
        browserUsed: outcome.browserUsed,
        aiUsed: outcome.aiUsed,
        phase: 'completed',
        progress: 1,
        warningCount: Array.isArray(outcome.metadata.warnings)
          ? outcome.metadata.warnings.length
          : 0,
        metadata: outcome.metadata,
      })
      .where(
        and(
          eq(crawlRuns.id, runId),
          eq(crawlRuns.taskId, taskId),
          inArray(crawlRuns.status, ['queued', 'running']),
        ),
      )
      .returning({ id: crawlRuns.id });
    if (!completed) throw new Error(`Run ${runId} is no longer completable`);
    await tx
      .update(tasks)
      .set({ status: 'succeeded', updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
    await tx.insert(domainEvents).values({
      type: 'run.succeeded',
      aggregateType: 'run',
      aggregateId: runId,
      payload: { taskId, recordCount: outcome.recordCount },
    });
  }

  async health(): Promise<void> {
    await sql`select 1`;
  }

  async migrate(): Promise<void> {
    await runMigrations(db, {
      migrationsFolder: new URL('../drizzle', import.meta.url).pathname,
    });
  }

  async close(): Promise<void> {
    // The process owns the shared PostgreSQL pool and closes it at process shutdown.
  }

  async recoverInterruptedRuns(): Promise<number> {
    return db.transaction(async (tx) => {
      const interrupted = await tx
        .update(crawlRuns)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          error: 'Runtime was interrupted before the run completed',
          metadata: { errorCode: 'RUNTIME_INTERRUPTED' },
        })
        .where(eq(crawlRuns.status, 'running'))
        .returning();
      for (const run of interrupted) {
        await tx
          .update(tasks)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(tasks.id, run.taskId));
        await tx.insert(domainEvents).values({
          type: 'run.failed',
          aggregateType: 'run',
          aggregateId: run.id,
          payload: { taskId: run.taskId, code: 'RUNTIME_INTERRUPTED' },
        });
      }
      return interrupted.length;
    });
  }

  async createTask(input: TaskCreate): Promise<CrawlTask> {
    return db.transaction(async (tx) => {
      const [created] = await tx
        .insert(tasks)
        .values({ ...input, status: 'draft' })
        .returning();
      if (!created) throw new Error('Task insert did not return a row');
      if (input.schedule.mode === 'cron' && input.schedule.cron) {
        await tx.insert(taskSchedules).values({
          taskId: created.id,
          cron: input.schedule.cron,
          timezone: input.schedule.timezone,
          misfirePolicy: input.schedule.misfirePolicy,
        });
      }
      if (input.outputBindings.length > 0) {
        await tx.insert(taskOutputBindings).values(
          input.outputBindings.map((destinationId) => ({
            taskId: created.id,
            destinationId,
          })),
        );
      }
      await tx.insert(domainEvents).values({
        type: 'task.created',
        aggregateType: 'task',
        aggregateId: created.id,
        payload: { revision: created.revision },
      });
      return taskRow(created);
    });
  }

  async listTasks(): Promise<TaskListItem[]> {
    const rows = await db.select().from(tasks).orderBy(desc(tasks.updatedAt));
    return Promise.all(
      rows.map(async (row) => {
        const latest = (
          await db
            .select()
            .from(crawlRuns)
            .where(eq(crawlRuns.taskId, row.id))
            .orderBy(desc(crawlRuns.createdAt))
            .limit(1)
        )[0];
        return { ...taskRow(row), latestRun: latest ? runRow(latest) : null };
      }),
    );
  }

  async getTask(id: string): Promise<TaskDetail | null> {
    const row = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
    if (!row) return null;
    return { ...taskRow(row), activeRule: await this.getActiveRule(id) };
  }

  async updateTask(
    id: string,
    input: TaskUpdate,
    expectedRevision: number,
  ): Promise<CrawlTask | null> {
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(tasks)
        .set({ ...input, revision: expectedRevision + 1, updatedAt: new Date() })
        .where(and(eq(tasks.id, id), eq(tasks.revision, expectedRevision)))
        .returning();
      if (!updated) return null;
      if (input.schedule) {
        await tx.delete(taskSchedules).where(eq(taskSchedules.taskId, id));
        if (input.schedule.mode === 'cron' && input.schedule.cron) {
          await tx.insert(taskSchedules).values({
            taskId: id,
            cron: input.schedule.cron,
            timezone: input.schedule.timezone,
            misfirePolicy: input.schedule.misfirePolicy,
          });
        }
      }
      if (input.outputBindings) {
        await tx.delete(taskOutputBindings).where(eq(taskOutputBindings.taskId, id));
        if (input.outputBindings.length > 0) {
          await tx
            .insert(taskOutputBindings)
            .values(input.outputBindings.map((destinationId) => ({ taskId: id, destinationId })));
        }
      }
      await tx.insert(domainEvents).values({
        type: 'task.updated',
        aggregateType: 'task',
        aggregateId: id,
        payload: { revision: updated.revision },
      });
      return taskRow(updated);
    });
  }

  async deleteTask(id: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const deleted = await tx.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
      if (deleted.length === 0) return false;
      await tx.insert(domainEvents).values({
        type: 'task.deleted',
        aggregateType: 'task',
        aggregateId: id,
        payload: {},
      });
      return true;
    });
  }

  async listTrendSourceBindings(): Promise<TrendSourceBinding[]> {
    return (await db.select().from(trendSources).orderBy(asc(trendSources.key))).map(
      trendSourceRow,
    );
  }

  async getTrendSourceBinding(key: string): Promise<TrendSourceBinding | null> {
    const row = (await db.select().from(trendSources).where(eq(trendSources.key, key)).limit(1))[0];
    return row ? trendSourceRow(row) : null;
  }

  async upsertTrendSourceBinding(
    input: Pick<TrendSourceBinding, 'key' | 'platform' | 'taskId' | 'enabled' | 'autoRefresh'>,
  ): Promise<TrendSourceBinding> {
    const [row] = await db
      .insert(trendSources)
      .values(input)
      .onConflictDoUpdate({
        target: trendSources.key,
        set: {
          platform: input.platform,
          taskId: input.taskId,
          enabled: input.enabled,
          autoRefresh: input.autoRefresh,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('Trend source binding could not be saved');
    return trendSourceRow(row);
  }

  async updateTrendSourceBinding(
    key: string,
    input: Partial<Pick<TrendSourceBinding, 'taskId' | 'enabled' | 'autoRefresh'>>,
  ): Promise<TrendSourceBinding | null> {
    const [row] = await db
      .update(trendSources)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(trendSources.key, key))
      .returning();
    return row ? trendSourceRow(row) : null;
  }

  async listPreferenceSignals(cursor?: string, limit = 100): Promise<PreferenceSignalPage> {
    const offset = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10) : 0;
    const rows = await db
      .select()
      .from(preferenceSignals)
      .orderBy(desc(preferenceSignals.updatedAt), desc(preferenceSignals.id))
      .offset(Number.isFinite(offset) ? offset : 0)
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(preferenceSignalRow);
    return {
      items,
      nextCursor: hasMore
        ? Buffer.from(String((Number.isFinite(offset) ? offset : 0) + limit)).toString('base64url')
        : null,
    };
  }

  async upsertPreferenceSignal(
    input: PreferenceSignalInput & { targetKey: string },
  ): Promise<PreferenceSignal> {
    return db.transaction(async (tx) => {
      await tx.execute(dsql`SELECT pg_advisory_xact_lock(hashtextextended(${input.targetKey}, 0))`);
      if (input.kind === 'like' || input.kind === 'dislike') {
        await tx
          .delete(preferenceSignals)
          .where(
            and(
              eq(preferenceSignals.targetKey, input.targetKey),
              eq(preferenceSignals.kind, input.kind === 'like' ? 'dislike' : 'like'),
            ),
          );
      }
      const [row] = await tx
        .insert(preferenceSignals)
        .values({
          targetKey: input.targetKey,
          kind: input.kind,
          platform: input.content.platform,
          contentType: input.content.contentType,
          externalId: input.content.externalId,
          title: input.content.title,
          content: input.content,
        })
        .onConflictDoUpdate({
          target: [preferenceSignals.targetKey, preferenceSignals.kind],
          set: {
            platform: input.content.platform,
            contentType: input.content.contentType,
            externalId: input.content.externalId,
            title: input.content.title,
            content: input.content,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error('Preference signal could not be saved');
      return preferenceSignalRow(row);
    });
  }

  async deletePreferenceSignal(id: string): Promise<boolean> {
    return (
      (await db.delete(preferenceSignals).where(eq(preferenceSignals.id, id)).returning()).length >
      0
    );
  }

  async clearPreferenceSignals(): Promise<number> {
    return (await db.delete(preferenceSignals).returning({ id: preferenceSignals.id })).length;
  }

  async listScheduledTasks() {
    const rows = await db.select().from(taskSchedules);
    return rows.map((row) => ({
      id: row.taskId,
      schedule: scheduleSchema.parse({
        mode: 'cron',
        cron: row.cron,
        timezone: row.timezone,
        misfirePolicy: row.misfirePolicy,
      }),
      lastTriggeredAt: iso(row.lastTriggeredAt),
      updatedAt: iso(row.updatedAt)!,
    }));
  }

  async markScheduleTriggered(
    taskId: string,
    triggeredAt = new Date().toISOString(),
  ): Promise<void> {
    await db
      .update(taskSchedules)
      .set({ lastTriggeredAt: new Date(triggeredAt) })
      .where(eq(taskSchedules.taskId, taskId));
  }

  async getSchedulingPaused(): Promise<boolean> {
    const row = (
      await db.select().from(runtimeSettings).where(eq(runtimeSettings.key, 'scheduler')).limit(1)
    )[0];
    return row?.value.paused === true;
  }

  async setSchedulingPaused(paused: boolean): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .insert(runtimeSettings)
        .values({ key: 'scheduler', value: { paused }, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: runtimeSettings.key,
          set: { value: { paused }, updatedAt: new Date() },
        });
      await tx.insert(domainEvents).values({
        type: paused ? 'scheduler.paused' : 'scheduler.resumed',
        aggregateType: 'runtime',
        aggregateId: 'scheduler',
        payload: { paused },
      });
    });
  }

  async setTaskBrowserSettings(id: string, settings: CrawlTask['browserSettings']): Promise<void> {
    await db
      .update(tasks)
      .set({ browserSettings: settings, updatedAt: new Date() })
      .where(eq(tasks.id, id));
  }

  async listRules(taskId: string): Promise<Array<RuleRecord & { versions: RuleVersionRecord[] }>> {
    const rows = await db
      .select()
      .from(extractionRules)
      .where(eq(extractionRules.taskId, taskId))
      .orderBy(desc(extractionRules.createdAt));
    return Promise.all(
      rows.map(async (row) => ({
        ...ruleRow(row),
        versions: (
          await db
            .select()
            .from(ruleVersions)
            .where(eq(ruleVersions.ruleId, row.id))
            .orderBy(desc(ruleVersions.version))
        ).map(versionRow),
      })),
    );
  }

  async createRule(
    taskId: string,
    name: string,
    definition: RuleDefinitionInput,
    generatedBy: GeneratedBy,
  ): Promise<{ rule: RuleRecord; version: RuleVersionRecord }> {
    return db.transaction(async (tx) => {
      const [rule] = await tx.insert(extractionRules).values({ taskId, name }).returning();
      if (!rule) throw new Error('Rule insert did not return a row');
      const [version] = await tx
        .insert(ruleVersions)
        .values({
          ruleId: rule.id,
          version: 1,
          definition: normalizeCrawlPlan(definition),
          generatedBy,
        })
        .returning();
      if (!version) throw new Error('Rule version insert did not return a row');
      const [active] = await tx
        .update(extractionRules)
        .set({ activeVersionId: version.id, updatedAt: new Date() })
        .where(eq(extractionRules.id, rule.id))
        .returning();
      await tx
        .update(tasks)
        .set({ status: 'ready', updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await tx.insert(domainEvents).values({
        type: 'rule.activated',
        aggregateType: 'rule',
        aggregateId: rule.id,
        payload: { taskId, version: 1 },
      });
      return { rule: ruleRow(active!), version: versionRow(version) };
    });
  }

  async createRuleVersion(
    taskId: string,
    ruleId: string,
    definition: RuleDefinitionInput,
    generatedBy: GeneratedBy,
  ): Promise<RuleVersionRecord | null> {
    return db.transaction(async (tx) => {
      const rule = (
        await tx
          .select()
          .from(extractionRules)
          .where(and(eq(extractionRules.id, ruleId), eq(extractionRules.taskId, taskId)))
          .limit(1)
      )[0];
      if (!rule) return null;
      const [current] = await tx
        .select({ value: max(ruleVersions.version) })
        .from(ruleVersions)
        .where(eq(ruleVersions.ruleId, ruleId));
      const next = (current?.value ?? 0) + 1;
      const [version] = await tx
        .insert(ruleVersions)
        .values({ ruleId, version: next, definition: normalizeCrawlPlan(definition), generatedBy })
        .returning();
      if (!version) throw new Error('Rule version insert did not return a row');
      await tx
        .update(extractionRules)
        .set({ activeVersionId: version.id, updatedAt: new Date() })
        .where(eq(extractionRules.id, ruleId));
      await tx.insert(domainEvents).values({
        type: 'rule.activated',
        aggregateType: 'rule',
        aggregateId: ruleId,
        payload: { taskId, version: next },
      });
      return versionRow(version);
    });
  }

  async getActiveRule(taskId: string): Promise<ActiveRuleRecord | null> {
    const row = (
      await db
        .select({ rule: extractionRules, version: ruleVersions })
        .from(extractionRules)
        .innerJoin(ruleVersions, eq(ruleVersions.id, extractionRules.activeVersionId))
        .where(eq(extractionRules.taskId, taskId))
        .limit(1)
    )[0];
    return row ? { rule: ruleRow(row.rule), version: versionRow(row.version) } : null;
  }

  async createRun(taskId: string): Promise<CrawlRun> {
    return db.transaction(async (tx) => {
      const [run] = await tx.insert(crawlRuns).values({ taskId, status: 'queued' }).returning();
      if (!run) throw new Error('Run insert did not return a row');
      await tx.insert(domainEvents).values({
        type: 'run.queued',
        aggregateType: 'run',
        aggregateId: run.id,
        payload: { taskId },
      });
      return runRow(run);
    });
  }

  async listRuns(taskId: string): Promise<CrawlRun[]> {
    return (
      await db
        .select()
        .from(crawlRuns)
        .where(eq(crawlRuns.taskId, taskId))
        .orderBy(desc(crawlRuns.createdAt))
    ).map(runRow);
  }

  async getRun(id: string): Promise<CrawlRun | null> {
    const row = (await db.select().from(crawlRuns).where(eq(crawlRuns.id, id)).limit(1))[0];
    return row ? runRow(row) : null;
  }

  async startRun(runId: string, taskId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [run] = await tx
        .update(crawlRuns)
        .set({
          status: 'running',
          startedAt: new Date(),
          error: null,
          errorCode: null,
          phase: 'starting',
          progress: 0.02,
        })
        .where(
          and(
            eq(crawlRuns.id, runId),
            eq(crawlRuns.taskId, taskId),
            eq(crawlRuns.status, 'queued'),
          ),
        )
        .returning();
      if (!run) return false;
      await tx
        .update(tasks)
        .set({ status: 'running', updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await tx.insert(domainEvents).values({
        type: 'run.running',
        aggregateType: 'run',
        aggregateId: runId,
        payload: { taskId },
      });
      return true;
    });
  }

  async completeRun(runId: string, taskId: string, outcome: RunSuccessOutcome): Promise<void> {
    await db.transaction((tx) => this.completeRunInTransaction(tx, runId, taskId, outcome));
  }

  async failRun(
    runId: string,
    taskId: string,
    error: string,
    code = 'CRAWLER_ERROR',
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(crawlRuns)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          error,
          errorCode: code,
          phase: 'failed',
          progress: 1,
          metadata: { errorCode: code },
        })
        .where(eq(crawlRuns.id, runId));
      await tx
        .update(tasks)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await tx.insert(domainEvents).values({
        type: 'run.failed',
        aggregateType: 'run',
        aggregateId: runId,
        payload: { taskId, code, error },
      });
    });
  }

  async cancelRun(runId: string): Promise<CrawlRun | null> {
    return db.transaction(async (tx) => {
      const [run] = await tx
        .update(crawlRuns)
        .set({
          status: 'canceled',
          finishedAt: new Date(),
          error: 'Canceled by user',
          errorCode: 'CANCELED',
          phase: 'canceled',
          progress: 1,
        })
        .where(and(eq(crawlRuns.id, runId), inArray(crawlRuns.status, ['queued', 'running'])))
        .returning();
      if (!run) return null;
      await tx
        .update(tasks)
        .set({ status: 'ready', updatedAt: new Date() })
        .where(eq(tasks.id, run.taskId));
      await tx.insert(domainEvents).values({
        type: 'run.canceled',
        aggregateType: 'run',
        aggregateId: runId,
        payload: { taskId: run.taskId },
      });
      return runRow(run);
    });
  }

  async requestRunCancellation(runId: string): Promise<CrawlRun | null> {
    const [run] = await db
      .update(crawlRuns)
      .set({ cancelRequestedAt: new Date(), phase: 'canceling' })
      .where(and(eq(crawlRuns.id, runId), inArray(crawlRuns.status, ['queued', 'running'])))
      .returning();
    return run ? runRow(run) : null;
  }

  async setRunDeliveryStatus(runId: string, status: CrawlRun['deliveryStatus']): Promise<void> {
    await db.update(crawlRuns).set({ deliveryStatus: status }).where(eq(crawlRuns.id, runId));
  }

  async listRecords(runId: string, cursor: string | undefined, limit: number): Promise<RecordPage> {
    const offset = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10) : 0;
    const rows = await db
      .select()
      .from(extractedRecords)
      .where(eq(extractedRecords.runId, runId))
      .orderBy(asc(extractedRecords.createdAt), asc(extractedRecords.id))
      .limit(limit + 1)
      .offset(Number.isFinite(offset) ? offset : 0);
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map(recordRow),
      nextCursor: hasMore ? Buffer.from(String(offset + limit)).toString('base64url') : null,
    };
  }

  async recordData(runId: string): Promise<Array<Record<string, unknown>>> {
    return (
      await db
        .select({ data: extractedRecords.data })
        .from(extractedRecords)
        .where(eq(extractedRecords.runId, runId))
        .orderBy(asc(extractedRecords.createdAt))
    ).map((row) => row.data);
  }

  private async projectDatasetInTransaction(
    tx: PostgresTransaction,
    taskId: string,
    runId: string,
    settings: DatasetSettings,
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>,
  ): Promise<DatasetStats> {
    let dataset = (await tx.select().from(datasets).where(eq(datasets.taskId, taskId)).limit(1))[0];
    if (!dataset) {
      [dataset] = await tx.insert(datasets).values({ taskId, settings }).returning();
    } else {
      [dataset] = await tx
        .update(datasets)
        .set({ settings, updatedAt: new Date() })
        .where(eq(datasets.id, dataset.id))
        .returning();
    }
    if (!dataset) throw new Error('Dataset could not be created');
    const stats: DatasetStats = { added: 0, updated: 0, removed: 0, unchanged: 0, current: 0 };
    const normalized = new Map<
      string,
      { sourceUrl: string; data: Record<string, unknown>; hash: string }
    >();
    records.forEach((record, index) => {
      const baseKey = recordKey(record.data, settings);
      const key = settings.mode === 'append' ? `${runId}:${baseKey}:${index}` : baseKey;
      normalized.set(key, { ...record, hash: contentHash(record.data) });
    });
    const incoming = [...normalized].map(([key, record]) => ({ key, ...record }));
    for (let offset = 0; offset < incoming.length; offset += 1_000) {
      const batch = incoming.slice(offset, offset + 1_000);
      const existingRows = await tx
        .select()
        .from(datasetRecords)
        .where(
          and(
            eq(datasetRecords.datasetId, dataset.id),
            inArray(
              datasetRecords.recordKey,
              batch.map((entry) => entry.key),
            ),
          ),
        );
      const existingByKey = new Map(existingRows.map((row) => [row.recordKey, row]));
      const changed = batch.filter((entry) => {
        const existing = existingByKey.get(entry.key);
        return !existing || existing.contentHash !== entry.hash || existing.removed;
      });
      const changedKeys = new Set(changed.map((entry) => entry.key));
      const unchanged = batch.filter((entry) => !changedKeys.has(entry.key));
      const seenAt = new Date();
      if (changed.length > 0) {
        const upserted = await tx
          .insert(datasetRecords)
          .values(
            changed.map((entry) => ({
              datasetId: dataset.id,
              taskId,
              recordKey: entry.key,
              sourceUrl: entry.sourceUrl,
              data: entry.data,
              contentHash: entry.hash,
              removed: false,
              firstRunId: runId,
              lastRunId: runId,
              lastSeenAt: seenAt,
            })),
          )
          .onConflictDoUpdate({
            target: [datasetRecords.datasetId, datasetRecords.recordKey],
            set: {
              sourceUrl: dsql`excluded.source_url`,
              data: dsql`excluded.data`,
              contentHash: dsql`excluded.content_hash`,
              removed: false,
              lastRunId: runId,
              lastSeenAt: seenAt,
            },
          })
          .returning({ id: datasetRecords.id, recordKey: datasetRecords.recordKey });
        const idByKey = new Map(upserted.map((row) => [row.recordKey, row.id]));
        await tx.insert(recordChanges).values(
          changed.map((entry) => {
            const existing = existingByKey.get(entry.key);
            return {
              datasetId: dataset.id,
              datasetRecordId: idByKey.get(entry.key)!,
              runId,
              type: existing ? ('updated' as const) : ('added' as const),
              before: existing?.data ?? null,
              after: entry.data,
            };
          }),
        );
        stats.added += changed.filter((entry) => !existingByKey.has(entry.key)).length;
        stats.updated += changed.filter((entry) => existingByKey.has(entry.key)).length;
      }
      if (unchanged.length > 0) {
        await tx
          .update(datasetRecords)
          .set({ removed: false, lastRunId: runId, lastSeenAt: seenAt })
          .where(
            inArray(
              datasetRecords.id,
              unchanged.map((entry) => existingByKey.get(entry.key)!.id),
            ),
          );
        stats.unchanged += unchanged.length;
      }
    }
    if (settings.mode === 'snapshot' && settings.detectRemoved) {
      const stale = await tx
        .update(datasetRecords)
        .set({ removed: true })
        .where(
          and(
            eq(datasetRecords.datasetId, dataset.id),
            eq(datasetRecords.removed, false),
            or(isNull(datasetRecords.lastRunId), ne(datasetRecords.lastRunId, runId)),
          ),
        )
        .returning({ id: datasetRecords.id, data: datasetRecords.data });
      for (let offset = 0; offset < stale.length; offset += 1_000) {
        await tx.insert(recordChanges).values(
          stale.slice(offset, offset + 1_000).map((row) => ({
            datasetId: dataset.id,
            datasetRecordId: row.id,
            runId,
            type: 'removed' as const,
            before: row.data,
            after: null,
          })),
        );
      }
      stats.removed = stale.length;
    }
    const [current] = await tx
      .select({ value: count() })
      .from(datasetRecords)
      .where(and(eq(datasetRecords.datasetId, dataset.id), eq(datasetRecords.removed, false)));
    stats.current = Number(current?.value ?? 0);
    await tx
      .update(datasets)
      .set({ currentCount: stats.current, updatedAt: new Date() })
      .where(eq(datasets.id, dataset.id));
    await tx.update(crawlRuns).set({ datasetStats: stats }).where(eq(crawlRuns.id, runId));
    await tx.insert(domainEvents).values({
      type: 'dataset.projected',
      aggregateType: 'task',
      aggregateId: taskId,
      payload: { runId, ...stats },
    });
    return stats;
  }

  async projectDataset(
    taskId: string,
    runId: string,
    settings: DatasetSettings,
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>,
  ): Promise<DatasetStats> {
    return db.transaction((tx) =>
      this.projectDatasetInTransaction(tx, taskId, runId, settings, records),
    );
  }

  async commitRunSuccess(
    runId: string,
    taskId: string,
    settings: DatasetSettings,
    datasetRecords: Array<{ sourceUrl: string; data: Record<string, unknown> }>,
    outcome: RunSuccessOutcome,
  ): Promise<DatasetStats> {
    return db.transaction(async (tx) => {
      const stats = await this.projectDatasetInTransaction(
        tx,
        taskId,
        runId,
        settings,
        datasetRecords,
      );
      await this.completeRunInTransaction(
        tx,
        runId,
        taskId,
        {
          ...outcome,
          metadata: { ...outcome.metadata, datasetStats: stats },
        },
        settings,
      );
      return stats;
    });
  }

  async applyRetention(taskId: string, policy: RetentionPolicy) {
    return db.transaction(async (tx) => {
      const runs = await tx
        .select({ id: crawlRuns.id, createdAt: crawlRuns.createdAt })
        .from(crawlRuns)
        .where(
          and(eq(crawlRuns.taskId, taskId), dsql`${crawlRuns.status} NOT IN ('queued','running')`),
        )
        .orderBy(desc(crawlRuns.createdAt), desc(crawlRuns.id));
      const runCutoff = policy.runDays ? new Date(Date.now() - policy.runDays * 86_400_000) : null;
      const candidates = runs
        .filter(
          (row, index) =>
            (policy.maxRuns !== null && index >= policy.maxRuns) ||
            (runCutoff !== null && row.createdAt < runCutoff),
        )
        .map((row) => row.id);
      const deletable = candidates;
      const artifactCutoff = policy.artifactDays
        ? new Date(Date.now() - policy.artifactDays * 86_400_000)
        : null;
      const artifactRows = await tx
        .select({
          id: artifacts.id,
          runId: artifacts.runId,
          storageKey: artifacts.storageKey,
          createdAt: artifacts.createdAt,
        })
        .from(artifacts)
        .innerJoin(crawlRuns, eq(crawlRuns.id, artifacts.runId))
        .where(eq(crawlRuns.taskId, taskId));
      const runIds = new Set(deletable);
      const artifactsToDelete = artifactRows.filter(
        (row) =>
          runIds.has(row.runId) || (artifactCutoff !== null && row.createdAt < artifactCutoff),
      );
      for (let index = 0; index < artifactsToDelete.length; index += 500) {
        const ids = artifactsToDelete.slice(index, index + 500).map((row) => row.id);
        if (ids.length > 0) await tx.delete(artifacts).where(inArray(artifacts.id, ids));
      }
      let deletedLogs = 0;
      if (policy.logDays !== null && runs.length > 0) {
        const cutoff = new Date(Date.now() - policy.logDays * 86_400_000);
        for (let index = 0; index < runs.length; index += 500) {
          const ids = runs.slice(index, index + 500).map((row) => row.id);
          const deleted = await tx
            .delete(runLogs)
            .where(and(inArray(runLogs.runId, ids), lt(runLogs.createdAt, cutoff)))
            .returning({ id: runLogs.id });
          deletedLogs += deleted.length;
        }
      }
      let deletedRuns = 0;
      for (let index = 0; index < deletable.length; index += 500) {
        const ids = deletable.slice(index, index + 500);
        const deleted = await tx
          .delete(crawlRuns)
          .where(inArray(crawlRuns.id, ids))
          .returning({ id: crawlRuns.id });
        deletedRuns += deleted.length;
      }
      return {
        deletedRuns,
        deletedLogs,
        deletedArtifacts: artifactsToDelete.length,
        retainedReferencedRuns: 0,
        artifactStorageKeys: artifactsToDelete.map((row) => row.storageKey),
      };
    });
  }

  async listDatasetRecords(
    taskId: string,
    cursor: string | undefined,
    limit: number,
    options: {
      includeRemoved?: boolean;
      query?: string;
      filter?: Record<string, string | number | boolean | null>;
    } = {},
  ): Promise<DatasetRecordPage> {
    const filters = [eq(datasetRecords.taskId, taskId)];
    if (!options.includeRemoved) filters.push(eq(datasetRecords.removed, false));
    if (options.query) {
      filters.push(
        or(
          ilike(datasetRecords.sourceUrl, `%${options.query}%`),
          dsql`${datasetRecords.data}::text ILIKE ${`%${options.query}%`}`,
        )!,
      );
    }
    if (options.filter && Object.keys(options.filter).length > 0) {
      filters.push(dsql`${datasetRecords.data} @> ${JSON.stringify(options.filter)}::jsonb`);
    }
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
        lastSeenAt: string;
        id: string;
      };
      const seenAt = new Date(decoded.lastSeenAt);
      filters.push(
        or(
          lt(datasetRecords.lastSeenAt, seenAt),
          and(eq(datasetRecords.lastSeenAt, seenAt), lt(datasetRecords.id, decoded.id)),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(datasetRecords)
      .where(and(...filters))
      .orderBy(desc(datasetRecords.lastSeenAt), desc(datasetRecords.id))
      .limit(limit + 1);
    const dataset = (
      await db.select().from(datasets).where(eq(datasets.taskId, taskId)).limit(1)
    )[0];
    const latest = (
      await db
        .select({ stats: crawlRuns.datasetStats })
        .from(crawlRuns)
        .where(eq(crawlRuns.taskId, taskId))
        .orderBy(desc(crawlRuns.createdAt))
        .limit(1)
    )[0];
    return {
      items: rows.slice(0, limit).map(datasetRecordRow),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                lastSeenAt: iso(rows[limit - 1]!.lastSeenAt),
                id: rows[limit - 1]!.id,
              }),
            ).toString('base64url')
          : null,
      stats:
        latest?.stats ??
        ({
          added: 0,
          updated: 0,
          removed: 0,
          unchanged: 0,
          current: dataset?.currentCount ?? 0,
        } satisfies DatasetStats),
    };
  }

  async listRecordChanges(
    taskId: string,
    cursor: string | undefined,
    limit: number,
    runId?: string,
  ): Promise<RecordChangePage> {
    const dataset = (
      await db.select().from(datasets).where(eq(datasets.taskId, taskId)).limit(1)
    )[0];
    if (!dataset) return { items: [], nextCursor: null };
    const filters = [eq(recordChanges.datasetId, dataset.id)];
    if (runId) filters.push(eq(recordChanges.runId, runId));
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
        createdAt: string;
        id: string;
      };
      const createdAt = new Date(decoded.createdAt);
      filters.push(
        or(
          lt(recordChanges.createdAt, createdAt),
          and(eq(recordChanges.createdAt, createdAt), lt(recordChanges.id, decoded.id)),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(recordChanges)
      .where(and(...filters))
      .orderBy(desc(recordChanges.createdAt), desc(recordChanges.id))
      .limit(limit + 1);
    return {
      items: rows.slice(0, limit).map(recordChangeRow),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                createdAt: iso(rows[limit - 1]!.createdAt),
                id: rows[limit - 1]!.id,
              }),
            ).toString('base64url')
          : null,
    };
  }

  async diffRunRecords(
    taskId: string,
    fromRunId: string,
    toRunId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<DatasetDiffPage> {
    const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
    type DiffRow = {
      record_key: string;
      change_type: 'added' | 'updated' | 'removed';
      before_data: Record<string, unknown> | null;
      after_data: Record<string, unknown> | null;
      added_count: string | number;
      updated_count: string | number;
      removed_count: string | number;
    };
    const rows = await sql<DiffRow[]>`
      WITH before_records AS (
        SELECT DISTINCT ON (COALESCE(record_key, md5(data::text)))
          COALESCE(record_key, md5(data::text)) AS record_key,
          data,
          COALESCE(content_hash, md5(data::text)) AS content_hash
        FROM records
        WHERE task_id = ${taskId} AND run_id = ${fromRunId}
        ORDER BY COALESCE(record_key, md5(data::text)), created_at DESC, id DESC
      ), after_records AS (
        SELECT DISTINCT ON (COALESCE(record_key, md5(data::text)))
          COALESCE(record_key, md5(data::text)) AS record_key,
          data,
          COALESCE(content_hash, md5(data::text)) AS content_hash
        FROM records
        WHERE task_id = ${taskId} AND run_id = ${toRunId}
        ORDER BY COALESCE(record_key, md5(data::text)), created_at DESC, id DESC
      ), diff AS (
        SELECT
          COALESCE(before_records.record_key, after_records.record_key) AS record_key,
          CASE
            WHEN before_records.record_key IS NULL THEN 'added'
            WHEN after_records.record_key IS NULL THEN 'removed'
            ELSE 'updated'
          END AS change_type,
          before_records.data AS before_data,
          after_records.data AS after_data
        FROM before_records
        FULL OUTER JOIN after_records USING (record_key)
        WHERE before_records.record_key IS NULL
          OR after_records.record_key IS NULL
          OR before_records.content_hash <> after_records.content_hash
      ), counts AS (
        SELECT
          COUNT(*) FILTER (WHERE change_type = 'added') AS added_count,
          COUNT(*) FILTER (WHERE change_type = 'updated') AS updated_count,
          COUNT(*) FILTER (WHERE change_type = 'removed') AS removed_count
        FROM diff
      )
      SELECT diff.*, counts.*
      FROM diff CROSS JOIN counts
      WHERE diff.record_key > ${after}
      ORDER BY diff.record_key
      LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        recordKey: row.record_key,
        type: row.change_type,
        before: row.before_data,
        after: row.after_data,
      })),
      nextCursor:
        rows.length > limit
          ? Buffer.from(page.at(-1)!.record_key, 'utf8').toString('base64url')
          : null,
      stats: {
        added: Number(rows[0]?.added_count ?? 0),
        updated: Number(rows[0]?.updated_count ?? 0),
        removed: Number(rows[0]?.removed_count ?? 0),
      },
    };
  }

  async appendRunLog(
    entry: Omit<RunLogEntry, 'id' | 'sequence' | 'createdAt'>,
  ): Promise<RunLogEntry> {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({ value: max(runLogs.sequence) })
        .from(runLogs)
        .where(eq(runLogs.runId, entry.runId));
      const [created] = await tx
        .insert(runLogs)
        .values({ ...entry, sequence: (current?.value ?? 0) + 1 })
        .returning();
      if (!created) throw new Error('Run log could not be created');
      const progress = entry.metadata.progress;
      await tx
        .update(crawlRuns)
        .set({
          phase: entry.phase,
          ...(typeof progress === 'number' ? { progress } : {}),
          ...(entry.level === 'warn' ? { warningCount: dsql`${crawlRuns.warningCount} + 1` } : {}),
        })
        .where(eq(crawlRuns.id, entry.runId));
      return runLogRow(created);
    });
  }

  async listRunLogs(runId: string, cursor: string | undefined, limit: number): Promise<RunLogPage> {
    const sequence = cursor ? Number.parseInt(cursor, 10) : 0;
    const rows = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), gt(runLogs.sequence, sequence)))
      .orderBy(asc(runLogs.sequence))
      .limit(limit + 1);
    return {
      items: rows.slice(0, limit).map(runLogRow),
      nextCursor: rows.length > limit ? String(rows[limit - 1]!.sequence) : null,
    };
  }

  async appendRunRequest(
    entry: Omit<RunRequestEntry, 'id' | 'createdAt'>,
  ): Promise<RunRequestEntry> {
    const [created] = await db.insert(runRequests).values(entry).returning();
    if (!created) throw new Error('Run request could not be created');
    return runRequestRow(created);
  }

  async listRunRequests(
    runId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<RunRequestPage> {
    const offset = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10) : 0;
    const rows = await db
      .select()
      .from(runRequests)
      .where(eq(runRequests.runId, runId))
      .orderBy(asc(runRequests.createdAt), asc(runRequests.id))
      .limit(limit + 1)
      .offset(Number.isFinite(offset) ? offset : 0);
    return {
      items: rows.slice(0, limit).map(runRequestRow),
      nextCursor:
        rows.length > limit ? Buffer.from(String(offset + limit)).toString('base64url') : null,
    };
  }

  async createOutputDestination(
    input: Pick<OutputDestination, 'name' | 'type' | 'config' | 'credentialRef' | 'enabled'>,
  ): Promise<OutputDestination> {
    const [created] = await db.insert(outputDestinations).values(input).returning();
    if (!created) throw new Error('Output destination could not be created');
    return outputDestinationRow(created);
  }

  async listOutputDestinations(): Promise<OutputDestination[]> {
    return (
      await db.select().from(outputDestinations).orderBy(desc(outputDestinations.createdAt))
    ).map(outputDestinationRow);
  }

  async getOutputDestination(id: string): Promise<OutputDestination | null> {
    const row = (
      await db.select().from(outputDestinations).where(eq(outputDestinations.id, id)).limit(1)
    )[0];
    return row ? outputDestinationRow(row) : null;
  }

  async updateOutputDestination(
    id: string,
    input: Partial<Pick<OutputDestination, 'name' | 'config' | 'credentialRef' | 'enabled'>>,
  ): Promise<OutputDestination | null> {
    const [updated] = await db
      .update(outputDestinations)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(outputDestinations.id, id))
      .returning();
    return updated ? outputDestinationRow(updated) : null;
  }

  async deleteOutputDestination(id: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const deleted = await tx
        .delete(outputDestinations)
        .where(eq(outputDestinations.id, id))
        .returning({ id: outputDestinations.id });
      if (deleted.length === 0) return false;
      await tx
        .update(tasks)
        .set({
          outputBindings: dsql`${tasks.outputBindings} - ${id}`,
          revision: dsql`${tasks.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(dsql`${tasks.outputBindings} ? ${id}`);
      return true;
    });
  }

  async createDeliveryAttempt(
    input: Pick<DeliveryAttempt, 'destinationId' | 'taskId' | 'runId'>,
  ): Promise<DeliveryAttempt> {
    const [created] = await db.insert(deliveryAttempts).values(input).returning();
    if (!created) throw new Error('Delivery attempt could not be created');
    return deliveryAttemptRow(created);
  }

  async updateDeliveryAttempt(
    id: string,
    input: Partial<
      Pick<DeliveryAttempt, 'status' | 'attempt' | 'responseStatus' | 'error' | 'nextAttemptAt'>
    >,
  ): Promise<DeliveryAttempt | null> {
    const [updated] = await db
      .update(deliveryAttempts)
      .set({
        ...input,
        nextAttemptAt:
          input.nextAttemptAt === undefined
            ? undefined
            : input.nextAttemptAt
              ? new Date(input.nextAttemptAt)
              : null,
        updatedAt: new Date(),
      })
      .where(eq(deliveryAttempts.id, id))
      .returning();
    return updated ? deliveryAttemptRow(updated) : null;
  }

  async listDeliveryAttempts(runId?: string): Promise<DeliveryAttempt[]> {
    const rows = runId
      ? await db
          .select()
          .from(deliveryAttempts)
          .where(eq(deliveryAttempts.runId, runId))
          .orderBy(desc(deliveryAttempts.createdAt))
      : await db.select().from(deliveryAttempts).orderBy(desc(deliveryAttempts.createdAt));
    return rows.map(deliveryAttemptRow);
  }

  async createApiToken(
    input: Pick<ApiToken, 'name' | 'taskIds' | 'rateLimitPerMinute' | 'expiresAt'> & {
      tokenHash: string;
    },
  ): Promise<ApiToken> {
    const [created] = await db
      .insert(apiTokens)
      .values({
        ...input,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returning();
    if (!created) throw new Error('API token could not be created');
    return apiTokenRow(created);
  }

  async listApiTokens(): Promise<ApiToken[]> {
    return (await db.select().from(apiTokens).orderBy(desc(apiTokens.createdAt))).map(apiTokenRow);
  }

  async findApiToken(tokenHash: string): Promise<ApiToken | null> {
    const row = (
      await db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.tokenHash, tokenHash), dsql`${apiTokens.revokedAt} IS NULL`))
        .limit(1)
    )[0];
    return row ? apiTokenRow(row) : null;
  }

  async revokeApiToken(id: string): Promise<boolean> {
    return (
      (
        await db
          .update(apiTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(apiTokens.id, id), dsql`${apiTokens.revokedAt} IS NULL`))
          .returning({ id: apiTokens.id })
      ).length > 0
    );
  }

  async createRuleRepairProposal(
    input: Pick<RuleRepairProposal, 'taskId' | 'ruleId' | 'runId' | 'definition' | 'explanation'>,
  ): Promise<RuleRepairProposal> {
    const [created] = await db.insert(ruleRepairProposals).values(input).returning();
    if (!created) throw new Error('Rule repair proposal could not be created');
    return repairProposalRow(created);
  }

  async listRuleRepairProposals(ruleId: string): Promise<RuleRepairProposal[]> {
    return (
      await db
        .select()
        .from(ruleRepairProposals)
        .where(eq(ruleRepairProposals.ruleId, ruleId))
        .orderBy(desc(ruleRepairProposals.createdAt))
    ).map(repairProposalRow);
  }

  async updateRuleRepairProposal(
    id: string,
    status: RuleRepairProposal['status'],
  ): Promise<RuleRepairProposal | null> {
    const [updated] = await db
      .update(ruleRepairProposals)
      .set({ status })
      .where(eq(ruleRepairProposals.id, id))
      .returning();
    return updated ? repairProposalRow(updated) : null;
  }

  async markRuleRepairProposalTested(id: string): Promise<RuleRepairProposal | null> {
    const [updated] = await db
      .update(ruleRepairProposals)
      .set({ testedAt: new Date() })
      .where(and(eq(ruleRepairProposals.id, id), eq(ruleRepairProposals.status, 'pending')))
      .returning();
    return updated ? repairProposalRow(updated) : null;
  }

  async appendEvent(event: Omit<DomainEvent, 'id' | 'cursor' | 'createdAt'>): Promise<DomainEvent> {
    const [created] = await db.insert(domainEvents).values(event).returning();
    if (!created) throw new Error('Domain event insert did not return a row');
    return eventRow(created);
  }

  async listEvents(after: number, limit: number): Promise<DomainEventPage> {
    const rows = await db
      .select()
      .from(domainEvents)
      .where(gt(domainEvents.cursor, after))
      .orderBy(asc(domainEvents.cursor))
      .limit(limit);
    const items = rows.map(eventRow);
    return { items, nextCursor: items.at(-1)?.cursor ?? after };
  }

  async getIdempotency(scope: string, key: string) {
    return (
      (
        await db
          .select({ fingerprint: idempotencyKeys.fingerprint, response: idempotencyKeys.response })
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
          .limit(1)
      )[0] ?? null
    );
  }

  async putIdempotency(
    scope: string,
    key: string,
    fingerprint: string,
    response: unknown,
  ): Promise<void> {
    await db.insert(idempotencyKeys).values({ scope, key, fingerprint, response });
  }

  async putArtifact(
    descriptor: Omit<ArtifactDescriptor, 'id' | 'createdAt'> & { storageKey: string },
  ): Promise<ArtifactDescriptor> {
    const [created] = await db.insert(artifacts).values(descriptor).returning();
    if (!created) throw new Error('Artifact insert did not return a row');
    const artifact = artifactRow(created);
    return {
      id: artifact.id,
      runId: artifact.runId,
      format: artifact.format,
      filename: artifact.filename,
      contentType: artifact.contentType,
      size: artifact.size,
      createdAt: artifact.createdAt,
    };
  }

  async getArtifact(id: string): Promise<(ArtifactDescriptor & { storageKey: string }) | null> {
    const row = (await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1))[0];
    return row ? artifactRow(row) : null;
  }

  async enqueueRuntimeJob(job: RuntimeJob): Promise<void> {
    await db.insert(runtimeJobs).values({
      id: job.id,
      taskId: job.taskId,
      runId: job.runId,
      state: 'queued',
    });
  }

  async claimRuntimeJob(): Promise<RuntimeJob | null> {
    return db.transaction(async (tx) => {
      const row = (
        await tx
          .select()
          .from(runtimeJobs)
          .where(eq(runtimeJobs.state, 'queued'))
          .orderBy(asc(runtimeJobs.createdAt))
          .limit(1)
      )[0];
      if (!row) return null;
      await tx
        .update(runtimeJobs)
        .set({ state: 'running', updatedAt: new Date() })
        .where(and(eq(runtimeJobs.id, row.id), eq(runtimeJobs.state, 'queued')));
      return {
        id: row.id,
        taskId: row.taskId,
        ...(row.runId ? { runId: row.runId } : {}),
      };
    });
  }

  async finishRuntimeJob(id: string): Promise<void> {
    await db.delete(runtimeJobs).where(eq(runtimeJobs.id, id));
  }

  async cancelRuntimeJob(runId: string): Promise<boolean> {
    const deleted = await db
      .delete(runtimeJobs)
      .where(and(eq(runtimeJobs.runId, runId), eq(runtimeJobs.state, 'queued')))
      .returning({ id: runtimeJobs.id });
    return deleted.length > 0;
  }
}
