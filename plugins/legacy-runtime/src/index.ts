import type { PluginDescriptor } from '@zhiyun/kernel';

export const legacyRuntimePlugin: PluginDescriptor = {
  id: 'legacy.runtime',
  version: '0.2.0',
  uiContributions: [{ id: 'legacy.app', kind: 'route' }],
  activate() {},
};
