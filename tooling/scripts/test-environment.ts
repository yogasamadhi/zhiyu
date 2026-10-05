import { createServer } from 'node:net';

// Copy only OS/runtime settings. Provider, signing and message credentials from
// the caller are deliberately absent, including arbitrarily named model keys.
export function testEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TERM',
    'CI',
    'FORCE_COLOR',
  ]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return {
    ...environment,
    NODE_ENV: 'test',
    CLOUD_MOCK_PAYMENTS: 'true',
    CLOUD_REAL_MESSAGES: 'false',
    CLOUD_MODEL_ORIGINS: '',
    CLOUD_MFA_KEY: 'development-isolated-test-mfa-key-32',
    AI_BASE_URL: '',
    AI_MODEL: '',
    AI_API_KEY: '',
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

export function assertTestDatabase(value: string, kind: 'unit' | 'e2e' = 'unit'): URL {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error('Test database must be a local PostgreSQL *_test database');
  }
  const suffix = kind === 'e2e' ? '_e2e_test' : '_test';
  if (
    !['postgres:', 'postgresql:'].includes(uri.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname) ||
    !/^\/[a-z][a-z0-9_]*_test$/.test(uri.pathname) ||
    !uri.pathname.endsWith(suffix) ||
    uri.search ||
    uri.hash
  )
    throw new Error(`Test database must be a local PostgreSQL *${suffix} database`);
  return uri;
}

export async function availableTestPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test port available');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
