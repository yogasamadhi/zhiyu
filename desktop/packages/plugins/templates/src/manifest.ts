import type { PluginManifest } from '@zhiyun/plugin-runtime';
export const templatesPlugin = {
  id: 'templates',
  version: '1.0.0',
  dependencies: [
    {
      id: 'collection',
      range: '^1.0.0',
    },
  ],
  routes: [
    {
      operationId: 'listTaskTemplates',
      method: 'GET',
      path: '/api/v2/task-templates',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getTaskTemplate',
      method: 'GET',
      path: '/api/v2/task-templates/{templateId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'instantiateTaskTemplate',
      method: 'POST',
      path: '/api/v2/task-templates/{templateId}/instantiate',
      requiredPermission: 'task.write',
    },
  ],
} as const satisfies PluginManifest;
export default templatesPlugin;
