import { errors } from 'playwright';
import type { Page } from '@browserbasehq/stagehand';
import type { BrowserAction } from '@zhiyun/shared';

/** Uses Stagehand's native driver; inference and state qualification live in the bounded cache. */
export async function performStagehandAction(
  page: Page,
  action: BrowserAction,
  timeoutMs: number,
  closeOwnedBrowser: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const budget =
    action.type === 'wait'
      ? Math.max(timeoutMs, action.milliseconds + 100)
      : action.type === 'scroll'
        ? Math.max(timeoutMs, action.count * 250 + 100)
        : timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const execute = async () => {
    const selector = 'selector' in action ? action.selector : undefined;
    if (
      selector &&
      !(await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs }))
    )
      throw new errors.TimeoutError(
        'The configured Stagehand action target did not become visible',
      );
    signal?.throwIfAborted();
    const locator = selector ? page.locator(selector).first() : undefined;
    if (action.type === 'click') await locator!.click();
    if (action.type === 'fill') await locator!.fill(action.value);
    if (action.type === 'select') await locator!.selectOption([action.value]);
    if (action.type === 'press') {
      // Focus must not trigger the extra click that the previous adapter performed.
      await page.evaluate(
        (target) => (document.querySelector(target) as HTMLElement | null)?.focus(),
        action.selector,
      );
      await page.keyPress(action.key);
    }
    if (action.type === 'hover') await locator!.hover();
    if (action.type === 'wait') await page.waitForTimeout(action.milliseconds);
    if (action.type === 'scroll') {
      for (let index = 0; index < action.count; index++) {
        signal?.throwIfAborted();
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(250);
      }
    }
    signal?.throwIfAborted();
  };
  try {
    await Promise.race([
      execute(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new errors.TimeoutError('Stagehand browser action timed out'));
          void closeOwnedBrowser().catch(() => undefined);
        }, budget);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
