import { expect, request } from '@playwright/test';

export default async function globalSetup() {
  const context = await request.newContext();
  try {
    // Portal becomes reachable before the launcher's parallel Admin startup finishes.
    // Wait for both applications before any test starts signing in.
    for (const origin of [process.env.CLOUD_PORTAL_ORIGIN, process.env.CLOUD_ADMIN_ORIGIN]) {
      if (!origin) throw new Error('Run cloud:e2e to provide isolated application origins');
      await expect
        .poll(
          async () => {
            try {
              return (await context.get(origin, { timeout: 2000 })).status();
            } catch {
              return 0;
            }
          },
          { timeout: 30000 },
        )
        .toBe(200);
    }
  } finally {
    await context.dispose();
  }
}
