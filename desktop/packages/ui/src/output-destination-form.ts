import type { OutputDestination, WebhookEventType } from '@zhiyun/contracts';

export type OutputDestinationType = OutputDestination['type'];
export type FileOutputFormat = 'csv' | 'jsonl' | 'parquet';

export interface OutputDestinationDraft {
  name: string;
  type: OutputDestinationType;
  target: string;
  secret: string;
  webhookEvents: WebhookEventType[];
  format: FileOutputFormat;
  pathTemplate: string;
  updateLatest: boolean;
  spreadsheetId: string;
  sheetName: string;
  sheetMode: 'auto' | 'replace' | 'append';
  columns: string;
  serviceAccountJson: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string;
  forcePathStyle: boolean;
  serverSideEncryption: '' | 'AES256' | 'aws:kms';
  kmsKeyId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export const defaultOutputDestinationDraft: OutputDestinationDraft = {
  name: 'Webhook',
  type: 'webhook',
  target: '',
  secret: '',
  webhookEvents: ['run.succeeded'],
  format: 'csv',
  pathTemplate: '{taskSlug}/{yyyy}/{mm}/{runId}.{ext}',
  updateLatest: true,
  spreadsheetId: '',
  sheetName: 'Records',
  sheetMode: 'auto',
  columns: '',
  serviceAccountJson: '',
  bucket: '',
  region: 'us-east-1',
  prefix: '',
  endpoint: '',
  forcePathStyle: false,
  serverSideEncryption: '',
  kmsKeyId: '',
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
};

export function buildOutputDestinationInput(draft: OutputDestinationDraft, desktop: boolean) {
  const base = { name: draft.name.trim(), type: draft.type, enabled: true };
  if (!base.name) throw new Error('请输入输出名称');
  switch (draft.type) {
    case 'webhook':
      if (!draft.target.trim()) throw new Error('请输入 Webhook URL');
      validateUrl(draft.target, 'Webhook URL');
      if (!draft.webhookEvents.length) throw new Error('至少选择一个 Webhook 事件');
      if (!desktop && !draft.secret) throw new Error('请输入 Webhook HMAC Secret');
      return {
        ...base,
        config: { url: draft.target.trim(), events: draft.webhookEvents },
        ...(!desktop ? { credential: { secret: draft.secret } } : {}),
      };
    case 'postgres':
      throw new Error('此输出类型已停用，请改用文件输出或 Webhook');
    case 'local-directory':
      if (!desktop) validateRelativeOutputPath(draft.target);
      validateOutputPathTemplate(draft.pathTemplate);
      if (!draft.pathTemplate.includes('{runId}')) {
        throw new Error('本地目录归档路径模板必须包含 {runId}');
      }
      return {
        ...base,
        config: {
          format: draft.format,
          pathTemplate: draft.pathTemplate,
          updateLatest: draft.updateLatest,
          ...(draft.target.trim() ? { basePath: draft.target.trim() } : {}),
        },
      };
    case 'google-sheets':
      if (!/^[A-Za-z0-9_-]{10,}$/.test(draft.spreadsheetId.trim())) {
        throw new Error('请输入有效的 Spreadsheet ID');
      }
      if (
        !draft.sheetName.trim() ||
        ['[', ']', '*', '?', ':', '/', '\\'].some((character) =>
          draft.sheetName.includes(character),
        )
      ) {
        throw new Error('请输入有效的工作表名称');
      }
      if (!desktop && !draft.serviceAccountJson.trim()) {
        throw new Error('请输入 Google 服务账号 JSON');
      }
      if (!desktop) validateServiceAccountJson(draft.serviceAccountJson);
      return {
        ...base,
        config: {
          spreadsheetId: draft.spreadsheetId.trim(),
          sheetName: draft.sheetName.trim() || 'Records',
          mode: draft.sheetMode,
          columns: splitList(draft.columns),
        },
        ...(!desktop
          ? { credential: { serviceAccountJson: draft.serviceAccountJson.trim() } }
          : {}),
      };
    case 's3':
      if (!draft.bucket.trim()) throw new Error('请输入 S3 Bucket');
      if (!draft.region.trim()) throw new Error('请输入 S3 Region');
      if (draft.endpoint.trim()) validateUrl(draft.endpoint, 'S3 兼容端点');
      validateRelativeOutputPath(draft.prefix);
      validateOutputPathTemplate(draft.pathTemplate);
      if (!draft.pathTemplate.includes('{runId}')) {
        throw new Error('S3 归档路径模板必须包含 {runId}');
      }
      if (!desktop && Boolean(draft.accessKeyId.trim()) !== Boolean(draft.secretAccessKey)) {
        throw new Error('S3 Access Key ID 和 Secret Access Key 必须同时填写');
      }
      if (draft.serverSideEncryption === 'aws:kms' && !draft.kmsKeyId.trim()) {
        throw new Error('使用 SSE-KMS 时必须填写 KMS Key ID');
      }
      return {
        ...base,
        config: {
          bucket: draft.bucket.trim(),
          region: draft.region.trim(),
          prefix: draft.prefix.trim(),
          pathTemplate: draft.pathTemplate,
          format: draft.format,
          updateLatest: draft.updateLatest,
          ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
          forcePathStyle: draft.forcePathStyle,
          ...(draft.serverSideEncryption
            ? { serverSideEncryption: draft.serverSideEncryption }
            : {}),
          ...(draft.kmsKeyId.trim() ? { kmsKeyId: draft.kmsKeyId.trim() } : {}),
        },
        ...(!desktop && draft.accessKeyId.trim()
          ? {
              credential: {
                accessKeyId: draft.accessKeyId.trim(),
                secretAccessKey: draft.secretAccessKey,
                ...(draft.sessionToken ? { sessionToken: draft.sessionToken } : {}),
              },
            }
          : {}),
      };
  }
}

export function outputDestinationSummary(destination: OutputDestination): string {
  switch (destination.type) {
    case 'webhook':
      return `${String(destination.config.url ?? '')} · ${(
        destination.config.events ??
        (destination.config.event ? [destination.config.event] : ['run.succeeded'])
      ).join(', ')}`;
    case 'postgres':
      return '此输出类型已停用，请改用文件输出或 Webhook';
    case 'local-directory':
      return `${destination.config.format} · ${destination.config.pathTemplate}`;
    case 'google-sheets':
      return `${destination.config.spreadsheetId} · ${destination.config.sheetName} · ${destination.config.mode}${destination.config.clientEmail ? ` · ${destination.config.clientEmail}` : ''}`;
    case 's3':
      return `s3://${destination.config.bucket}/${destination.config.prefix ?? ''} · ${destination.config.format}`;
  }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateServiceAccountJson(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Google 服务账号 JSON 格式无效');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Google 服务账号 JSON 必须是对象');
  }
  const credential = parsed as Record<string, unknown>;
  if (typeof credential.client_email !== 'string' || !credential.client_email.includes('@')) {
    throw new Error('Google 服务账号缺少 client_email');
  }
  if (
    typeof credential.private_key !== 'string' ||
    !credential.private_key.includes('BEGIN PRIVATE KEY')
  ) {
    throw new Error('Google 服务账号缺少 private_key');
  }
}

function validateRelativeOutputPath(value: string): void {
  const path = value.trim();
  if (!path) return;
  if (
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.split(/[\\/]+/).some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('输出子目录必须是 ZHIYUN_OUTPUT_ROOT 内的安全相对路径');
  }
}

function validateOutputPathTemplate(value: string): void {
  if (!value.trim()) throw new Error('请输入归档路径模板');
  validateRelativeOutputPath(value);
}

function validateUrl(value: string, label: string): void {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error(`${label} 必须是有效的 HTTP(S) 地址`);
  }
}
