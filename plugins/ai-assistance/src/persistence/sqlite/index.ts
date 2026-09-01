import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { AiConversationRepository } from '../../contracts/index.js';
import type {
  AiConversation,
  AiDraftVersion,
  AiMessage,
  AiProviderSettings,
  AiTaskDraft,
  AiToolInvocation,
  AiTurn,
} from '../../domain/index.js';
import { aiAssistanceSqliteMigration001 } from '../../migrations/sqlite/index.js';

type Row = Record<string, unknown>;
const migrationId = '001-conversations';

export class SqliteAiConversationRepository implements AiConversationRepository {
  private readonly sqlite: Database.Database;

  constructor(filePath: string) {
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  async migrate(): Promise<void> {
    const checksum = sha256(aiAssistanceSqliteMigration001);
    const existing = this.sqlite
      .prepare('SELECT checksum FROM plugin_migrations WHERE plugin_id=? AND migration_id=?')
      .get('ai-assistance', migrationId) as Row | undefined;
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(`Migration checksum mismatch for ai-assistance:${migrationId}`);
      }
      return;
    }
    const started = performance.now();
    this.sqlite.transaction(() => {
      this.sqlite.exec(aiAssistanceSqliteMigration001);
      this.sqlite
        .prepare(
          `INSERT INTO plugin_migrations(
            plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
          ) VALUES ('ai-assistance',?,'1.0.0',?,?,?,'succeeded')`,
        )
        .run(migrationId, checksum, now(), Math.max(0, Math.round(performance.now() - started)));
    })();
  }

  async close(): Promise<void> {
    if (this.sqlite.open) this.sqlite.close();
  }

  async createConversation(input: { id?: string; title?: string } = {}): Promise<AiConversation> {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    this.sqlite
      .prepare(
        `INSERT INTO ai_conversations(
          id,title,status,latest_draft_revision,created_at,updated_at
        ) VALUES (?,?,'active',0,?,?)`,
      )
      .run(id, input.title?.trim() || '新建 AI 爬虫', timestamp, timestamp);
    return conversationRow(this.requireRow('SELECT * FROM ai_conversations WHERE id=?', id));
  }

  async listConversations(cursor?: string, limit = 50) {
    const size = Math.min(Math.max(limit, 1), 100);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = decoded
      ? (this.sqlite
          .prepare(
            `SELECT * FROM ai_conversations
             WHERE updated_at<? OR (updated_at=? AND id<?)
             ORDER BY updated_at DESC,id DESC LIMIT ?`,
          )
          .all(decoded.at, decoded.at, decoded.id, size + 1) as Row[])
      : (this.sqlite
          .prepare('SELECT * FROM ai_conversations ORDER BY updated_at DESC,id DESC LIMIT ?')
          .all(size + 1) as Row[]);
    const items = rows.slice(0, size).map(conversationRow);
    return {
      items,
      nextCursor:
        rows.length > size ? encodeCursor(items.at(-1)!.updatedAt, items.at(-1)!.id) : null,
    };
  }

  async getConversation(id: string): Promise<AiConversation | null> {
    const row = this.sqlite.prepare('SELECT * FROM ai_conversations WHERE id=?').get(id) as
      Row | undefined;
    return row ? conversationRow(row) : null;
  }

  async updateConversation(
    id: string,
    input: Parameters<AiConversationRepository['updateConversation']>[1],
  ): Promise<AiConversation | null> {
    return this.sqlite.transaction(() => {
      const current = this.sqlite.prepare('SELECT * FROM ai_conversations WHERE id=?').get(id) as
        Row | undefined;
      if (!current) return null;
      const value = conversationRow(current);
      const timestamp = now();
      this.sqlite
        .prepare(
          `UPDATE ai_conversations SET title=?,status=?,committed_task_id=?,last_error=?,
             archived_at=?,updated_at=? WHERE id=?`,
        )
        .run(
          input.title ?? value.title,
          input.status ?? value.status,
          input.committedTaskId === undefined ? value.committedTaskId : input.committedTaskId,
          input.lastError === undefined ? value.lastError : input.lastError,
          input.archivedAt === undefined ? value.archivedAt : input.archivedAt,
          timestamp,
          id,
        );
      return conversationRow(this.requireRow('SELECT * FROM ai_conversations WHERE id=?', id));
    })();
  }

  async deleteConversation(id: string): Promise<boolean> {
    return this.sqlite.prepare('DELETE FROM ai_conversations WHERE id=?').run(id).changes === 1;
  }

  async appendMessage(
    input: Parameters<AiConversationRepository['appendMessage']>[0],
  ): Promise<AiMessage> {
    return this.sqlite.transaction(() => {
      const sequenceRow = this.sqlite
        .prepare(
          'SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM ai_messages WHERE conversation_id=?',
        )
        .get(input.conversationId) as Row;
      const id = input.id ?? randomUUID();
      const timestamp = now();
      this.sqlite
        .prepare(
          `INSERT INTO ai_messages(id,conversation_id,turn_id,role,content,sequence,created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.conversationId,
          input.turnId ?? null,
          input.role,
          input.content,
          Number(sequenceRow.sequence),
          timestamp,
        );
      this.touch(input.conversationId, timestamp);
      return messageRow(this.requireRow('SELECT * FROM ai_messages WHERE id=?', id));
    })();
  }

  async listMessages(conversationId: string, limit = 500): Promise<AiMessage[]> {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM (
          SELECT * FROM ai_messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT ?
        ) ORDER BY sequence ASC`,
      )
      .all(conversationId, Math.min(Math.max(limit, 1), 2_000)) as Row[];
    return rows.map(messageRow);
  }

  async createTurn(input: {
    id?: string;
    conversationId: string;
    attempt?: number;
  }): Promise<AiTurn> {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    this.sqlite
      .prepare(
        `INSERT INTO ai_turns(
          id,conversation_id,status,attempt,model_rounds,tool_calls,input_tokens,output_tokens,created_at
        ) VALUES (?,?,'queued',?,0,0,0,0,?)`,
      )
      .run(id, input.conversationId, input.attempt ?? 1, timestamp);
    this.touch(input.conversationId, timestamp);
    return turnRow(this.requireRow('SELECT * FROM ai_turns WHERE id=?', id));
  }

  async getTurn(id: string): Promise<AiTurn | null> {
    const row = this.sqlite.prepare('SELECT * FROM ai_turns WHERE id=?').get(id) as Row | undefined;
    return row ? turnRow(row) : null;
  }

  async updateTurn(
    id: string,
    input: Parameters<AiConversationRepository['updateTurn']>[1],
  ): Promise<AiTurn | null> {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare('SELECT * FROM ai_turns WHERE id=?').get(id) as
        Row | undefined;
      if (!row) return null;
      const current = turnRow(row);
      this.sqlite
        .prepare(
          `UPDATE ai_turns SET status=?,model_rounds=?,tool_calls=?,input_tokens=?,output_tokens=?,
             error=?,started_at=?,finished_at=? WHERE id=?`,
        )
        .run(
          input.status ?? current.status,
          input.modelRounds ?? current.modelRounds,
          input.toolCalls ?? current.toolCalls,
          input.inputTokens ?? current.inputTokens,
          input.outputTokens ?? current.outputTokens,
          input.error === undefined ? current.error : input.error,
          input.startedAt === undefined ? current.startedAt : input.startedAt,
          input.finishedAt === undefined ? current.finishedAt : input.finishedAt,
          id,
        );
      this.touch(current.conversationId, now());
      return turnRow(this.requireRow('SELECT * FROM ai_turns WHERE id=?', id));
    })();
  }

  async createDraft(conversationId: string, draft: AiTaskDraft): Promise<AiDraftVersion> {
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare('SELECT latest_draft_revision FROM ai_conversations WHERE id=?')
        .get(conversationId) as Row | undefined;
      if (!row) throw new Error(`AI Conversation ${conversationId} was not found`);
      const revision = Number(row.latest_draft_revision) + 1;
      const timestamp = now();
      this.sqlite
        .prepare(
          `INSERT INTO ai_draft_versions(conversation_id,revision,draft,created_at)
           VALUES (?,?,?,?)`,
        )
        .run(conversationId, revision, json(draft), timestamp);
      this.sqlite
        .prepare('UPDATE ai_conversations SET latest_draft_revision=?,updated_at=? WHERE id=?')
        .run(revision, timestamp, conversationId);
      return { conversationId, revision, draft, createdAt: timestamp };
    })();
  }

  async getLatestDraft(conversationId: string): Promise<AiDraftVersion | null> {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM ai_draft_versions WHERE conversation_id=? ORDER BY revision DESC LIMIT 1`,
      )
      .get(conversationId) as Row | undefined;
    return row ? draftRow(row) : null;
  }

  async createToolInvocation(
    input: Parameters<AiConversationRepository['createToolInvocation']>[0],
  ): Promise<AiToolInvocation> {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    this.sqlite
      .prepare(
        `INSERT INTO ai_tool_invocations(
          id,conversation_id,turn_id,tool_call_id,name,arguments,status,created_at
        ) VALUES (?,?,?,?,?,?,'queued',?)
        ON CONFLICT(turn_id,tool_call_id) DO NOTHING`,
      )
      .run(
        id,
        input.conversationId,
        input.turnId,
        input.toolCallId,
        input.name,
        json(input.arguments),
        timestamp,
      );
    const row = this.sqlite
      .prepare('SELECT * FROM ai_tool_invocations WHERE turn_id=? AND tool_call_id=?')
      .get(input.turnId, input.toolCallId) as Row;
    return toolRow(row);
  }

  async updateToolInvocation(
    id: string,
    input: Parameters<AiConversationRepository['updateToolInvocation']>[1],
  ): Promise<AiToolInvocation | null> {
    const row = this.sqlite.prepare('SELECT * FROM ai_tool_invocations WHERE id=?').get(id) as
      Row | undefined;
    if (!row) return null;
    const current = toolRow(row);
    const finishedAt = ['succeeded', 'failed'].includes(input.status) ? now() : null;
    this.sqlite
      .prepare(`UPDATE ai_tool_invocations SET status=?,result=?,error=?,finished_at=? WHERE id=?`)
      .run(
        input.status,
        input.result === undefined
          ? current.result === null
            ? null
            : json(current.result)
          : input.result === null
            ? null
            : json(input.result),
        input.error === undefined ? current.error : input.error,
        finishedAt,
        id,
      );
    return toolRow(this.requireRow('SELECT * FROM ai_tool_invocations WHERE id=?', id));
  }

  async listToolInvocations(turnId: string): Promise<AiToolInvocation[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM ai_tool_invocations WHERE turn_id=? ORDER BY created_at,id')
        .all(turnId) as Row[]
    ).map(toolRow);
  }

  async getProviderSettings(): Promise<AiProviderSettings> {
    return providerRow(this.requireRow('SELECT * FROM ai_provider_settings WHERE singleton_id=1'));
  }

  async updateProviderSettings(
    input: Pick<AiProviderSettings, 'baseUrl' | 'model' | 'apiKeyRef' | 'testedAt'>,
    expectedRevision: number,
  ): Promise<AiProviderSettings | null> {
    const result = this.sqlite
      .prepare(
        `UPDATE ai_provider_settings SET base_url=?,model=?,api_key_ref=?,tested_at=?,
          revision=revision+1,updated_at=? WHERE singleton_id=1 AND revision=?`,
      )
      .run(input.baseUrl, input.model, input.apiKeyRef, input.testedAt, now(), expectedRevision);
    return result.changes === 1 ? this.getProviderSettings() : null;
  }

  async cleanupInactive(before: string): Promise<number> {
    return this.sqlite
      .prepare(
        `DELETE FROM ai_conversations
         WHERE updated_at<? AND status NOT IN ('committing')`,
      )
      .run(before).changes;
  }

  async failInterruptedTurns(): Promise<number> {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare(
          "SELECT DISTINCT conversation_id FROM ai_turns WHERE status IN ('queued','running')",
        )
        .all() as Row[];
      if (rows.length === 0) return 0;
      const timestamp = now();
      const result = this.sqlite
        .prepare(
          `UPDATE ai_turns SET status='failed',error='Runtime interrupted; retry explicitly',
             finished_at=? WHERE status IN ('queued','running')`,
        )
        .run(timestamp);
      const updateConversation = this.sqlite.prepare(
        `UPDATE ai_conversations SET status='failed',last_error='Runtime interrupted; retry explicitly',
           updated_at=? WHERE id=?`,
      );
      for (const row of rows) updateConversation.run(timestamp, row.conversation_id);
      return result.changes;
    })();
  }

  private touch(conversationId: string, timestamp: string): void {
    this.sqlite
      .prepare('UPDATE ai_conversations SET updated_at=? WHERE id=?')
      .run(timestamp, conversationId);
  }

  private requireRow(sql: string, value?: unknown): Row {
    const statement = this.sqlite.prepare(sql);
    const row = (value === undefined ? statement.get() : statement.get(value)) as Row | undefined;
    if (!row) throw new Error('Expected persisted AI Assistance row');
    return row;
  }
}

function conversationRow(row: Row): AiConversation {
  return {
    id: String(row.id),
    title: String(row.title),
    status: row.status as AiConversation['status'],
    latestDraftRevision: Number(row.latest_draft_revision),
    committedTaskId: nullable(row.committed_task_id),
    lastError: nullable(row.last_error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: nullableIso(row.archived_at),
  };
}

function messageRow(row: Row): AiMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    turnId: nullable(row.turn_id),
    role: row.role as AiMessage['role'],
    content: String(row.content),
    sequence: Number(row.sequence),
    createdAt: iso(row.created_at),
  };
}

function turnRow(row: Row): AiTurn {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    status: row.status as AiTurn['status'],
    attempt: Number(row.attempt),
    modelRounds: Number(row.model_rounds),
    toolCalls: Number(row.tool_calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    error: nullable(row.error),
    createdAt: iso(row.created_at),
    startedAt: nullableIso(row.started_at),
    finishedAt: nullableIso(row.finished_at),
  };
}

function draftRow(row: Row): AiDraftVersion {
  return {
    conversationId: String(row.conversation_id),
    revision: Number(row.revision),
    draft: parseJson(row.draft) as AiTaskDraft,
    createdAt: iso(row.created_at),
  };
}

function toolRow(row: Row): AiToolInvocation {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    turnId: String(row.turn_id),
    toolCallId: String(row.tool_call_id),
    name: String(row.name),
    arguments: parseJson(row.arguments) as Record<string, unknown>,
    result: row.result === null ? null : (parseJson(row.result) as Record<string, unknown>),
    status: row.status as AiToolInvocation['status'],
    error: nullable(row.error),
    createdAt: iso(row.created_at),
    finishedAt: nullableIso(row.finished_at),
  };
}

function providerRow(row: Row): AiProviderSettings {
  return {
    baseUrl: nullable(row.base_url),
    model: nullable(row.model),
    apiKeyRef: nullable(row.api_key_ref),
    testedAt: nullableIso(row.tested_at),
    revision: Number(row.revision),
    updatedAt: iso(row.updated_at),
  };
}

function now(): string {
  return new Date().toISOString();
}
function json(value: unknown): string {
  return JSON.stringify(value);
}
function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}
function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id })).toString('base64url');
}
function decodeCursor(cursor: string): { at: string; id: string } {
  const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
    at: unknown;
    id: unknown;
  };
  if (typeof value.at !== 'string' || typeof value.id !== 'string')
    throw new Error('Invalid cursor');
  return { at: value.at, id: value.id };
}
