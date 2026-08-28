import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://zhiyun:zhiyun@localhost:45432/zhiyun';

export const sql = postgres(connectionString, { max: 10 });
export const db = drizzle(sql, { schema });

export async function closeDatabase(): Promise<void> {
  await sql.end();
}
