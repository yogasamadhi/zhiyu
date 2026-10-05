import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { safeStorage, shell } from 'electron';
interface Tokens {
  deviceId?: string;
  access: string;
  refresh: string;
  expiresAt: string;
  csrf: string;
}
interface Selection {
  mode: 'byok' | 'hosted';
  model: string;
  deviceId: string;
}
export class CloudAccount {
  private tokens: Tokens | null = null;
  private selection: Selection = { mode: 'byok', model: '', deviceId: crypto.randomUUID() };
  private refreshTask: Promise<Tokens> | undefined;
  private loginTask: Promise<void> | undefined;
  private cache: unknown = null;
  readonly api: string;
  readonly portal: string;
  constructor(
    private directory: string,
    private changed: (mode: 'byok' | 'hosted', model: string) => void,
  ) {
    this.api = process.env.ZHIYUN_CLOUD_API_URL ?? 'http://localhost:3200';
    this.portal = process.env.ZHIYUN_CLOUD_PORTAL_URL ?? 'http://localhost:3100';
    for (const value of [this.api, this.portal]) {
      const u = new URL(value);
      if (
        u.protocol !== 'https:' &&
        !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))
      )
        throw new Error('Cloud endpoints require HTTPS or local development loopback');
    }
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try {
      const value = JSON.parse(
        await readFile(join(this.directory, 'cloud-selection.json'), 'utf8'),
      ) as Selection;
      if (['byok', 'hosted'].includes(value.mode) && /^[0-9a-f-]{36}$/.test(value.deviceId))
        this.selection = value;
    } catch {
      /* first launch */
    }
    if (safeStorage.isEncryptionAvailable())
      try {
        this.tokens = JSON.parse(
          safeStorage.decryptString(await readFile(join(this.directory, 'cloud-session.enc'))),
        ) as Tokens;
      } catch {
        /* signed out */
      }
    this.changed(this.selection.mode, this.selection.model);
  }
  private async saveTokens(tokens: Tokens) {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new Error('系统密钥保管不可用，无法保存云端登录凭证');
    const path = join(this.directory, 'cloud-session.enc');
    await writeFile(`${path}.tmp`, safeStorage.encryptString(JSON.stringify(tokens)), {
      mode: 0o600,
    });
    await rename(`${path}.tmp`, path);
    this.tokens = tokens;
  }
  private async apiCall<T>(path: string, body?: unknown, authenticated = true): Promise<T> {
    const tokens = authenticated ? await this.credential() : null;
    const response = await fetch(`${this.api}/api/cloud/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(tokens ? { authorization: `Bearer ${tokens.access}` } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await response.json()) as { data: T; error?: { code: string } };
    if (!response.ok) throw new Error(data.error?.code ?? '云服务暂时不可用');
    return data.data;
  }
  private async credential(): Promise<Tokens> {
    if (!this.tokens) throw new Error('请先登录云账户，或手动切换为自带 Key');
    if (new Date(this.tokens.expiresAt).getTime() > Date.now() + 30000) return this.tokens;
    if (!this.refreshTask)
      this.refreshTask = (async () => {
        const t = await this.apiCall<Tokens>(
          '/desktop/refresh',
          { refreshToken: this.tokens!.refresh },
          false,
        );
        await this.saveTokens(t);
        return t;
      })().finally(() => {
        this.refreshTask = undefined;
      });
    return this.refreshTask;
  }
  login() {
    if (!this.loginTask)
      this.loginTask = this.performLogin().finally(() => {
        this.loginTask = undefined;
      });
    return this.loginTask;
  }
  private async performLogin() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证存储不可用');
    const verifier = randomBytes(32).toString('base64url'),
      state = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (
        req.method !== 'GET' ||
        url.pathname !== '/callback' ||
        url.searchParams.get('state') !== state ||
        !url.searchParams.get('code')
      ) {
        res.writeHead(400);
        res.end('Invalid authorization');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end('织云授权已完成。可以关闭此页面并返回桌面端。');
      resolveCode(url.searchParams.get('code')!);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    const timeout = setTimeout(() => rejectCode(new Error('登录授权超时，请重试')), 180000);
    try {
      const uri = new URL('/desktop/authorize', this.portal);
      for (const [k, v] of Object.entries({
        code_challenge: challenge,
        state,
        redirect_uri: redirectUri,
        device_id: this.selection.deviceId,
        device_name: hostname(),
      }))
        uri.searchParams.set(k, v);
      await shell.openExternal(uri.toString());
      const code = await result;
      const tokens = await this.apiCall<Tokens>(
        '/desktop/exchange',
        { code, verifier, redirectUri },
        false,
      );
      if (tokens.deviceId) this.selection = { ...this.selection, deviceId: tokens.deviceId };
      await this.saveTokens(tokens);
      await this.select(this.selection.mode, this.selection.model);
    } finally {
      clearTimeout(timeout);
      server.close();
    }
  }
  async summary() {
    if (!this.tokens)
      return { ...this.selection, signedIn: false, account: null, models: [], offline: false };
    try {
      const account = await this.apiCall<unknown>('/me'),
        models = await this.apiCall<unknown[]>('/ai/models');
      this.cache = account;
      return { ...this.selection, signedIn: true, account, models, offline: false };
    } catch (error) {
      return {
        ...this.selection,
        signedIn: true,
        account: this.cache,
        models: [],
        offline: true,
        error: error instanceof Error ? error.message : '云服务不可用',
      };
    }
  }
  state() {
    return { ...this.selection };
  }
  async select(mode: 'byok' | 'hosted', model: string) {
    if (!['byok', 'hosted'].includes(mode)) throw new Error('Unknown AI mode');
    if (mode === 'hosted' && !/^[0-9a-f-]{36}$/.test(model)) throw new Error('请选择可用托管模型');
    this.selection = { ...this.selection, mode, model };
    await writeFile(join(this.directory, 'cloud-selection.json'), JSON.stringify(this.selection), {
      mode: 0o600,
    });
    this.changed(mode, model);
    return this.summary();
  }
  async logout() {
    if (this.tokens) await this.apiCall('/auth/logout', {}).catch(() => undefined);
    this.tokens = null;
    this.cache = null;
    await unlink(join(this.directory, 'cloud-session.enc')).catch(() => undefined);
    // Preserve explicit mode. Hosted fails until login or an explicit BYOK switch.
    return this.summary();
  }
  async openPortal() {
    await shell.openExternal(new URL('/account', this.portal).toString());
  }
  async proxy(
    payload: unknown,
    requestId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<Response> {
    if (this.selection.mode !== 'hosted') throw new Error('AI 模式已改变，请重新提交');
    const tokens = await this.credential();
    return fetch(`${this.api}/api/cloud/v1/ai/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access}`,
        'content-type': 'application/json',
        'x-request-id': requestId,
        'x-assistant-turn': turnId,
      },
      body: JSON.stringify({
        ...(payload as Record<string, unknown>),
        model: this.selection.model,
      }),
      signal,
    });
  }
}
