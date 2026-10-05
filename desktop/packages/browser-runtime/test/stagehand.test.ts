import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserSettingsSchema, requestSettingsSchema, type DiagnosticStep } from '@zhiyun/shared';
import { StagehandAdapter } from '../src/index.js';

describe('real local Stagehand adapter without model credentials', () => {
  let server: ReturnType<typeof createServer>;
  let receiver: ReturnType<typeof createServer>;
  let url: string, receiverUrl: string, html: string;
  let effects: number, externalRequests: number, deniedRequests: number;
  const request = requestSettingsSchema.parse({
    timeoutMs: 1500,
    retries: 0,
    delayMs: 0,
    respectRobotsTxt: false,
    maxResponseBytes: 1024 * 1024,
  });
  beforeEach(async () => {
    effects = 0;
    externalRequests = 0;
    deniedRequests = 0;
    html =
      '<main><input id="search" onclick="fetch(\'/effect\')" onkeydown="if(event.key===\'Enter\')this.setAttribute(\'data-confirmed\',\'yes\')"><select id="choice"><option value="a">A</option><option value="b">B</option></select><button id="open" onmouseover="if(event.isTrusted)this.setAttribute(\'data-hovered\',\'yes\')" onclick="document.querySelector(\'#records\').hidden=false">Open</button><section id="records" hidden>Records</section></main>';
    receiver = createServer((_incoming, response) => {
      externalRequests++;
      response.end('receiver');
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const other = receiver.address();
    if (!other || typeof other === 'string') throw new Error('No receiver port');
    receiverUrl = `http://127.0.0.1:${other.port}/collect`;
    server = createServer((incoming, response) => {
      if (incoming.url === '/effect') {
        effects++;
        response.end('ok');
        return;
      }
      if (incoming.url === '/blocked') {
        deniedRequests++;
        response.end('blocked');
        return;
      }
      if (incoming.url === '/redirect') {
        response.writeHead(302, { location: receiverUrl });
        response.end();
        return;
      }
      if (incoming.url === '/redirect-allowed' || incoming.url === '/redirect-denied') {
        response.writeHead(302, {
          location: incoming.url === '/redirect-allowed' ? '/list' : '/blocked',
        });
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    url = `http://127.0.0.1:${address.port}/list`;
  });
  afterEach(async () => {
    await Promise.all(
      [server, receiver].map(
        (value) => new Promise<void>((resolve) => value.close(() => resolve())),
      ),
    );
  });

  it('uses native fill/select/press/hover/wait actions and validates state without a key or extra click', async () => {
    const steps: DiagnosticStep[] = [];
    const result = await new StagehandAdapter({ enabled: true }).load(url, {
      request,
      browser: browserSettingsSchema.parse({
        enabled: true,
        actions: [
          { type: 'fill', selector: '#search', value: 'FAKE_NATIVE_FILL_84ab' },
          { type: 'select', selector: '#choice', value: 'b' },
          {
            type: 'press',
            selector: '#search',
            key: 'Enter',
            expectedState: {
              checks: [
                { type: 'attribute', selector: '#search', name: 'data-confirmed', value: 'yes' },
              ],
            },
          },
          {
            type: 'hover',
            selector: '#open',
            expectedState: {
              checks: [
                { type: 'attribute', selector: '#open', name: 'data-hovered', value: 'yes' },
              ],
            },
          },
          { type: 'wait', milliseconds: 10 },
          {
            type: 'click',
            selector: '#open',
            expectedState: { checks: [{ type: 'visible', selector: '#records' }] },
          },
          { type: 'waitFor', selector: '#records' },
        ],
      }),
      onDiagnostic: (step) => {
        steps.push(step);
        if (step.kind === 'action' && step.status === 'failed')
          console.info('STAGEHAND_FAILED_NATIVE_ACTION', step.actionType);
      },
      collectCacheSession: true,
    });
    expect(result.html).toContain('data-confirmed="yes"');
    expect(result.html).toContain('data-hovered="yes"');
    expect(effects).toBe(0);
    expect(steps.filter((step) => step.kind === 'action')).toHaveLength(7);
    expect(
      steps.filter((step) => step.kind === 'action').every((step) => step.status === 'succeeded'),
    ).toBe(true);
    expect(result.cacheSession?.privateValues).toContain('FAKE_NATIVE_FILL_84ab');
  }, 30_000);

  it.each(['quirks', 'standards'] as const)(
    'validates native CSS hover and revealed records in %s mode without clicking',
    async (mode) => {
      html = `${mode === 'standards' ? '<!doctype html>' : ''}<style>#records{display:none}#open:hover + #records{display:block}</style><button id="open" onclick="fetch('/effect')">Open</button><section id="records">Records</section>`;
      const steps: DiagnosticStep[] = [];
      const result = await new StagehandAdapter({ enabled: true }).load(url, {
        request,
        browser: browserSettingsSchema.parse({
          enabled: true,
          actions: [
            { type: 'hover', selector: '#open' },
            { type: 'waitFor', selector: '#records' },
          ],
        }),
        onDiagnostic: (step) => {
          steps.push(step);
        },
      });
      expect(result.html).toContain('Records');
      expect(effects).toBe(0);
      expect(steps.filter((step) => step.kind === 'action')).toHaveLength(2);
      expect(
        steps.filter((step) => step.kind === 'action').every((step) => step.status === 'succeeded'),
      ).toBe(true);
    },
    30_000,
  );

  it('rejects a native hover that produces an effect but does not reveal the expected records', async () => {
    html = html.replace(
      "if(event.isTrusted)this.setAttribute('data-hovered','yes')",
      "if(event.isTrusted)fetch('/effect')",
    );
    await expect(
      new StagehandAdapter({ enabled: true }).load(url, {
        request,
        browser: browserSettingsSchema.parse({
          enabled: true,
          actions: [
            {
              type: 'hover',
              selector: '#open',
              expectedState: { checks: [{ type: 'visible', selector: '#records' }] },
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: 'ACTION_STATE_INVALID' });
    expect(effects).toBe(1);
  }, 30_000);

  it('reports a failed expected state after exactly one real click effect', async () => {
    html = html.replace("document.querySelector('#records').hidden=false", "fetch('/effect')");
    const steps: DiagnosticStep[] = [];
    await expect(
      new StagehandAdapter({ enabled: true, selfHeal: true, apiKey: 'FAKE_UNUSED_KEY_391a' }).load(
        url,
        {
          request,
          browser: browserSettingsSchema.parse({
            enabled: true,
            actions: [
              {
                type: 'click',
                selector: '#open',
                expectedState: { checks: [{ type: 'visible', selector: '#records' }] },
              },
            ],
          }),
          onDiagnostic: (step) => {
            steps.push(step);
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'ACTION_STATE_INVALID' });
    expect(effects).toBe(1);
    expect(steps).toContainEqual(
      expect.objectContaining({
        kind: 'action',
        status: 'failed',
        errorCode: 'ACTION_STATE_INVALID',
      }),
    );
  }, 30_000);

  it.each(['fill', 'select', 'waitFor'] as const)(
    'does not infer a replacement for a missing %s target',
    async (type) => {
      await expect(
        new StagehandAdapter({ enabled: true, selfHeal: true }).load(url, {
          request,
          browser: browserSettingsSchema.parse({
            enabled: true,
            actions: [
              type === 'waitFor'
                ? { type, selector: '#absent' }
                : { type, selector: '#absent', value: 'FAKE_VALUE_NEVER_TO_MODEL' },
            ],
          }),
        }),
      ).rejects.toMatchObject({ code: 'NAVIGATION_ERROR' });
      expect(effects).toBe(0);
    },
    30_000,
  );

  it('closes its owned browser when canceled during a native wait', async () => {
    const controller = new AbortController();
    const steps: DiagnosticStep[] = [];
    let began: () => void;
    const entered = new Promise<void>((resolve) => {
      began = resolve;
    });
    const pending = new StagehandAdapter({ enabled: true }).load(url, {
      request,
      signal: controller.signal,
      browser: browserSettingsSchema.parse({
        enabled: true,
        actions: [
          {
            type: 'click',
            selector: '#open',
            expectedState: { checks: [{ type: 'visible', selector: '#records' }] },
          },
          { type: 'wait', milliseconds: 5000 },
        ],
      }),
      onDiagnostic: (step) => {
        steps.push(step);
        if (step.kind === 'action' && step.actionType === 'click' && step.status === 'succeeded')
          began();
      },
    });
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort(new Error('Fixture canceled'));
    await expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
    expect(steps).toContainEqual(
      expect.objectContaining({
        kind: 'action',
        actionType: 'wait',
        status: 'canceled',
        errorCode: 'CANCELED',
      }),
    );
  }, 30_000);

  it('blocks same-host cross-origin requests and denied subresources before sending credentials', async () => {
    html += `<script>fetch(${JSON.stringify(receiverUrl)},{credentials:'include'}).catch(()=>{});fetch('/blocked').catch(()=>{});</script>`;
    const result = await new StagehandAdapter({ enabled: true }).load(url, {
      request: {
        ...request,
        headers: { authorization: 'Bearer FAKE_STAGEHAND_AUTH_846a' },
        cookies: [
          {
            name: 'session',
            value: 'FAKE_STAGEHAND_COOKIE_846a',
            path: '/',
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
      },
      browser: browserSettingsSchema.parse({ enabled: true }),
      allowRequest: async (target) => {
        if (target.endsWith('/blocked')) throw new Error('Fixture policy denies target');
      },
    });
    expect(result.html).toContain('Records');
    expect(externalRequests).toBe(0);
    expect(deniedRequests).toBe(0);
  }, 30_000);

  it('blocks a cross-origin server redirect before forwarding authentication', async () => {
    await expect(
      new StagehandAdapter({ enabled: true }).load(url.replace('/list', '/redirect'), {
        request: { ...request, headers: { authorization: 'Bearer FAKE_STAGEHAND_REDIRECT_AUTH' } },
        browser: browserSettingsSchema.parse({ enabled: true }),
      }),
    ).rejects.toMatchObject({ code: 'NAVIGATION_ERROR' });
    expect(externalRequests).toBe(0);
  }, 30_000);

  it.each(['allowed', 'denied'] as const)(
    'applies the request policy to an %s redirect within the same origin',
    async (policy) => {
      const pending = new StagehandAdapter({ enabled: true }).load(
        url.replace('/list', `/redirect-${policy}`),
        {
          request,
          browser: browserSettingsSchema.parse({ enabled: true }),
          allowRequest: async (target) => {
            if (target.endsWith('/blocked')) throw new Error('Fixture denies redirect destination');
          },
        },
      );
      if (policy === 'allowed') expect((await pending).html).toContain('Records');
      else await expect(pending).rejects.toMatchObject({ code: 'NAVIGATION_ERROR' });
      expect(deniedRequests).toBe(0);
      expect(externalRequests).toBe(0);
    },
    30_000,
  );

  it('keeps disabled adapters explicit and enforces the browser response limit', async () => {
    await expect(
      new StagehandAdapter({ enabled: false }).load(url, {
        request,
        browser: browserSettingsSchema.parse({}),
      }),
    ).rejects.toThrow('not enabled');
    await expect(
      new StagehandAdapter({ enabled: true }).load(url, {
        request: { ...request, maxResponseBytes: 10 },
        browser: browserSettingsSchema.parse({ enabled: true }),
      }),
    ).rejects.toMatchObject({ code: 'CRAWLER_ERROR' });
  }, 30_000);
});
