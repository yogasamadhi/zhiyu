import { serve } from '@hono/node-server';
import { createApp } from './app.js';
const cloud = createApp();
const server = serve(
  {
    fetch: cloud.app.fetch,
    port: cloud.config.CLOUD_PORT,
    hostname: '0.0.0.0',
  },
  (info) => {
    console.info(`Cloud API listening on http://localhost:${info.port}`);
  },
);
async function stop() {
  await new Promise<void>((done) => {
    server.close(() => done());
  });
  await cloud.close();
  process.exit(0);
}
process.on('SIGTERM', () => {
  void stop();
});
process.on('SIGINT', () => {
  void stop();
});
