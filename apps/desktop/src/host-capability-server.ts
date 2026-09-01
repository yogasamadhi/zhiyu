import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dialog, Notification, safeStorage, shell } from 'electron';

interface HostServerOptions {
  dataDirectory: string;
  token: string;
  promptCredential(kind: string): Promise<string | null>;
  loginCredential(url: string): Promise<unknown | null>;
  windowStatus(): Record<string, unknown>;
  diagnostics(): Record<string, unknown>;
  restartRuntime(): void;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage, maxBytes = 100 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > maxBytes) throw new Error('Host request body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function parsePromptCredential(kind: string, source: string): unknown {
  if (kind === 'ai-api-key') {
    if (!source.trim()) throw new Error('API Key 不能为空');
    if (source.length > 16_384) throw new Error('API Key 太长');
    return source.trim();
  }
  if (kind === 'output-webhook') {
    if (!source.trim()) throw new Error('Webhook Secret 不能为空');
    return { secret: source };
  }
  if (kind === 'output-postgres') {
    if (!source.startsWith('postgres://') && !source.startsWith('postgresql://')) {
      throw new Error('必须输入 PostgreSQL connection string');
    }
    return { connectionString: source };
  }
  if (kind === 'output-google-sheets') {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Google 服务账号必须是 JSON 对象');
    }
    const serviceAccount = value as Record<string, unknown>;
    if (
      typeof serviceAccount.client_email !== 'string' ||
      !serviceAccount.client_email.includes('@') ||
      typeof serviceAccount.private_key !== 'string' ||
      !serviceAccount.private_key.includes('BEGIN PRIVATE KEY')
    ) {
      throw new Error('Google 服务账号 JSON 缺少 client_email 或 private_key');
    }
    return value;
  }
  if (kind === 'output-s3') {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('S3 凭据必须是 JSON 对象');
    }
    const credential = value as Record<string, unknown>;
    if (
      typeof credential.accessKeyId !== 'string' ||
      !credential.accessKeyId ||
      typeof credential.secretAccessKey !== 'string' ||
      !credential.secretAccessKey
    ) {
      throw new Error('S3 凭据缺少 accessKeyId 或 secretAccessKey');
    }
    return value;
  }
  const value = JSON.parse(source) as unknown;
  if (kind === 'task-secret-headers') {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.entries(value).some(([name, item]) => !name.trim() || typeof item !== 'string')
    ) {
      throw new Error('Headers 必须是字符串键值 JSON 对象');
    }
    return value;
  }
  if (kind === 'task-cookies') {
    if (
      !Array.isArray(value) ||
      value.some(
        (item) =>
          !item ||
          typeof item !== 'object' ||
          typeof (item as Record<string, unknown>).name !== 'string' ||
          typeof (item as Record<string, unknown>).value !== 'string',
      )
    ) {
      throw new Error('Cookies 必须是包含 name/value 的 JSON 数组');
    }
    return value;
  }
  if (kind === 'task-proxy') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Proxy 必须是 JSON 对象');
    }
    const url = String((value as Record<string, unknown>).url ?? '');
    if (!['http:', 'https:', 'socks5:'].includes(new URL(url).protocol)) {
      throw new Error('Proxy URL 必须使用 http、https 或 socks5');
    }
    return value;
  }
  throw new Error('Unsupported credential kind');
}

export class HostCapabilityServer {
  private server: Server | undefined;
  readonly baseUrlPromise: Promise<string>;
  private resolveBaseUrl!: (value: string) => void;

  constructor(private readonly options: HostServerOptions) {
    this.baseUrlPromise = new Promise((resolve) => {
      this.resolveBaseUrl = resolve;
    });
  }

  async start(): Promise<string> {
    if (this.server) return this.baseUrlPromise;
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    this.resolveBaseUrl(baseUrl);
    return baseUrl;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) => (error ? reject(error) : resolve())),
    );
    this.server = undefined;
  }

  private authorized(request: IncomingMessage): boolean {
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const expected = Buffer.from(this.options.token);
    const actual = Buffer.from(supplied);
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.authorized(request)) return json(response, 401, { error: 'unauthorized' });
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const payload =
        request.method === 'POST' ? ((await body(request)) as Record<string, unknown>) : {};
      if (path.startsWith('/credentials/') && !safeStorage.isEncryptionAvailable()) {
        return json(response, 503, { error: 'safeStorage is unavailable' });
      }
      if (path === '/credentials/put') {
        const reference = await this.putCredential(String(payload.kind), payload.value);
        return json(response, 200, { reference });
      }
      if (path === '/credentials/resolve') {
        return json(response, 200, {
          value: await this.resolveCredential(String(payload.reference)),
        });
      }
      if (path === '/credentials/delete') {
        await this.deleteCredential(String(payload.reference));
        return json(response, 200, { deleted: true });
      }
      if (path === '/credentials/prompt') {
        const kind = String(payload.kind);
        const value = await this.options.promptCredential(kind);
        if (value === null) return json(response, 200, { canceled: true });
        return json(response, 200, {
          reference: await this.putCredential(kind, parsePromptCredential(kind, value)),
        });
      }
      if (path === '/credentials/login') {
        const value = await this.options.loginCredential(String(payload.url));
        if (value === null) return json(response, 200, { canceled: true });
        return json(response, 200, {
          reference: await this.putCredential('browser-storage-state', value),
        });
      }
      if (path === '/outputs/select-directory') {
        if (!safeStorage.isEncryptionAvailable()) {
          return json(response, 503, { error: 'safeStorage is unavailable' });
        }
        const result = await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
        });
        const directoryPath = result.filePaths[0];
        if (result.canceled || !directoryPath) return json(response, 200, { canceled: true });
        return json(response, 200, {
          reference: await this.putCredential('output-local-directory', { directoryPath }),
        });
      }
      if (path === '/artifacts/save') {
        const artifact = payload.artifact as { filename: string };
        const result = await dialog.showSaveDialog({ defaultPath: basename(artifact.filename) });
        if (result.canceled || !result.filePath) return json(response, 200, { saved: false });
        if (payload.storageKey) {
          const storageKey = String(payload.storageKey);
          if (basename(storageKey) !== storageKey) throw new Error('Invalid artifact storage key');
          await copyFile(
            join(this.options.dataDirectory, 'artifacts', storageKey),
            result.filePath,
          );
        } else {
          await writeFile(result.filePath, Buffer.from(String(payload.data), 'base64'));
        }
        return json(response, 200, { saved: true });
      }
      if (path === '/database/select-restore') {
        const result = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'SQLite backup', extensions: ['sqlite3', 'sqlite', 'db'] }],
        });
        const filePath = result.filePaths[0];
        if (result.canceled || !filePath) return json(response, 200, { canceled: true });
        if ((await stat(filePath)).size > 1024 * 1024 * 1024) {
          return json(response, 413, { error: 'Backup exceeds 1 GB' });
        }
        return json(response, 200, { data: (await readFile(filePath)).toString('base64') });
      }
      if (path === '/runtime/restart') {
        setTimeout(() => this.options.restartRuntime(), 500);
        return json(response, 200, { restarting: true });
      }
      if (path === '/external/open') {
        const target = new URL(String(payload.url));
        if (!['http:', 'https:'].includes(target.protocol))
          return json(response, 403, { error: 'URL scheme is forbidden' });
        await shell.openExternal(target.href);
        return json(response, 200, { opened: true });
      }
      if (path === '/notifications/show') {
        if (Notification.isSupported()) {
          new Notification({ title: String(payload.title), body: String(payload.body) }).show();
        }
        return json(response, 200, { shown: Notification.isSupported() });
      }
      if (path === '/window/status') return json(response, 200, this.options.windowStatus());
      if (path === '/runtime/diagnostics') return json(response, 200, this.options.diagnostics());
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async putCredential(kind: string, value: unknown): Promise<string> {
    const directory = join(this.options.dataDirectory, 'credentials');
    await mkdir(directory, { recursive: true });
    const reference = `${kind.replace(/[^a-z0-9-]/gi, '-')}-${crypto.randomUUID()}.secret`;
    const encrypted = safeStorage.encryptString(JSON.stringify(value));
    await writeFile(join(directory, reference), encrypted, { mode: 0o600 });
    return reference;
  }

  private async resolveCredential(reference: string): Promise<unknown> {
    if (basename(reference) !== reference) throw new Error('Invalid credential reference');
    const encrypted = await readFile(join(this.options.dataDirectory, 'credentials', reference));
    return JSON.parse(safeStorage.decryptString(encrypted)) as unknown;
  }

  private async deleteCredential(reference: string): Promise<void> {
    if (basename(reference) !== reference) throw new Error('Invalid credential reference');
    await unlink(join(this.options.dataDirectory, 'credentials', reference)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
  }
}
