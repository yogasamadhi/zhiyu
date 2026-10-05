import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import type { BrowserAction } from '@zhiyun/contracts';
import {
  classifyInspectedElement,
  executeInspectionBrowserAction,
  InspectionManager,
  redactInspectionStepError,
} from '../src/inspection.js';

describe('inspection browser action steps', () => {
  it('executes every shared BrowserAction using the same page semantics as a crawl', async () => {
    const calls: string[] = [];
    const locator = {
      click: async () => void calls.push('click'),
      fill: async (value: string) => void calls.push(`fill:${value}`),
      selectOption: async (value: string) => void calls.push(`select:${value}`),
      press: async (key: string) => void calls.push(`press:${key}`),
      hover: async () => void calls.push('hover'),
      waitFor: async () => void calls.push('waitFor'),
    } as unknown as Locator;
    const page = {
      locator: (selector: string) => {
        calls.push(`locator:${selector}`);
        return { first: () => locator };
      },
      waitForTimeout: async (milliseconds: number) => void calls.push(`wait:${milliseconds}`),
      evaluate: async () => void calls.push('scroll'),
    } as unknown as Page;
    const actions: BrowserAction[] = [
      { type: 'click', selector: '.next' },
      { type: 'fill', selector: '#query', value: '织云' },
      { type: 'select', selector: '#category', value: 'books' },
      { type: 'press', selector: '#query', key: 'Enter' },
      { type: 'hover', selector: '.menu' },
      { type: 'wait', milliseconds: 500 },
      { type: 'waitFor', selector: '.loaded' },
      { type: 'scroll', count: 2 },
    ];

    for (const action of actions) await executeInspectionBrowserAction(page, action);

    expect(calls).toEqual([
      'locator:.next',
      'click',
      'locator:#query',
      'fill:织云',
      'locator:#category',
      'select:books',
      'locator:#query',
      'press:Enter',
      'locator:.menu',
      'hover',
      'wait:500',
      'locator:.loaded',
      'waitFor',
      'scroll',
      'wait:250',
      'scroll',
      'wait:250',
    ]);
  });

  it('returns the step index, current URL and refreshed screenshot from a live session', async () => {
    const manager = new InspectionManager();
    installSession(manager, {
      locator: () => ({ first: () => ({ click: async () => undefined }) }),
      waitForTimeout: async () => undefined,
      url: () => 'https://example.test/after-click',
      screenshot: async () => Buffer.from('png'),
    });

    try {
      await expect(
        manager.step('session-1', {
          stepIndex: 3,
          action: { type: 'click', selector: '.next' },
        }),
      ).resolves.toEqual({
        stepIndex: 3,
        status: 'succeeded',
        url: 'https://example.test/after-click',
        screenshot: { image: 'cG5n', width: 1280, height: 800 },
        error: null,
        target: null,
      });
    } finally {
      await manager.closeAll();
    }
  });

  it('returns a failed located step while redacting secrets and fill values', async () => {
    const action = { type: 'fill', selector: '#query', value: 'plain-sensitive-value' } as const;
    const redacted = redactInspectionStepError(
      new Error(
        'fill plain-sensitive-value failed; Authorization: Bearer abc.def; https://user:pass@example.test/?token=secret',
      ),
      action,
    );
    expect(redacted).not.toContain('plain-sensitive-value');
    expect(redacted).not.toContain('abc.def');
    expect(redacted).not.toContain('user:pass');
    expect(redacted).not.toContain('token=secret');
    expect(redacted).toContain('[REDACTED]');

    const manager = new InspectionManager();
    installSession(manager, {
      locator: () => ({
        first: () => ({
          evaluate: async () => ({ tag: 'input', inputType: 'text', attributes: { id: 'query' } }),
          fill: async () => Promise.reject(new Error(redacted)),
        }),
      }),
      waitForTimeout: async () => undefined,
      url: () => 'https://example.test/form',
      screenshot: async () => Buffer.from('failed'),
    });
    try {
      await expect(manager.step('session-1', { stepIndex: 1, action })).resolves.toMatchObject({
        stepIndex: 1,
        status: 'failed',
        url: 'https://example.test/form',
        screenshot: { image: 'ZmFpbGVk' },
        error: expect.stringContaining('[REDACTED]'),
        target: { tag: 'input', inputType: 'text', sensitive: false },
      });
    } finally {
      await manager.closeAll();
    }
  });

  it('detects a password input even when its selector does not mention passwords', async () => {
    expect(
      classifyInspectedElement({
        tag: 'input',
        inputType: 'password',
        attributes: { id: 'login-input', type: 'password' },
      }),
    ).toEqual({ tag: 'input', inputType: 'password', sensitive: true });

    let fillCalls = 0;
    const manager = new InspectionManager();
    installSession(manager, {
      locator: () => ({
        first: () => ({
          evaluate: async () => ({
            tag: 'input',
            inputType: 'password',
            attributes: { id: 'login-input', type: 'password' },
          }),
          fill: async () => void (fillCalls += 1),
        }),
      }),
      waitForTimeout: async () => undefined,
      url: () => 'https://example.test/login',
      screenshot: async () => Buffer.from('password-blocked'),
    });
    try {
      await expect(
        manager.step('session-1', {
          stepIndex: 0,
          action: { type: 'fill', selector: '#login-input', value: 'must-not-be-filled' },
        }),
      ).resolves.toMatchObject({
        status: 'failed',
        target: { tag: 'input', inputType: 'password', sensitive: true },
        error: expect.stringContaining('Login Session'),
      });
      expect(fillCalls).toBe(0);
    } finally {
      await manager.closeAll();
    }
  });

  it('returns sanitized password metadata from visual element selection', async () => {
    const manager = new InspectionManager();
    installSession(manager, {
      evaluate: async () => ({
        selector: '#login-input',
        tag: 'input',
        text: 'must-not-leak',
        inputType: 'password',
        attributes: {
          id: 'login-input',
          type: 'password',
          value: 'must-not-leak',
          'data-token': 'must-not-leak',
        },
        box: { x: 1, y: 2, width: 100, height: 20 },
      }),
    });
    try {
      await expect(manager.select('session-1', 10, 10)).resolves.toEqual({
        selector: '#login-input',
        tag: 'input',
        text: '',
        attributes: { id: 'login-input', type: 'password' },
        box: { x: 1, y: 2, width: 100, height: 20 },
        metadata: { tag: 'input', inputType: 'password', sensitive: true },
      });
    } finally {
      await manager.closeAll();
    }
  });
});

function installSession(manager: InspectionManager, page: object): void {
  const timer = setTimeout(() => undefined, 60_000);
  timer.unref?.();
  const sessions = (
    manager as unknown as {
      sessions: Map<
        string,
        {
          id: string;
          browser: Browser;
          context: BrowserContext;
          page: Page;
          expiresAt: number;
          timer: ReturnType<typeof setTimeout>;
        }
      >;
    }
  ).sessions;
  sessions.set('session-1', {
    id: 'session-1',
    browser: { close: async () => undefined } as unknown as Browser,
    context: { close: async () => undefined } as unknown as BrowserContext,
    page: page as Page,
    expiresAt: Date.now() + 60_000,
    timer,
  });
}
