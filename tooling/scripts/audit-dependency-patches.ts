import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

interface Provenance {
  name: string;
  version: string;
  advisories: string[];
}
interface Advisory {
  severity: string;
  title: string;
  url: string;
}
const root = resolve(import.meta.dirname, '../..');
const names = ['braces', 'http-cache-semantics'];
const provenance: Provenance[] = [];
for (const name of names) {
  const manifest = JSON.parse(
    await readFile(resolve(root, 'tooling/dependency-patches', name, 'package.json'), 'utf8'),
  ) as { zhiyunUpstream: Provenance };
  if (manifest.zhiyunUpstream.name !== name)
    throw new Error('Dependency patch provenance mismatch');
  provenance.push(manifest.zhiyunUpstream);
}
const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(Object.fromEntries(provenance.map((item) => [item.name, [item.version]]))),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Upstream patch audit unavailable: HTTP ${response.status}`);
const advisories = (await response.json()) as Record<string, Advisory[]>;
for (const item of provenance) {
  for (const advisory of advisories[item.name] ?? []) {
    if (!['high', 'critical'].includes(advisory.severity)) continue;
    const id = new URL(advisory.url).pathname.split('/').at(-1);
    if (!id || !item.advisories.includes(id))
      throw new Error(`Unverified upstream ${advisory.severity} advisory: ${advisory.url}`);
    console.log(
      `Upstream advisory retained: ${item.name}@${item.version} ${id}; checking local fix`,
    );
  }
}
const child = spawnSync(
  'vitest',
  [
    'run',
    '--config',
    'vitest.platform.config.ts',
    'platform/tooling/tests/dependency-patches.test.ts',
  ],
  { cwd: root, stdio: 'ignore' },
);
if (child.status !== 0) throw new Error('Local dependency security regression failed');
for (const file of [
  'braces/index.js',
  'braces/lib/parse.js',
  'braces/lib/validate-tree.js',
  'http-cache-semantics/index.js',
]) {
  const syntax = spawnSync('node', ['--check', resolve(root, 'tooling/dependency-patches', file)], {
    stdio: 'inherit',
  });
  if (syntax.status !== 0) throw new Error(`Invalid dependency patch JavaScript: ${file}`);
}
console.log('Local dependency patches verified; upstream advisories remain documented');
