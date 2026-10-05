import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string | { type?: string };
  licenses?: Array<string | { type?: string }>;
  zhiyunUpstream?: { name: string; version: string };
}

interface LicenseFile {
  filename: string;
  sha256: string;
  text: string;
}

interface PackageLicense {
  name: string;
  version: string;
  declaredLicenses: string[];
  licenseFiles: LicenseFile[];
  upstream?: { name: string; version: string };
}

const workspaceRoot = resolve(import.meta.dir, '../..');
const outputPath = resolve(
  process.argv[2] ?? resolve(workspaceRoot, '.artifacts/compliance/node.json'),
);
const visitedDirectories = new Set<string>();
const packages = new Map<string, PackageLicense>();
const lockedPackages = new Set<string>();
const lockResult = ts.parseConfigFileTextToJson(
  'bun.lock',
  await readFile(resolve(workspaceRoot, 'bun.lock'), 'utf8'),
);
if (lockResult.error) throw new Error('Cannot collect licenses from an invalid bun.lock');
const lock = lockResult.config as { packages: Record<string, [string, ...unknown[]]> };
for (const [identifier] of Object.values(lock.packages)) {
  const separator = identifier.lastIndexOf('@');
  const name = identifier.slice(0, separator);
  const version = identifier.slice(separator + 1);
  if (version.startsWith('file:')) {
    const source = resolve(workspaceRoot, version.slice(5));
    const location = relative(workspaceRoot, source);
    if (isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`))
      throw new Error('Local dependency escapes workspace');
    const manifest = await readJson<PackageManifest>(resolve(source, 'package.json'));
    if (manifest?.name && manifest.version)
      lockedPackages.add(`${manifest.name}@${manifest.version}`);
  } else lockedPackages.add(`${name}@${version}`);
}

await scanNodeModules(resolve(workspaceRoot, 'node_modules'));
await scanBunStore(resolve(workspaceRoot, 'node_modules/.bun'));
const entries = [...packages.values()].sort(
  (left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      formatVersion: 1,
      generatedFor: 'ZhiYun 1.0.0',
      ecosystem: 'npm',
      packageCount: entries.length,
      packages: entries,
    },
    null,
    2,
  )}\n`,
);
console.log(`Collected ${entries.length} Node package license records in ${outputPath}`);

async function scanNodeModules(nodeModulesPath: string): Promise<void> {
  const entries = await readdir(nodeModulesPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    const path = resolve(nodeModulesPath, entry.name);
    if (entry.name.startsWith('@')) {
      const scopedEntries = await readdir(path, { withFileTypes: true }).catch(() => []);
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.name.startsWith('.')) await visitPackage(resolve(path, scopedEntry.name));
      }
    } else {
      await visitPackage(path);
    }
  }
}

async function scanBunStore(storePath: string): Promise<void> {
  const entries = await readdir(storePath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) await scanNodeModules(resolve(storePath, entry.name, 'node_modules'));
  }
}

async function visitPackage(packagePath: string): Promise<void> {
  const canonicalPath = await realpath(packagePath).catch(() => packagePath);
  if (visitedDirectories.has(canonicalPath)) return;
  visitedDirectories.add(canonicalPath);
  const manifest = await readJson<PackageManifest>(resolve(packagePath, 'package.json'));
  if (!manifest) return;
  if (
    (!manifest.private || manifest.zhiyunUpstream) &&
    manifest.name &&
    manifest.version &&
    !manifest.name.startsWith('@zhiyun/') &&
    lockedPackages.has(`${manifest.name}@${manifest.version}`)
  ) {
    const key = `${manifest.name}@${manifest.version}`;
    if (!packages.has(key)) {
      packages.set(key, {
        name: manifest.name,
        version: manifest.version,
        declaredLicenses: declaredLicenses(manifest),
        licenseFiles: await readLicenseFiles(packagePath),
        ...(manifest.zhiyunUpstream ? { upstream: manifest.zhiyunUpstream } : {}),
      });
    }
  }
  await scanNodeModules(resolve(packagePath, 'node_modules'));
}

async function readLicenseFiles(packagePath: string): Promise<LicenseFile[]> {
  const entries = await readdir(packagePath, { withFileTypes: true }).catch(() => []);
  const files: LicenseFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(entry.name)) continue;
    const path = resolve(packagePath, entry.name);
    if ((await stat(path)).size > 2 * 1024 * 1024) continue;
    const text = await readFile(path, 'utf8').catch(() => '');
    if (!text) continue;
    files.push({
      filename: basename(path),
      sha256: createHash('sha256').update(text).digest('hex'),
      text,
    });
  }
  return files;
}

function declaredLicenses(manifest: PackageManifest): string[] {
  const values = [manifest.license, ...(manifest.licenses ?? [])]
    .map((value) => (typeof value === 'string' ? value : value?.type))
    .filter((value): value is string => Boolean(value));
  return [...new Set(values)].sort();
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
