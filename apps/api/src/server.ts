import { getConfig } from '@zhiyun/config';
import { buildApp } from './app.js';

const config = getConfig();
const app = await buildApp();

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
