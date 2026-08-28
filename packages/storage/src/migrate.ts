import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, closeDatabase } from './index.js';

let lastError: unknown;
for (let attempt = 1; attempt <= 20; attempt += 1) {
  try {
    await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
    console.log('Database migrations are up to date.');
    await closeDatabase();
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 20) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
console.error('Database migration failed:', lastError);
await closeDatabase();
process.exit(1);
