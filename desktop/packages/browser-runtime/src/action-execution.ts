import type { Page } from 'playwright';
import { ZhiYunError, type BrowserAction, type BrowserExpectedState } from '@zhiyun/shared';

/** Alternate native drivers share the same preconditions and observed state proof. */
export type BrowserActionExecutor = (action: BrowserAction, signal?: AbortSignal) => Promise<void>;

export function actionHasProof(action: BrowserAction): boolean {
  return (
    ('expectedState' in action && Boolean(action.expectedState)) ||
    ['fill', 'select', 'waitFor', 'wait', 'hover', 'scroll'].includes(action.type)
  );
}

async function stateMatches(page: Page, state: BrowserExpectedState): Promise<boolean> {
  return page.evaluate((checks) => {
    try {
      return checks.every((check) => {
        if (check.type === 'path') return window.location.pathname === check.pathname;
        const elements = document.querySelectorAll(check.selector);
        const element = elements[0];
        if (check.type === 'count')
          return (
            elements.length >= check.minimum &&
            (check.maximum === undefined || elements.length <= check.maximum)
          );
        if (check.type === 'absent') return !element;
        if (check.type === 'attribute') return element?.getAttribute(check.name) === check.value;
        const visible = Boolean(
          element &&
          element.getClientRects().length &&
          getComputedStyle(element).visibility !== 'hidden' &&
          getComputedStyle(element).display !== 'none',
        );
        return check.type === 'visible' ? visible : !visible;
      });
    } catch {
      return false;
    }
  }, state.checks);
}

export async function executeBrowserAction(
  page: Page,
  action: BrowserAction,
  timeoutMs: number,
  signal?: AbortSignal,
  perform?: BrowserActionExecutor,
): Promise<void> {
  signal?.throwIfAborted();
  const state = 'expectedState' in action ? action.expectedState : undefined;
  if (state?.requireTransition && (await stateMatches(page, state)))
    throw new ZhiYunError(
      'ACTION_STATE_INVALID',
      'The configured action requires a new state transition',
    );
  const locator = 'selector' in action ? page.locator(action.selector).first() : undefined;
  if (perform) await perform(action, signal);
  else {
    if (action.type === 'click') await locator!.click({ timeout: timeoutMs });
    if (action.type === 'fill') await locator!.fill(action.value, { timeout: timeoutMs });
    if (action.type === 'select') await locator!.selectOption(action.value, { timeout: timeoutMs });
    if (action.type === 'press') await locator!.press(action.key, { timeout: timeoutMs });
    if (action.type === 'hover') await locator!.hover({ timeout: timeoutMs });
    if (action.type === 'wait') await page.waitForTimeout(action.milliseconds);
    if (action.type === 'waitFor') await locator!.waitFor({ timeout: timeoutMs });
    if (action.type === 'scroll') {
      for (let index = 0; index < action.count; index++) {
        signal?.throwIfAborted();
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(250);
      }
    }
  }
  signal?.throwIfAborted();
  const deadline = Date.now() + Math.min(timeoutMs, 2000);
  const accepted = async () => {
    if (state) return stateMatches(page, state);
    if (action.type === 'fill') return (await locator!.inputValue()) === action.value;
    if (action.type === 'select') return (await locator!.inputValue()) === action.value;
    if (action.type === 'waitFor') return locator!.isVisible();
    if (action.type === 'hover')
      return locator!.evaluate((element) =>
        // A bare :hover only matches links in quirks mode; the type keeps the state proof valid.
        element.matches(`${CSS.escape(element.localName)}:hover`),
      );
    if (action.type === 'scroll')
      return page.evaluate(
        () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2,
      );
    return true;
  };
  while (!(await accepted())) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline)
      throw new ZhiYunError(
        'ACTION_STATE_INVALID',
        'The browser action did not reach its expected state',
      );
    await page.waitForTimeout(25);
  }
  signal?.throwIfAborted();
}
