import { describe, expect, it } from 'vitest';
import {
  DurableEventDispatcher,
  DurableJobDispatcher,
  JobHandlerRegistry,
  type PlatformRepository,
} from '../src/index.js';

describe('platform dispatchers', () => {
  it('exports dispatcher contracts', () => {
    expect(DurableJobDispatcher).toBeTypeOf('function');
    expect(DurableEventDispatcher).toBeTypeOf('function');
    expect(JobHandlerRegistry).toBeTypeOf('function');
    const repository = {} as PlatformRepository;
    expect(repository).toBeDefined();
  });
});
