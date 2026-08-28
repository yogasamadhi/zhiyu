import { describe, expect, it } from 'vitest';
import { createRuntimeEnvironment } from '../src/runtime-environment.js';

describe('createRuntimeEnvironment', () => {
  it('exposes bundled browser resources before the utility process starts', () => {
    const environment: NodeJS.ProcessEnv = {
      EXISTING_VALUE: 'preserved',
      PLAYWRIGHT_BROWSERS_PATH: '/old/path',
    };

    const result = createRuntimeEnvironment(environment, '/bundled/playwright');

    expect(result).toEqual({
      EXISTING_VALUE: 'preserved',
      PLAYWRIGHT_BROWSERS_PATH: '/bundled/playwright',
    });
    expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe('/old/path');
  });

  it('preserves the inherited browser path when no bundled path is configured', () => {
    expect(createRuntimeEnvironment({ PLAYWRIGHT_BROWSERS_PATH: '/inherited/playwright' })).toEqual(
      { PLAYWRIGHT_BROWSERS_PATH: '/inherited/playwright' },
    );
  });
});
