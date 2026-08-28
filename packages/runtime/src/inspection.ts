import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { assertNetworkAllowed } from '@zhiyun/crawler-runtime';
import type { BrowserSettings, NetworkPolicy, RequestSettings } from '@zhiyun/contracts';

interface InspectionSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class InspectionManager {
  private readonly sessions = new Map<string, InspectionSession>();

  async create(input: {
    url: string;
    requestSettings: RequestSettings;
    browserSettings: BrowserSettings;
    networkPolicy: NetworkPolicy;
  }) {
    await assertNetworkAllowed(input.url, input.networkPolicy);
    const browser = await chromium.launch({
      headless: true,
      ...(input.requestSettings.proxy
        ? {
            proxy: {
              server: input.requestSettings.proxy.url,
              ...(input.requestSettings.proxy.username
                ? { username: input.requestSettings.proxy.username }
                : {}),
              ...(input.requestSettings.proxy.password
                ? { password: input.requestSettings.proxy.password }
                : {}),
            },
          }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: Object.fromEntries(
        Object.entries(input.requestSettings.headers).filter(
          ([name]) =>
            !['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase()),
        ),
      ),
    });
    if (input.requestSettings.cookies.length > 0) {
      await context.addCookies(
        input.requestSettings.cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          path: cookie.path,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
          ...(cookie.domain ? { domain: cookie.domain } : { url: input.url }),
        })),
      );
    }
    const storedCookies = Array.isArray(input.browserSettings.storageState?.cookies)
      ? input.browserSettings.storageState.cookies
      : [];
    if (storedCookies.length > 0)
      await context.addCookies(storedCookies as Parameters<BrowserContext['addCookies']>[0]);
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      try {
        await assertNetworkAllowed(route.request().url(), input.networkPolicy);
        const sameOrigin = new URL(route.request().url()).origin === new URL(input.url).origin;
        const secretHeaders = Object.fromEntries(
          Object.entries(input.requestSettings.headers).filter(([name]) =>
            ['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase()),
          ),
        );
        await route.continue({
          headers: sameOrigin
            ? { ...route.request().headers(), ...secretHeaders }
            : route.request().headers(),
        });
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    await page.goto(input.url, {
      waitUntil: input.browserSettings.waitUntil,
      timeout: input.requestSettings.timeoutMs,
    });
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + 15 * 60_000;
    const timer = setTimeout(() => void this.close(id), 15 * 60_000);
    timer.unref?.();
    this.sessions.set(id, { id, browser, context, page, expiresAt, timer });
    return { id, url: page.url(), expiresAt: new Date(expiresAt).toISOString() };
  }

  private get(id: string): InspectionSession {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) throw new Error('Inspection session expired');
    return session;
  }

  async screenshot(id: string) {
    const session = this.get(id);
    return {
      url: session.page.url(),
      image: (await session.page.screenshot({ type: 'png' })).toString('base64'),
      width: 1280,
      height: 800,
    };
  }

  async action(
    id: string,
    action: { type: 'click' | 'scroll' | 'refresh'; x?: number; y?: number; deltaY?: number },
  ) {
    const { page } = this.get(id);
    if (action.type === 'click') await page.mouse.click(action.x ?? 0, action.y ?? 0);
    if (action.type === 'scroll') await page.mouse.wheel(0, action.deltaY ?? 600);
    if (action.type === 'refresh') await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    return { url: page.url() };
  }

  async select(id: string, x: number, y: number) {
    return this.get(id).page.evaluate(
      ({ x: pointX, y: pointY }) => {
        const element = document.elementFromPoint(pointX, pointY) as HTMLElement | null;
        if (!element) return null;
        const segment = (node: Element) => {
          if (node.id) return `#${CSS.escape(node.id)}`;
          const classes = [...node.classList]
            .slice(0, 2)
            .map((name) => `.${CSS.escape(name)}`)
            .join('');
          if (classes) return `${node.tagName.toLowerCase()}${classes}`;
          const siblings = node.parentElement
            ? [...node.parentElement.children].filter((item) => item.tagName === node.tagName)
            : [];
          const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : '';
          return `${node.tagName.toLowerCase()}${suffix}`;
        };
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && parts.length < 5) {
          parts.unshift(segment(current));
          if (current.id) break;
          current = current.parentElement;
        }
        const box = element.getBoundingClientRect();
        return {
          selector: parts.join(' > '),
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? '').trim().slice(0, 300),
          attributes: Object.fromEntries(
            [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
          ),
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
        };
      },
      { x, y },
    );
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    clearTimeout(session.timer);
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
