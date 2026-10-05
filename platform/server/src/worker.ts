import { createApp } from './app.js';
const cloud = createApp();
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
while (!stopping) {
  try {
    await cloud.worker.tick();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'worker.error',
        name: error instanceof Error ? error.name : 'Error',
      }),
    );
  }
  await Bun.sleep(1000);
}
await cloud.close();
