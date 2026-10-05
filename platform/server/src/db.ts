import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';
export function database(url: string) {
  const sql = postgres(url, {
    max: 12,
    idle_timeout: 20,
    connect_timeout: 5,
    onnotice: () => undefined,
  });
  // Drizzle configures timestamp codecs for its own mapping; raw transactional SQL uses Date values.
  const ormSql = postgres(url, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 5,
    onnotice: () => undefined,
  });
  return {
    sql,
    orm: drizzle(ormSql, { schema }),
    close: async () => {
      await Promise.all([sql.end(), ormSql.end()]);
    },
  };
}
export type Database = ReturnType<typeof database>;
export type Tx = postgres.TransactionSql;
