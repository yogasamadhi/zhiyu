import { getConfig } from '@zhiyun/config';
import { buildApp } from './app.js';

const config = getConfig();
const app = await buildApp();
let closing = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'Headless Runtime shutdown started');
  const forceDeadline = setTimeout(() => {
    app.log.error({ signal }, 'Headless Runtime shutdown exceeded the graceful deadline');
    process.exitCode = 1;
  }, 55_000);
  forceDeadline.unref();
  try {
    await app.close();
    app.log.info({ signal }, 'Headless Runtime shutdown completed');
  } catch (error) {
    app.log.error({ err: error, signal }, 'Headless Runtime shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(forceDeadline);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close().catch((closeError: unknown) => app.log.error(closeError));
}
