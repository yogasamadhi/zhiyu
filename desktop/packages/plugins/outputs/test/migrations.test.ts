import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  outputsSqliteMigration001,
  outputsSqliteMigration002,
  outputsSqliteMigration003,
  outputsSqliteMigration004,
  outputsSqliteMigration005,
} from '../src/migrations/sqlite/index.js';

describe('outputs SQLite forward migrations', () => {
  it('upgrades legacy webhook event subscriptions without changing migration history', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(outputsSqliteMigration001);
      sqlite
        .prepare(
          `INSERT INTO output_destinations(
             id,name,type,config,credential_ref,enabled,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          'legacy-webhook',
          'Legacy webhook',
          'webhook',
          JSON.stringify({ url: 'https://example.com/hook', event: 'run.failed' }),
          null,
          1,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
      sqlite.exec(outputsSqliteMigration002);
      sqlite.exec(outputsSqliteMigration003);
      sqlite.exec(outputsSqliteMigration004);
      sqlite.exec(outputsSqliteMigration005);
      sqlite.exec(outputsSqliteMigration005);

      const row = sqlite
        .prepare("SELECT config FROM output_destinations WHERE id='legacy-webhook'")
        .get() as { config: string };
      expect(JSON.parse(row.config)).toEqual({
        url: 'https://example.com/hook',
        events: ['run.failed'],
      });
    } finally {
      sqlite.close();
    }
  });

  it('defaults a legacy webhook without an event to run.succeeded', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(outputsSqliteMigration001);
      sqlite
        .prepare(
          `INSERT INTO output_destinations(
             id,name,type,config,credential_ref,enabled,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          'legacy-default',
          'Legacy default',
          'webhook',
          JSON.stringify({ url: 'https://example.com/hook' }),
          null,
          1,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
      sqlite.exec(outputsSqliteMigration002);
      sqlite.exec(outputsSqliteMigration005);

      const row = sqlite
        .prepare("SELECT config FROM output_destinations WHERE id='legacy-default'")
        .get() as { config: string };
      expect(JSON.parse(row.config)).toEqual({
        url: 'https://example.com/hook',
        events: ['run.succeeded'],
      });
    } finally {
      sqlite.close();
    }
  });
});
