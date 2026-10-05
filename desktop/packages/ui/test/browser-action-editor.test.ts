import { describe, expect, it } from 'vitest';
import {
  executionStateFromResult,
  isSensitiveFillTarget,
  parseBrowserActions,
  updateActionSelector,
} from '../src/components/BrowserActionEditor.js';

describe('browser action editor helpers', () => {
  it('round-trips every supported action type through the shared schema', () => {
    const value = JSON.stringify([
      { type: 'click', selector: '.next' },
      { type: 'fill', selector: '#query', value: '织云' },
      { type: 'select', selector: '#category', value: 'books' },
      { type: 'press', selector: '#query', key: 'Enter' },
      { type: 'hover', selector: '.menu' },
      { type: 'wait', milliseconds: 500 },
      { type: 'waitFor', selector: '.loaded' },
      { type: 'scroll', count: 3 },
    ]);
    expect(parseBrowserActions(value).map(({ type }) => type)).toEqual([
      'click',
      'fill',
      'select',
      'press',
      'hover',
      'wait',
      'waitFor',
      'scroll',
    ]);
  });

  it('updates a selector without losing any other action data', () => {
    const next = updateActionSelector(
      JSON.stringify([{ type: 'fill', selector: '#old', value: 'search text' }]),
      0,
      '#new',
    );
    expect(JSON.parse(next)).toEqual([{ type: 'fill', selector: '#new', value: 'search text' }]);
  });

  it('carries inspected input metadata and blocks a password whose id looks harmless', () => {
    const passwordSelection = {
      selector: '#login-input',
      tag: 'input',
      text: '',
      attributes: { id: 'login-input', type: 'password' },
      box: { x: 0, y: 0, width: 100, height: 20 },
      metadata: { tag: 'input', inputType: 'password', sensitive: true },
    } as const;
    const next = updateActionSelector(
      JSON.stringify([{ type: 'fill', selector: '#old', value: '' }]),
      0,
      passwordSelection,
    );
    expect(JSON.parse(next)).toEqual([
      {
        type: 'fill',
        selector: '#login-input',
        value: '',
        target: { tag: 'input', inputType: 'password', sensitive: true },
      },
    ]);
    expect(() =>
      updateActionSelector(
        JSON.stringify([{ type: 'fill', selector: '#old', value: 'plain-text-password' }]),
        0,
        passwordSelection,
      ),
    ).toThrow('禁止');
  });

  it('rejects password values and malformed advanced JSON', () => {
    expect(() =>
      parseBrowserActions(
        JSON.stringify([{ type: 'fill', selector: 'input[type=password]', value: 'secret' }]),
      ),
    ).toThrow('禁止');
    expect(() => parseBrowserActions('{')).toThrow();
  });

  it('uses inspection metadata when advanced JSON omits the target before save', () => {
    expect(
      isSensitiveFillTarget(
        { type: 'fill', selector: '#login-input', value: '' },
        { tag: 'input', inputType: 'password', sensitive: true },
      ),
    ).toBe(true);
    expect(() =>
      parseBrowserActions(
        JSON.stringify([{ type: 'fill', selector: '#login-input', value: 'secret' }]),
        {
          '#login-input': { tag: 'input', inputType: 'password', sensitive: true },
        },
      ),
    ).toThrow('禁止');
  });

  it('maps server step results to located card success and failure states', () => {
    expect(
      executionStateFromResult({
        stepIndex: 2,
        status: 'succeeded',
        url: 'https://example.test/next',
        screenshot: { image: 'image', width: 1280, height: 800 },
        error: null,
      }),
    ).toEqual({
      status: 'succeeded',
      url: 'https://example.test/next',
      error: null,
    });
    expect(
      executionStateFromResult({
        stepIndex: 4,
        status: 'failed',
        url: 'https://example.test/form',
        screenshot: { image: 'image', width: 1280, height: 800 },
        error: 'selector not found',
      }),
    ).toEqual({
      status: 'failed',
      url: 'https://example.test/form',
      error: 'selector not found',
    });
  });
});
