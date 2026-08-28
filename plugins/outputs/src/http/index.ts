import type { RouteContribution } from '@zhiyun/kernel';

export const outputsRoutes = [
  { operationId: 'listOutputDestinations', method: 'GET', path: '/api/v2/output-destinations' },
  { operationId: 'createOutputDestination', method: 'POST', path: '/api/v2/output-destinations' },
  {
    operationId: 'getOutputDestination',
    method: 'GET',
    path: '/api/v2/output-destinations/{destinationId}',
  },
  {
    operationId: 'updateOutputDestination',
    method: 'PUT',
    path: '/api/v2/output-destinations/{destinationId}',
  },
  {
    operationId: 'deleteOutputDestination',
    method: 'DELETE',
    path: '/api/v2/output-destinations/{destinationId}',
  },
  { operationId: 'listDeliveryAttempts', method: 'GET', path: '/api/v2/delivery-attempts' },
  { operationId: 'listApiTokens', method: 'GET', path: '/api/v2/api-tokens' },
  { operationId: 'createApiToken', method: 'POST', path: '/api/v2/api-tokens' },
  { operationId: 'revokeApiToken', method: 'DELETE', path: '/api/v2/api-tokens/{tokenId}' },
] as const satisfies readonly RouteContribution[];
