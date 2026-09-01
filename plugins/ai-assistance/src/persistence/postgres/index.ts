import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
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
import { aiAssistancePostgresMigration001 } from '../../migrations/postgres/index.js';

type Row = Record<string, unknown>;
type Sql = ReturnType<typeof postgres>;
const migrationId = '001-conversations';

export class PostgresAiConversationRepository implements AiConversationRepository {
  private readonly sql: Sql;

  constructor(connectionString: string, maxConnections = 5) {
    this.sql = postgres(connectionString, { max: maxConnections });
  }

  async migrate(): Promise<void> {
    const checksum = sha256(aiAssistancePostgresMigration001);
    const rows = await this.sql`
      SELECT checksum FROM plugin_migrations
      WHERE plugin_id='ai-assistance' AND migration_id=${migrationId}
    `;
    if (rows[0]) {
      if (rows[0].checksum !== checksum) {
        throw new Error(`Migration checksum mismatch for ai-assistance:${migrationId}`);
      }
      return;
    }
    const started = performance.now();
    await this.sql.begin(async (transaction) => {
      await transaction.unsafe(aiAssistancePostgresMigration001);
      await transaction`
        INSERT INTO plugin_migrations(
          plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
        ) VALUES (
          'ai-assistance',${migrationId},'1.0.0',${checksum},${new Date()},
          ${Math.max(0, Math.round(performance.now() - started))},'succeeded'
        )
      `;
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async createConversation(input: { id?: string; title?: string } = {}): Promise<AiConversation> {
    const id = input.id ?? randomUUID();
    const timestamp = new Date();
    const rows = await this.sql`
      INSERT INTO ai_conversations(
        id,title,status,latest_draft_revision,created_at,updated_at
      ) VALUES (
        ${id},${input.title?.trim() || '新建 AI 爬虫'},'active',0,${timestamp},${timestamp}
      ) RETURNING *
    `;
    return conversationRow(rows[0] as Row);
  }

  async listConversations(cursor?: string, limit = 50) {
    const size = Math.min(Math.max(limit, 1), 100);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = decoded
      ? await this.sql`
          SELECT * FROM ai_conversations
          WHERE updated_at<${new Date(decoded.at)}
             OR (updated_at=${new Date(decoded.at)} AND id<${decoded.id})
          ORDER BY updated_at DESC,id DESC LIMIT ${size + 1}
        `
      : await this.sql`
          SELECT * FROM ai_conversations ORDER BY updated_at DESC,id DESC LIMIT ${size + 1}
        `;
    const items = rows.slice(0, size).map((row) => conversationRow(row as Row));
    return {
      items,
      nextCursor:
        rows.length > size ? encodeCursor(items.at(-1)!.updatedAt, items.at(-1)!.id) : null,
    };
  }

  async getConversation(id: string): Promise<AiConversation | null> {
    const rows = await this.sql`SELECT * FROM ai_conversations WHERE id=${id}`;
    return rows[0] ? conversationRow(rows[0] as Row) : null;
  }

  async updateConversation(
    id: string,
    input: Parameters<AiConversationRepository['updateConversation']>[1],
  ): Promise<AiConversation | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`SELECT * FROM ai_conversations WHERE id=${id} FOR UPDATE`;
      if (!selected[0]) return null;
      const current = conversationRow(selected[0] as Row);
      const rows = await transaction`
        UPDATE ai_conversations SET
          title=${input.title ?? current.title},status=${input.status ?? current.status},
          committed_task_id=${input.committedTaskId === undefined ? current.committedTaskId : input.committedTaskId},
          last_error=${input.lastError === undefined ? current.lastError : input.lastError},
          archived_at=${dateOrNull(input.archivedAt === undefined ? current.archivedAt : input.archivedAt)},
          updated_at=${new Date()}
        WHERE id=${id} RETURNING *
      `;
      return conversationRow(rows[0] as Row);
    });
  }

  async deleteConversation(id: string): Promise<boolean> {
    const rows = await this.sql`DELETE FROM ai_conversations WHERE id=${id} RETURNING id`;
    return rows.length === 1;
  }

  async appendMessage(
    input: Parameters<AiConversationRepository['appendMessage']>[0],
  ): Promise<AiMessage> {
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT id FROM ai_conversations WHERE id=${input.conversationId} FOR UPDATE`;
      const sequenceRows = await transaction`
        SELECT COALESCE(MAX(sequence),0)+1 AS sequence
        FROM ai_messages WHERE conversation_id=${input.conversationId}
      `;
      const id = input.id ?? randomUUID();
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO ai_messages(id,conversation_id,turn_id,role,content,sequence,created_at)
        VALUES (
          ${id},${input.conversationId},${input.turnId ?? null},${input.role},${input.content},
          ${Number(sequenceRows[0]!.sequence)},${timestamp}
        ) RETURNING *
      `;
      await touch(transaction, input.conversationId, timestamp);
      return messageRow(rows[0] as Row);
    });
  }

  async listMessages(conversationId: string, limit = 500): Promise<AiMessage[]> {
    const rows = await this.sql`
      SELECT * FROM (
        SELECT * FROM ai_messages WHERE conversation_id=${conversationId}
        ORDER BY sequence DESC LIMIT ${Math.min(Math.max(limit, 1), 2_000)}
      ) messages ORDER BY sequence ASC
    `;
    return rows.map((row) => messageRow(row as Row));
  }

  async createTurn(input: {
    id?: string;
    conversationId: string;
    attempt?: number;
  }): Promise<AiTurn> {
    const id = input.id ?? randomUUID();
    const timestamp = new Date();
    const rows = await this.sql`
      INSERT INTO ai_turns(
        id,conversation_id,status,attempt,model_rounds,tool_calls,input_tokens,output_tokens,created_at
      ) VALUES (${id},${input.conversationId},'queued',${input.attempt ?? 1},0,0,0,0,${timestamp})
      RETURNING *
    `;
    await this.sql`
      UPDATE ai_conversations SET updated_at=${timestamp} WHERE id=${input.conversationId}
    `;
    return turnRow(rows[0] as Row);
  }

  async getTurn(id: string): Promise<AiTurn | null> {
    const rows = await this.sql`SELECT * FROM ai_turns WHERE id=${id}`;
    return rows[0] ? turnRow(rows[0] as Row) : null;
  }

  async updateTurn(
    id: string,
    input: Parameters<AiConversationRepository['updateTurn']>[1],
  ): Promise<AiTurn | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`SELECT * FROM ai_turns WHERE id=${id} FOR UPDATE`;
      if (!selected[0]) return null;
      const current = turnRow(selected[0] as Row);
      const rows = await transaction`
        UPDATE ai_turns SET
          status=${input.status ?? current.status},model_rounds=${input.modelRounds ?? current.modelRounds},
          tool_calls=${input.toolCalls ?? current.toolCalls},
          input_tokens=${input.inputTokens ?? current.inputTokens},
          output_tokens=${input.outputTokens ?? current.outputTokens},
          error=${input.error === undefined ? current.error : input.error},
          started_at=${dateOrNull(input.startedAt === undefined ? current.startedAt : input.startedAt)},
          finished_at=${dateOrNull(input.finishedAt === undefined ? current.finishedAt : input.finishedAt)}
        WHERE id=${id} RETURNING *
      `;
      await touch(transaction, current.conversationId, new Date());
      return turnRow(rows[0] as Row);
    });
  }

  async createDraft(conversationId: string, draft: AiTaskDraft): Promise<AiDraftVersion> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`
        SELECT latest_draft_revision FROM ai_conversations
        WHERE id=${conversationId} FOR UPDATE
      `;
      if (!selected[0]) throw new Error(`AI Conversation ${conversationId} was not found`);
      const revision = Number(selected[0].latest_draft_revision) + 1;
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO ai_draft_versions(conversation_id,revision,draft,created_at)
        VALUES (
          ${conversationId},${revision},${transaction.json(jsonValue(draft))},${timestamp}
        ) RETURNING *
      `;
      await transaction`
        UPDATE ai_conversations SET latest_draft_revision=${revision},updated_at=${timestamp}
        WHERE id=${conversationId}
      `;
      return draftRow(rows[0] as Row);
    });
  }

  async getLatestDraft(conversationId: string): Promise<AiDraftVersion | null> {
    const rows = await this.sql`
      SELECT * FROM ai_draft_versions WHERE conversation_id=${conversationId}
      ORDER BY revision DESC LIMIT 1
    `;
    return rows[0] ? draftRow(rows[0] as Row) : null;
  }

  async createToolInvocation(
    input: Parameters<AiConversationRepository['createToolInvocation']>[0],
  ): Promise<AiToolInvocation> {
    const id = input.id ?? randomUUID();
    const rows = await this.sql`
      INSERT INTO ai_tool_invocations(
        id,conversation_id,turn_id,tool_call_id,name,arguments,status,created_at
      ) VALUES (
        ${id},${input.conversationId},${input.turnId},${input.toolCallId},${input.name},
        ${this.sql.json(jsonValue(input.arguments))},'queued',${new Date()}
      ) ON CONFLICT(turn_id,tool_call_id) DO UPDATE SET tool_call_id=EXCLUDED.tool_call_id
      RETURNING *
    `;
    return toolRow(rows[0] as Row);
  }

  async updateToolInvocation(
    id: string,
    input: Parameters<AiConversationRepository['updateToolInvocation']>[1],
  ): Promise<AiToolInvocation | null> {
    const selected = await this.sql`SELECT * FROM ai_tool_invocations WHERE id=${id}`;
    if (!selected[0]) return null;
    const current = toolRow(selected[0] as Row);
    const resultValue = input.result === undefined ? current.result : input.result;
    const rows = await this.sql`
      UPDATE ai_tool_invocations SET status=${input.status},
        result=${resultValue === null ? null : this.sql.json(jsonValue(resultValue))},
        error=${input.error === undefined ? current.error : input.error},
        finished_at=${['succeeded', 'failed'].includes(input.status) ? new Date() : null}
      WHERE id=${id} RETURNING *
    `;
    return rows[0] ? toolRow(rows[0] as Row) : null;
  }

  async listToolInvocations(turnId: string): Promise<AiToolInvocation[]> {
    const rows = await this.sql`
      SELECT * FROM ai_tool_invocations WHERE turn_id=${turnId} ORDER BY created_at,id
    `;
    return rows.map((row) => toolRow(row as Row));
  }

  async getProviderSettings(): Promise<AiProviderSettings> {
    const rows = await this.sql`SELECT * FROM ai_provider_settings WHERE singleton_id=1`;
    if (!rows[0]) throw new Error('AI Provider Settings row was not initialized');
    return providerRow(rows[0] as Row);
  }

  async updateProviderSettings(
    input: Pick<AiProviderSettings, 'baseUrl' | 'model' | 'apiKeyRef' | 'testedAt'>,
    expectedRevision: number,
  ): Promise<AiProviderSettings | null> {
    const rows = await this.sql`
      UPDATE ai_provider_settings SET base_url=${input.baseUrl},model=${input.model},
        api_key_ref=${input.apiKeyRef},tested_at=${dateOrNull(input.testedAt)},
        revision=revision+1,updated_at=${new Date()}
      WHERE singleton_id=1 AND revision=${expectedRevision} RETURNING *
    `;
    return rows[0] ? providerRow(rows[0] as Row) : null;
  }

  async cleanupInactive(before: string): Promise<number> {
    const rows = await this.sql`
      DELETE FROM ai_conversations WHERE updated_at<${new Date(before)} AND status<>'committing'
      RETURNING id
    `;
    return rows.length;
  }

  async failInterruptedTurns(): Promise<number> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`
        UPDATE ai_turns SET status='failed',error='Runtime interrupted; retry explicitly',
          finished_at=${new Date()}
        WHERE status IN ('queued','running') RETURNING conversation_id
      `;
      const conversationIds = [...new Set(rows.map((row) => String(row.conversation_id)))];
      for (const conversationId of conversationIds) {
        await transaction`
          UPDATE ai_conversations SET status='failed',
            last_error='Runtime interrupted; retry explicitly',updated_at=${new Date()}
          WHERE id=${conversationId}
        `;
      }
      return rows.length;
    });
  }
}

type Transaction = postgres.TransactionSql;
async function touch(transaction: Transaction, id: string, timestamp: Date): Promise<void> {
  await transaction`UPDATE ai_conversations SET updated_at=${timestamp} WHERE id=${id}`;
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
    draft: row.draft as AiTaskDraft,
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
    arguments: row.arguments as Record<string, unknown>,
    result: row.result === null ? null : (row.result as Record<string, unknown>),
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
function dateOrNull(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}
function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}
function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}
function jsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
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
