import { readdir, readFile } from 'node:fs/promises';
import { database } from './db.js';
import { readConfig } from './config.js';
export async function migrate(url: string) {
  const db = database(url);
  try {
    await db.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(947152)`;
      await tx`create table if not exists cloud_migrations (name text primary key, applied_at timestamptz not null default now())`;
      const folder = new URL('../migrations/', import.meta.url);
      for (const name of (await readdir(folder)).filter((n) => n.endsWith('.sql')).sort()) {
        if ((await tx`select 1 from cloud_migrations where name=${name}`).length) continue;
        await tx.unsafe(await readFile(new URL(name, folder), 'utf8'));
        await tx`insert into cloud_migrations(name) values (${name})`;
      }
    });
  } finally {
    await db.close();
  }
}
if (import.meta.main) {
  await migrate(readConfig().CLOUD_DATABASE_URL);
  console.info('Cloud migrations applied');
}
