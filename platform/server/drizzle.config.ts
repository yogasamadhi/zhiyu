import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.CLOUD_DATABASE_URL ??
      'postgres://zhiyun:zhiyun-local@localhost:55432/zhiyun_cloud',
  },
});
