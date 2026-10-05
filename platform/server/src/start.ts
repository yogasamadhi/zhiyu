import { createApp } from './app.js';
const cloud = createApp();
const server = Bun.serve({
  port: cloud.config.CLOUD_PORT,
  hostname: '0.0.0.0',
  fetch: cloud.app.fetch,
  idleTimeout: 120,
});
console.info(`Cloud API listening on http://localhost:${server.port}`);
async function stop() {
  await server.stop();
  await cloud.close();
  process.exit(0);
}
process.on('SIGTERM', () => {
  void stop();
});
process.on('SIGINT', () => {
  void stop();
});
