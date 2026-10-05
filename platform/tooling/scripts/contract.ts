import { format, resolveConfig } from 'prettier';
import { writeFile, readFile } from 'node:fs/promises';
import openapiTS, { astToString } from 'openapi-typescript';
import { createApp } from '../../server/src/app.js';
import { readConfig } from '../../server/src/config.js';
const cloud = createApp({ config: readConfig({ NODE_ENV: 'test' }) });
try {
  const doc = cloud.app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: '织云商业平台 API', version: '1.0.0' },
  });
  const outputs: [string, string][] = [
    ['platform/packages/cloud-contracts/openapi.json', JSON.stringify(doc, null, 2) + '\n'],
    [
      'platform/packages/cloud-client/src/generated.ts',
      astToString(await openapiTS(JSON.stringify(doc))),
    ],
  ];
  for (const [file, source] of outputs) {
    const content = await format(source, {
      ...(await resolveConfig(file)),
      parser: file.endsWith('.json') ? 'json' : 'typescript',
    });
    if (process.argv.includes('--check')) {
      if ((await readFile(file, 'utf8')) !== content) throw new Error(`Contract drift: ${file}`);
    } else await writeFile(file, content);
  }
  console.info('Cloud OpenAPI and client contract verified');
} finally {
  await cloud.close();
}
