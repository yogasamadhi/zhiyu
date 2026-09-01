import { z } from 'zod';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import {
  analysisResultSchema,
  apiTokenSchema,
  artifactDescriptorSchema,
  crawlPlanDefinitionSchema,
  crawlRunSchema,
  datasetDiffEntrySchema,
  datasetDiffStatsSchema,
  datasetRecordSchema,
  datasetStatsSchema,
  deliveryAttemptSchema,
  domainEventSchema,
  extractedRecordSchema,
  inspectionElementSelectionSchema,
  inspectionStepInputSchema,
  inspectionStepResultSchema,
  outputDestinationSchema,
  preferenceImportSchema,
  preferenceProfileSchema,
  preferenceSignalInputSchema,
  preferenceSignalSchema,
  problemDetailsSchema,
  qualityEvaluationSchema,
  qualityPolicySchema,
  recruitmentFileInputSchema,
  recruitmentImportJobSchema,
  recruitmentImportMappingInputSchema,
  recruitmentImportMappingSchema,
  recruitmentImportPreviewSchema,
  recruitmentJobClusterSchema,
  recruitmentSearchProfileInputSchema,
  recruitmentSearchProfileSchema,
  recruitmentSourceSchema,
  recruitmentSyncResultSchema,
  recruitmentWorkflowUpdateSchema,
  recordChangeSchema,
  ruleRepairProposalSchema,
  ruleVersionSchema,
  runLogEntrySchema,
  runRequestEntrySchema,
  runtimeCapabilitiesSchema,
  runtimeMetadataSchema,
  scheduleSchema,
  taskCreateSchema,
  taskDetailSchema,
  taskListItemSchema,
  taskHealthSchema,
  taskTemplateSchema,
  taskUpdateSchema,
  trendItemSchema,
  trendSourceSchema,
  trendSourceUpdateSchema,
  trendTermSchema,
  trendsResponseSchema,
} from '@zhiyun/contracts';

function idempotencyHeader() {
  return {
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 200 },
  };
}

function ifMatchHeader() {
  return {
    name: 'If-Match',
    in: 'header',
    required: true,
    schema: { type: 'string', pattern: '^"[1-9]\\d*"$' },
  };
}

function analysisMethodDescriptorOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'version',
      'category',
      'titleKey',
      'descriptionKey',
      'supportedFieldTypes',
      'parameterSchema',
      'outputSchema',
      'recommendedVisualizations',
      'resourceLimits',
      'supportsSampling',
    ],
    properties: {
      id: { type: 'string' },
      version: { type: 'string' },
      category: { type: 'string' },
      titleKey: { type: 'string' },
      descriptionKey: { type: 'string' },
      supportedFieldTypes: { type: 'array', items: { type: 'string' } },
      parameterSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      recommendedVisualizations: { type: 'array', items: { type: 'string' } },
      resourceLimits: { type: 'object', additionalProperties: true },
      supportsSampling: { type: 'boolean' },
    },
  };
}

function analysisRecipeInputOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'datasetId', 'methodId', 'methodVersion', 'parameters'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      datasetId: { type: 'string', format: 'uuid' },
      methodId: { type: 'string' },
      methodVersion: { type: 'string' },
      parameters: { type: 'object', additionalProperties: true },
    },
  };
}

function analysisRecipeOpenApiSchema() {
  const input = analysisRecipeInputOpenApiSchema();
  return {
    ...input,
    required: [...input.required, 'id', 'revision', 'createdAt', 'updatedAt'],
    properties: {
      ...input.properties,
      id: { type: 'string', format: 'uuid' },
      revision: { type: 'integer', minimum: 1 },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  };
}

function analysisJobInputOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['datasetId', 'snapshotId', 'methodId', 'methodVersion', 'parameters'],
    properties: {
      recipeId: { type: ['string', 'null'], format: 'uuid' },
      datasetId: { type: 'string', format: 'uuid' },
      snapshotId: { type: 'string', format: 'uuid' },
      methodId: { type: 'string' },
      methodVersion: { type: 'string' },
      parameters: { type: 'object', additionalProperties: true },
    },
  };
}

function analysisSamplingOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    required: ['applied', 'inputRows', 'sampleRows', 'seed'],
    properties: {
      applied: { type: 'boolean' },
      inputRows: { type: 'integer', minimum: 0 },
      sampleRows: { type: 'integer', minimum: 0 },
      seed: { type: ['integer', 'null'] },
      strategy: { type: 'string' },
    },
  };
}

function analysisJobOpenApiSchema() {
  const input = analysisJobInputOpenApiSchema();
  return {
    ...input,
    required: [
      ...input.required,
      'id',
      'state',
      'phase',
      'progress',
      'attempt',
      'sampling',
      'resultId',
      'error',
      'createdAt',
      'startedAt',
      'completedAt',
    ],
    properties: {
      ...input.properties,
      id: { type: 'string', format: 'uuid' },
      state: {
        type: 'string',
        enum: [
          'queued',
          'claimed',
          'running',
          'persisting',
          'canceling',
          'canceled',
          'interrupted',
          'succeeded',
          'failed',
        ],
      },
      phase: { type: 'string' },
      progress: { type: 'number', minimum: 0, maximum: 1 },
      attempt: { type: 'integer', minimum: 0 },
      sampling: analysisSamplingOpenApiSchema(),
      resultId: { type: ['string', 'null'], format: 'uuid' },
      error: { type: ['object', 'null'], additionalProperties: true },
      createdAt: { type: 'string', format: 'date-time' },
      startedAt: { type: ['string', 'null'], format: 'date-time' },
      completedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  };
}

function analysisResultOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'jobId',
      'datasetId',
      'snapshotId',
      'methodId',
      'methodVersion',
      'summary',
      'metrics',
      'tables',
      'series',
      'artifacts',
      'warnings',
      'sampling',
      'workerVersion',
      'createdAt',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      jobId: { type: 'string', format: 'uuid' },
      datasetId: { type: 'string', format: 'uuid' },
      snapshotId: { type: 'string', format: 'uuid' },
      methodId: { type: 'string' },
      methodVersion: { type: 'string' },
      summary: { type: 'object', additionalProperties: true },
      metrics: { type: 'object', additionalProperties: true },
      tables: { type: 'array', items: { type: 'object', additionalProperties: true } },
      series: { type: 'array', items: { type: 'object', additionalProperties: true } },
      artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
      warnings: { type: 'array', items: { type: 'string' } },
      sampling: analysisSamplingOpenApiSchema(),
      workerVersion: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  };
}

function corpusInputOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'datasetId'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      datasetId: { type: 'string', format: 'uuid' },
    },
  };
}

function corpusOpenApiSchema() {
  const input = corpusInputOpenApiSchema();
  return {
    ...input,
    required: [...input.required, 'id', 'revision', 'createdAt', 'updatedAt'],
    properties: {
      ...input.properties,
      id: { type: 'string', format: 'uuid' },
      revision: { type: 'integer', minimum: 1 },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  };
}

function corpusRecipeInputOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'name',
      'snapshotPolicy',
      'selectedTextFields',
      'metadataFields',
      'stripHtml',
      'unicodeNormalization',
      'deduplication',
      'nearDuplicateThreshold',
      'chunkSize',
      'chunkOverlap',
      'languagePolicy',
      'outputFormats',
    ],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      snapshotPolicy: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['mode'],
            properties: { mode: { const: 'latest' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'snapshotId'],
            properties: {
              mode: { const: 'pinned' },
              snapshotId: { type: 'string', format: 'uuid' },
            },
          },
        ],
      },
      selectedTextFields: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
        items: { type: 'string' },
      },
      metadataFields: {
        type: 'array',
        maxItems: 100,
        uniqueItems: true,
        items: { type: 'string' },
      },
      stripHtml: { type: 'boolean' },
      unicodeNormalization: { type: 'string', enum: ['NFC', 'NFKC'] },
      deduplication: { type: 'string', enum: ['none', 'exact', 'exact-and-near'] },
      nearDuplicateThreshold: { type: 'number', minimum: 0.5, maximum: 1 },
      chunkSize: { type: 'integer', minimum: 100, maximum: 10000 },
      chunkOverlap: { type: 'integer', minimum: 0, maximum: 2000 },
      languagePolicy: { type: 'string', enum: ['zh-en-first', 'generic'] },
      outputFormats: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', enum: ['parquet', 'jsonl', 'markdown'] },
      },
    },
  };
}

function corpusRecipeOpenApiSchema() {
  const input = corpusRecipeInputOpenApiSchema();
  return {
    ...input,
    required: [
      ...input.required,
      'id',
      'corpusId',
      'datasetId',
      'revision',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      ...input.properties,
      id: { type: 'string', format: 'uuid' },
      corpusId: { type: 'string', format: 'uuid' },
      datasetId: { type: 'string', format: 'uuid' },
      revision: { type: 'integer', minimum: 1 },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  };
}

function corpusBuildOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'corpusId',
      'recipeId',
      'recipeRevision',
      'datasetId',
      'snapshotId',
      'versionId',
      'state',
      'phase',
      'progress',
      'attempt',
      'error',
      'createdAt',
      'startedAt',
      'completedAt',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      corpusId: { type: 'string', format: 'uuid' },
      recipeId: { type: 'string', format: 'uuid' },
      recipeRevision: { type: 'integer', minimum: 1 },
      datasetId: { type: 'string', format: 'uuid' },
      snapshotId: { type: 'string', format: 'uuid' },
      versionId: { type: ['string', 'null'], format: 'uuid' },
      state: {
        type: 'string',
        enum: [
          'queued',
          'claimed',
          'running',
          'persisting',
          'canceling',
          'canceled',
          'interrupted',
          'succeeded',
          'failed',
        ],
      },
      phase: { type: 'string' },
      progress: { type: 'number', minimum: 0, maximum: 1 },
      attempt: { type: 'integer', minimum: 0 },
      error: { type: ['object', 'null'], additionalProperties: true },
      createdAt: { type: 'string', format: 'date-time' },
      startedAt: { type: ['string', 'null'], format: 'date-time' },
      completedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  };
}

function corpusVersionOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'corpusId',
      'buildId',
      'datasetId',
      'snapshotId',
      'snapshotFingerprint',
      'recipeId',
      'recipeRevision',
      'fingerprint',
      'workerVersion',
      'stats',
      'artifacts',
      'createdAt',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      corpusId: { type: 'string', format: 'uuid' },
      buildId: { type: 'string', format: 'uuid' },
      datasetId: { type: 'string', format: 'uuid' },
      snapshotId: { type: 'string', format: 'uuid' },
      snapshotFingerprint: { type: 'string' },
      recipeId: { type: 'string', format: 'uuid' },
      recipeRevision: { type: 'integer', minimum: 1 },
      fingerprint: { type: 'string' },
      workerVersion: { type: 'string' },
      stats: { type: 'object', additionalProperties: true },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'kind', 'contentType', 'filename', 'checksum', 'size'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            kind: { type: 'string' },
            contentType: { type: 'string' },
            filename: { type: 'string' },
            checksum: { type: 'string' },
            size: { type: 'integer', minimum: 0 },
          },
        },
      },
      createdAt: { type: 'string', format: 'date-time' },
    },
  };
}

function identityUserOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'email', 'displayName', 'role', 'disabled', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      displayName: { type: 'string' },
      role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
      disabled: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  };
}

function identityInvitationOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'email',
      'role',
      'expiresAt',
      'createdBy',
      'acceptedAt',
      'revokedAt',
      'createdAt',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
      expiresAt: { type: 'string', format: 'date-time' },
      createdBy: { type: 'string', format: 'uuid' },
      acceptedAt: { type: ['string', 'null'], format: 'date-time' },
      revokedAt: { type: ['string', 'null'], format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  };
}

function identityAuditEventOpenApiSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'actorUserId',
      'operationId',
      'resourceType',
      'resourceId',
      'result',
      'traceId',
      'networkHash',
      'details',
      'occurredAt',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      actorUserId: { type: ['string', 'null'], format: 'uuid' },
      operationId: { type: 'string' },
      resourceType: { type: 'string' },
      resourceId: { type: ['string', 'null'] },
      result: { type: 'string', enum: ['succeeded', 'failed', 'denied'] },
      traceId: { type: ['string', 'null'] },
      networkHash: { type: ['string', 'null'] },
      details: {},
      occurredAt: { type: 'string', format: 'date-time' },
    },
  };
}

export function openApiDocument(profileId = 'desktop-studio') {
  const paths: Record<string, Record<string, Record<string, unknown>>> = {
    '/health': { get: { operationId: 'getHealth' } },
    '/ready': { get: { operationId: 'getReadiness' } },
    '/api/v2/session': { post: { operationId: 'createRuntimeSession' } },
    '/api/v2/version': { get: { operationId: 'getVersion' } },
    '/api/v2/capabilities': { get: { operationId: 'getCapabilities' } },
    '/api/v2/runtime': { get: { operationId: 'getRuntimeMetadata' } },
    '/api/v2/runtime/graph': { get: { operationId: 'getRuntimeGraph' } },
    '/api/v2/openapi.json': { get: { operationId: 'getOpenApiDocument' } },
    '/api/v2/trend-sources': {
      get: { operationId: 'listTrendSources' },
    },
    '/api/v2/trend-sources/bootstrap': { post: { operationId: 'bootstrapTrendSources' } },
    '/api/v2/trend-sources/run': { post: { operationId: 'runTrendSources' } },
    '/api/v2/trend-sources/{key}': { put: { operationId: 'updateTrendSource' } },
    '/api/v2/trend-sources/{key}/run': { post: { operationId: 'runTrendSource' } },
    '/api/v2/trends': { get: { operationId: 'listTrends' } },
    '/api/v2/preferences/profile': { get: { operationId: 'getPreferenceProfile' } },
    '/api/v2/preferences/signals': {
      get: { operationId: 'listPreferenceSignals' },
      post: { operationId: 'upsertPreferenceSignal' },
      delete: { operationId: 'clearPreferenceSignals' },
    },
    '/api/v2/preferences/signals/{id}': { delete: { operationId: 'deletePreferenceSignal' } },
    '/api/v2/preferences/import': { post: { operationId: 'importPreferenceContent' } },
    '/api/v2/recruitment/sources': {
      get: { operationId: 'listRecruitmentSources' },
    },
    '/api/v2/recruitment/sources/{sourceKey}': {
      get: { operationId: 'getRecruitmentSource' },
    },
    '/api/v2/recruitment/sources/{sourceKey}/sync': {
      post: { operationId: 'syncRecruitmentSource' },
    },
    '/api/v2/recruitment/search-profiles': {
      get: { operationId: 'listRecruitmentSearchProfiles' },
      post: { operationId: 'createRecruitmentSearchProfile' },
    },
    '/api/v2/recruitment/search-profiles/{profileId}': {
      get: { operationId: 'getRecruitmentSearchProfile' },
      patch: { operationId: 'updateRecruitmentSearchProfile' },
      delete: { operationId: 'deleteRecruitmentSearchProfile' },
    },
    '/api/v2/recruitment/imports/preview': {
      post: { operationId: 'previewRecruitmentImport' },
    },
    '/api/v2/recruitment/imports': {
      post: { operationId: 'createRecruitmentImport' },
    },
    '/api/v2/recruitment/imports/{importId}': {
      get: { operationId: 'getRecruitmentImport' },
    },
    '/api/v2/recruitment/imports/{importId}/errors': {
      get: { operationId: 'getRecruitmentImportErrors' },
    },
    '/api/v2/recruitment/import-mappings': {
      get: { operationId: 'listRecruitmentImportMappings' },
      post: { operationId: 'createRecruitmentImportMapping' },
    },
    '/api/v2/recruitment/import-mappings/{mappingId}': {
      patch: { operationId: 'updateRecruitmentImportMapping' },
      delete: { operationId: 'deleteRecruitmentImportMapping' },
    },
    '/api/v2/recruitment/job-clusters': {
      get: { operationId: 'listRecruitmentJobClusters' },
    },
    '/api/v2/recruitment/job-clusters/{clusterId}': {
      get: { operationId: 'getRecruitmentJobCluster' },
    },
    '/api/v2/recruitment/job-clusters/{clusterId}/state': {
      put: { operationId: 'updateRecruitmentWorkflowState' },
    },
    '/api/v2/recruitment/job-clusters/merge': {
      post: { operationId: 'mergeRecruitmentJobClusters' },
    },
    '/api/v2/recruitment/job-clusters/{clusterId}/split': {
      post: { operationId: 'splitRecruitmentJobCluster' },
    },
    '/api/v2/tasks': {
      get: { operationId: 'listTasks' },
      post: { operationId: 'createTask' },
    },
    '/api/v2/rules/preview': { post: { operationId: 'previewInitialRule' } },
    '/api/v2/tasks/initialize': { post: { operationId: 'createTaskWithInitialRule' } },
    '/api/v2/schedules/preview': { post: { operationId: 'previewSchedule' } },
    '/api/v2/task-health': { get: { operationId: 'listTaskHealth' } },
    '/api/v2/tasks/{id}/quality-policy': {
      get: { operationId: 'getTaskQualityPolicy' },
      put: { operationId: 'updateTaskQualityPolicy' },
    },
    '/api/v2/tasks/{id}/health': { get: { operationId: 'getTaskHealth' } },
    '/api/v2/tasks/{id}/quality-evaluations': {
      get: { operationId: 'listTaskQualityEvaluations' },
    },
    '/api/v2/task-templates': { get: { operationId: 'listTaskTemplates' } },
    '/api/v2/task-templates/{templateId}': { get: { operationId: 'getTaskTemplate' } },
    '/api/v2/task-templates/{templateId}/instantiate': {
      post: { operationId: 'instantiateTaskTemplate' },
    },
    '/api/v2/auth/status': { get: { operationId: 'getAuthStatus' } },
    '/api/v2/auth/setup': { post: { operationId: 'setupAuth' } },
    '/api/v2/auth/login': { post: { operationId: 'login' } },
    '/api/v2/auth/logout': { post: { operationId: 'logout' } },
    '/api/v2/auth/me': { get: { operationId: 'getCurrentUser' } },
    '/api/v2/auth/password': { post: { operationId: 'changePassword' } },
    '/api/v2/members': { get: { operationId: 'listMembers' } },
    '/api/v2/members/{memberId}': { patch: { operationId: 'updateMember' } },
    '/api/v2/members/{memberId}/password-reset': {
      post: { operationId: 'createMemberPasswordReset' },
    },
    '/api/v2/invitations': {
      get: { operationId: 'listInvitations' },
      post: { operationId: 'createInvitation' },
    },
    '/api/v2/invitations/{invitationId}': {
      delete: { operationId: 'deleteInvitation' },
    },
    '/api/v2/invitations/accept': { post: { operationId: 'acceptInvitation' } },
    '/api/v2/audit-events': { get: { operationId: 'listAuditEvents' } },
    '/api/v2/tasks/{id}': {
      get: { operationId: 'getTask' },
      put: { operationId: 'updateTask' },
      delete: { operationId: 'deleteTask' },
    },
    '/api/v2/tasks/{id}/rule-analysis': { post: { operationId: 'analyzeTaskRule' } },
    '/api/v2/rules/analyze': { post: { operationId: 'analyzeDraftTaskRule' } },
    '/api/v2/tasks/{id}/ai/extract': { post: { operationId: 'runAiExtractDemo' } },
    '/api/v2/rules/ai-extract': { post: { operationId: 'extractDraftTaskWithAi' } },
    '/api/v2/crawler-assistant/conversations': {
      get: { operationId: 'listCrawlerAssistantConversations' },
      post: { operationId: 'createCrawlerAssistantConversation' },
    },
    '/api/v2/crawler-assistant/conversations/{id}': {
      get: { operationId: 'getCrawlerAssistantConversation' },
      delete: { operationId: 'deleteCrawlerAssistantConversation' },
    },
    '/api/v2/crawler-assistant/conversations/{id}/messages': {
      get: { operationId: 'listCrawlerAssistantMessages' },
      post: { operationId: 'postCrawlerAssistantMessage' },
    },
    '/api/v2/crawler-assistant/conversations/{id}/site-selection': {
      post: { operationId: 'selectCrawlerAssistantSite' },
    },
    '/api/v2/crawler-assistant/conversations/{id}/draft/test': {
      post: { operationId: 'testCrawlerAssistantDraft' },
    },
    '/api/v2/crawler-assistant/conversations/{id}/commit': {
      post: { operationId: 'commitCrawlerAssistantDraft' },
    },
    '/api/v2/crawler-assistant/turns/{id}/cancel': {
      post: { operationId: 'cancelCrawlerAssistantTurn' },
    },
    '/api/v2/crawler-assistant/turns/{id}/retry': {
      post: { operationId: 'retryCrawlerAssistantTurn' },
    },
    '/api/v2/ai/provider': {
      get: { operationId: 'getAiProviderSettings' },
      put: { operationId: 'updateAiProviderSettings' },
    },
    '/api/v2/ai/provider/credential/prompt': {
      post: { operationId: 'promptAiProviderCredential' },
    },
    '/api/v2/ai/provider/credential': {
      delete: { operationId: 'deleteAiProviderCredential' },
    },
    '/api/v2/ai/provider/test': { post: { operationId: 'testAiProviderSettings' } },
    '/api/v2/tasks/{id}/browser-session/login': {
      post: { operationId: 'createTaskLoginSession' },
    },
    '/api/v2/tasks/{id}/credentials/{kind}': {
      post: { operationId: 'promptTaskCredential' },
      delete: { operationId: 'deleteTaskCredential' },
    },
    '/api/v2/tasks/{id}/rules': {
      get: { operationId: 'listRules' },
      post: { operationId: 'createRule' },
    },
    '/api/v2/tasks/{id}/rules/test': { post: { operationId: 'testRule' } },
    '/api/v2/tasks/{id}/rules/{ruleId}/versions': {
      post: { operationId: 'createRuleVersion' },
    },
    '/api/v2/tasks/{id}/rules/{ruleId}/diff': {
      get: { operationId: 'diffRuleVersions' },
    },
    '/api/v2/tasks/{id}/rules/{ruleId}/rollback': {
      post: { operationId: 'rollbackRuleVersion' },
    },
    '/api/v2/tasks/{id}/rules/{ruleId}/repair-proposals': {
      get: { operationId: 'listRuleRepairProposals' },
      post: { operationId: 'createRuleRepairProposal' },
    },
    '/api/v2/tasks/{id}/rules/{ruleId}/repair-proposals/{proposalId}/test': {
      post: { operationId: 'testRuleRepairProposal' },
    },
    '/api/v2/tasks/{id}/rules/{ruleId}/repair-proposals/{proposalId}/apply': {
      post: { operationId: 'applyRuleRepairProposal' },
    },
    '/api/v2/tasks/{id}/rules/{ruleId}/repair-proposals/{proposalId}/reject': {
      post: { operationId: 'rejectRuleRepairProposal' },
    },
    '/api/v2/tasks/{id}/runs': {
      get: { operationId: 'listRuns' },
      post: { operationId: 'createRun' },
    },
    '/api/v2/datasets': { get: { operationId: 'listDatasets' } },
    '/api/v2/datasets/{datasetId}': { get: { operationId: 'getDataset' } },
    '/api/v2/datasets/{datasetId}/records': {
      get: { operationId: 'listDatasetRecords' },
    },
    '/api/v2/datasets/{datasetId}/changes': {
      get: { operationId: 'listDatasetChanges' },
    },
    '/api/v2/datasets/{datasetId}/diff': { get: { operationId: 'diffDataset' } },
    '/api/v2/datasets/{datasetId}/exports': { post: { operationId: 'exportDataset' } },
    '/api/v2/datasets/{datasetId}/snapshots': {
      get: { operationId: 'listDatasetSnapshots' },
      post: { operationId: 'createDatasetSnapshot' },
    },
    '/api/v2/datasets/{datasetId}/snapshots/{snapshotId}': {
      get: { operationId: 'getDatasetSnapshot' },
    },
    '/api/v2/runs/{id}': { get: { operationId: 'getRun' } },
    '/api/v2/runs/{id}/cancel': { post: { operationId: 'cancelRun' } },
    '/api/v2/runs/{id}/retry': { post: { operationId: 'retryRun' } },
    '/api/v2/runs/{id}/explain-failure': { post: { operationId: 'explainRunFailure' } },
    '/api/v2/runs/{id}/logs': { get: { operationId: 'listRunLogs' } },
    '/api/v2/runs/{id}/requests': { get: { operationId: 'listRunRequests' } },
    '/api/v2/runs/{id}/records': { get: { operationId: 'listRunRecords' } },
    '/api/v2/runs/{id}/exports': { post: { operationId: 'createRunExport' } },
    '/api/v2/artifacts/{id}/save': { post: { operationId: 'saveArtifact' } },
    '/api/v2/artifacts/{id}/content': { get: { operationId: 'getArtifactContent' } },
    '/api/v2/events/domain': { get: { operationId: 'streamDomainEvents' } },
    '/api/v2/events/realtime': { get: { operationId: 'streamRealtimeEvents' } },
    '/api/v2/output-destinations': {
      get: { operationId: 'listOutputDestinations' },
      post: { operationId: 'createOutputDestination' },
    },
    '/api/v2/output-destinations/{id}': {
      get: { operationId: 'getOutputDestination' },
      put: { operationId: 'updateOutputDestination' },
      delete: { operationId: 'deleteOutputDestination' },
    },
    '/api/v2/output-destinations/{id}/test': {
      post: { operationId: 'testOutputDestination' },
    },
    '/api/v2/output-destinations/{id}/credential/prompt': {
      post: { operationId: 'promptOutputCredential' },
    },
    '/api/v2/delivery-attempts/{id}/retry': {
      post: { operationId: 'retryOutputDelivery' },
    },
    '/api/v2/delivery-attempts': { get: { operationId: 'listDeliveryAttempts' } },
    '/api/v2/api-tokens': {
      get: { operationId: 'listApiTokens' },
      post: { operationId: 'createApiToken' },
    },
    '/api/v2/api-tokens/{id}': { delete: { operationId: 'revokeApiToken' } },
    '/api/v2/data/tasks/{id}/records': { get: { operationId: 'queryDataApiRecords' } },
    '/api/v2/analytics/methods': { get: { operationId: 'listAnalysisMethods' } },
    '/api/v2/analytics/recipes': {
      get: { operationId: 'listAnalysisRecipes' },
      post: { operationId: 'createAnalysisRecipe' },
    },
    '/api/v2/analytics/recipes/{recipeId}': {
      get: { operationId: 'getAnalysisRecipe' },
      put: { operationId: 'updateAnalysisRecipe' },
      delete: { operationId: 'deleteAnalysisRecipe' },
    },
    '/api/v2/analytics/jobs': {
      get: { operationId: 'listAnalysisJobs' },
      post: { operationId: 'createAnalysisJob' },
    },
    '/api/v2/analytics/jobs/{jobId}': { get: { operationId: 'getAnalysisJob' } },
    '/api/v2/analytics/jobs/{jobId}/cancel': { post: { operationId: 'cancelAnalysisJob' } },
    '/api/v2/analytics/jobs/{jobId}/retry': { post: { operationId: 'retryAnalysisJob' } },
    '/api/v2/analytics/results/{resultId}': { get: { operationId: 'getAnalysisResult' } },
    '/api/v2/analytics/results/{resultId}/exports': {
      post: { operationId: 'exportAnalysisResult' },
    },
    '/api/v2/corpora': {
      get: { operationId: 'listCorpora' },
      post: { operationId: 'createCorpus' },
    },
    '/api/v2/corpora/{corpusId}': {
      get: { operationId: 'getCorpus' },
      put: { operationId: 'updateCorpus' },
      delete: { operationId: 'deleteCorpus' },
    },
    '/api/v2/corpora/{corpusId}/recipes': {
      get: { operationId: 'listCorpusRecipes' },
      post: { operationId: 'createCorpusRecipe' },
    },
    '/api/v2/corpora/{corpusId}/recipes/{recipeId}': {
      put: { operationId: 'updateCorpusRecipe' },
      delete: { operationId: 'deleteCorpusRecipe' },
    },
    '/api/v2/corpora/{corpusId}/builds': { post: { operationId: 'createCorpusBuild' } },
    '/api/v2/corpus-builds': { get: { operationId: 'listCorpusBuilds' } },
    '/api/v2/corpus-builds/{buildId}': { get: { operationId: 'getCorpusBuild' } },
    '/api/v2/corpus-builds/{buildId}/cancel': { post: { operationId: 'cancelCorpusBuild' } },
    '/api/v2/corpus-builds/{buildId}/retry': { post: { operationId: 'retryCorpusBuild' } },
    '/api/v2/corpora/{corpusId}/versions': { get: { operationId: 'listCorpusVersions' } },
    '/api/v2/corpora/{corpusId}/versions/{versionId}': {
      get: { operationId: 'getCorpusVersion' },
    },
    '/api/v2/corpora/{corpusId}/versions/{versionId}/exports': {
      post: { operationId: 'exportCorpusVersion' },
    },
    '/api/v2/inspection-sessions': { post: { operationId: 'createInspectionSession' } },
    '/api/v2/inspection-sessions/{sessionId}/screenshot': {
      get: { operationId: 'getInspectionScreenshot' },
    },
    '/api/v2/inspection-sessions/{sessionId}/actions': {
      post: { operationId: 'interactWithInspection' },
    },
    '/api/v2/inspection-sessions/{sessionId}/select': {
      post: { operationId: 'selectInspectionElement' },
    },
    '/api/v2/inspection-sessions/{sessionId}': {
      delete: { operationId: 'closeInspectionSession' },
    },
    '/api/v2/desktop/diagnostics': { get: { operationId: 'getDesktopDiagnostics' } },
    '/api/v2/runtime/summary': { get: { operationId: 'getRuntimeSummary' } },
    '/api/v2/scheduler/pause': { post: { operationId: 'pauseScheduler' } },
    '/api/v2/scheduler/resume': { post: { operationId: 'resumeScheduler' } },
  };
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const jsonResponse = (schema: Record<string, unknown>, description = 'Success') => ({
    description,
    content: { 'application/json': { schema } },
  });
  const problemResponse = jsonResponse(ref('ProblemDetails'), 'Problem Details');
  const responses = (schema: Record<string, unknown>, status = '200') => ({
    [status]: jsonResponse(schema),
    default: problemResponse,
  });
  const body = (schema: Record<string, unknown>) => ({
    required: true,
    content: { 'application/json': { schema } },
  });
  const page = (item: Record<string, unknown>, extras: Record<string, unknown> = {}) => ({
    type: 'object',
    required: ['items', 'nextCursor', ...Object.keys(extras)],
    properties: {
      items: { type: 'array', items: item },
      nextCursor: { type: ['string', 'null'] },
      ...extras,
    },
  });
  const appendParameters = (
    operation: Record<string, unknown>,
    ...parameters: Array<Record<string, unknown>>
  ) => {
    operation.parameters = [
      ...((operation.parameters ?? []) as Array<Record<string, unknown>>),
      ...parameters,
    ];
  };

  for (const [path, pathItem] of Object.entries(paths)) {
    const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    for (const operation of Object.values(pathItem)) {
      operation.security ??= [{ sessionBearer: [] }];
      operation.parameters ??= pathNames.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: {
          type: 'string',
          format: [
            'id',
            'ruleId',
            'proposalId',
            'recipeId',
            'jobId',
            'resultId',
            'corpusId',
            'buildId',
            'versionId',
            'sessionId',
          ].includes(name)
            ? 'uuid'
            : undefined,
        },
      }));
      operation.responses ??= {
        '200': { description: 'Success' },
        default: problemResponse,
      };
    }
  }

  Object.assign(paths['/api/v2/session']!.post!, {
    security: [],
    requestBody: body({
      type: 'object',
      properties: { nonce: { type: 'string' }, adminToken: { type: 'string' } },
    }),
    responses: responses({
      type: 'object',
      required: ['token', 'runtime', 'capabilities'],
      properties: {
        token: { type: 'string' },
        runtime: ref('RuntimeMetadata'),
        capabilities: ref('RuntimeCapabilities'),
      },
    }),
  });
  for (const publicPath of [
    '/api/v2/version',
    '/api/v2/runtime',
    '/api/v2/runtime/graph',
    '/api/v2/openapi.json',
  ]) {
    paths[publicPath]!.get!.security = [];
  }
  paths['/api/v2/runtime']!.get!.responses = responses(ref('RuntimeMetadata'));
  paths['/api/v2/runtime/graph']!.get!.responses = responses({
    type: 'object',
    required: ['profileId', 'graphRevision', 'plugins', 'routes', 'uiContributions'],
    additionalProperties: false,
    properties: {
      profileId: { type: 'string' },
      graphRevision: { type: 'string' },
      plugins: { type: 'array', items: { type: 'object', additionalProperties: true } },
      routes: { type: 'array', items: { type: 'object', additionalProperties: true } },
      uiContributions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  });
  paths['/api/v2/capabilities']!.get!.responses = responses(ref('RuntimeCapabilities'));
  paths['/ready']!.get!.responses = responses({
    type: 'object',
    additionalProperties: false,
    required: ['status', 'checks'],
    properties: {
      status: { type: 'string', enum: ['ready', 'not-ready'] },
      checks: {
        type: 'object',
        additionalProperties: false,
        required: ['database', 'redis', 'queue', 'browser', 'analyticsWorker'],
        properties: Object.fromEntries(
          ['database', 'redis', 'queue', 'browser', 'analyticsWorker'].map((name) => [
            name,
            {
              type: 'object',
              required: ['status'],
              properties: { status: { type: 'string' } },
              additionalProperties: true,
            },
          ]),
        ),
      },
    },
  });
  paths['/api/v2/runtime/summary']!.get!.responses = responses({
    type: 'object',
    additionalProperties: false,
    required: [
      'schedulingPaused',
      'startedAt',
      'uptimeSeconds',
      'queueBacklog',
      'jobsByState',
      'jobs',
      'analyticsWorkerStatus',
    ],
    properties: {
      schedulingPaused: { type: 'boolean' },
      startedAt: { type: 'string', format: 'date-time' },
      uptimeSeconds: { type: 'integer', minimum: 0 },
      queueBacklog: { type: 'integer', minimum: 0 },
      jobsByState: {
        type: 'object',
        additionalProperties: { type: 'integer', minimum: 0 },
      },
      jobs: { type: 'array', items: { type: 'object', additionalProperties: true } },
      analyticsWorkerStatus: {
        type: 'string',
        enum: ['starting', 'ready', 'degraded', 'unavailable'],
      },
    },
  });
  paths['/api/v2/trend-sources']!.get!.responses = responses({
    type: 'array',
    items: ref('TrendSource'),
  });
  paths['/api/v2/trend-sources/bootstrap']!.post!.responses = {
    '202': jsonResponse({
      type: 'object',
      required: ['sources', 'runs'],
      properties: {
        sources: { type: 'array', items: ref('TrendSource') },
        runs: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    }),
    default: problemResponse,
  };
  paths['/api/v2/trend-sources/run']!.post!.responses = {
    '202': jsonResponse({
      type: 'object',
      required: ['runs'],
      properties: {
        runs: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    }),
    default: problemResponse,
  };
  Object.assign(paths['/api/v2/trend-sources/{key}']!.put!, {
    requestBody: body(ref('TrendSourceUpdate')),
    responses: responses(ref('TrendSource')),
  });
  paths['/api/v2/trend-sources/{key}/run']!.post!.responses = {
    '200': jsonResponse({ type: 'object', additionalProperties: true }),
    '202': jsonResponse({ type: 'object', additionalProperties: true }),
    default: problemResponse,
  };
  Object.assign(paths['/api/v2/trends']!.get!, {
    parameters: [
      { name: 'platform', in: 'query', schema: { type: 'string' } },
      { name: 'contentType', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
    ],
    responses: responses(ref('TrendsResponse')),
  });
  paths['/api/v2/preferences/profile']!.get!.responses = responses(ref('PreferenceProfile'));
  Object.assign(paths['/api/v2/preferences/signals']!.get!, {
    parameters: [
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
    ],
    responses: responses(page(ref('PreferenceSignal'))),
  });
  Object.assign(paths['/api/v2/preferences/signals']!.post!, {
    requestBody: body(ref('PreferenceSignalInput')),
    responses: responses(ref('PreferenceSignal')),
  });
  paths['/api/v2/preferences/signals']!.delete!.responses = responses({
    type: 'object',
    required: ['deleted'],
    properties: { deleted: { type: 'integer' } },
  });
  paths['/api/v2/preferences/signals/{id}']!.delete!.responses = {
    '204': { description: 'Deleted' },
    default: problemResponse,
  };
  Object.assign(paths['/api/v2/preferences/import']!.post!, {
    requestBody: body(ref('PreferenceImport')),
    responses: responses(ref('PreferenceSignal'), '201'),
  });
  const recruitmentSourceView = {
    allOf: [
      ref('RecruitmentSource'),
      {
        type: 'object',
        required: ['searchUrl'],
        properties: { searchUrl: { type: 'string', format: 'uri' } },
      },
    ],
  };
  Object.assign(paths['/api/v2/recruitment/sources']!.get!, {
    parameters: [{ name: 'profileId', in: 'query', schema: { type: 'string', format: 'uuid' } }],
    responses: responses({ type: 'array', items: recruitmentSourceView }),
  });
  Object.assign(paths['/api/v2/recruitment/sources/{sourceKey}']!.get!, {
    parameters: [
      {
        name: 'sourceKey',
        in: 'path',
        required: true,
        schema: { type: 'string', enum: ['boss', 'liepin', 'huibo'] },
      },
      { name: 'profileId', in: 'query', schema: { type: 'string', format: 'uuid' } },
    ],
    responses: responses(recruitmentSourceView),
  });
  paths['/api/v2/recruitment/sources/{sourceKey}/sync']!.post!.responses = {
    '202': jsonResponse(ref('RecruitmentSyncResult')),
    '409': problemResponse,
    default: problemResponse,
  };
  paths['/api/v2/recruitment/search-profiles']!.get!.responses = responses({
    type: 'array',
    items: ref('RecruitmentSearchProfile'),
  });
  Object.assign(paths['/api/v2/recruitment/search-profiles']!.post!, {
    requestBody: body(ref('RecruitmentSearchProfileInput')),
    responses: responses(ref('RecruitmentSearchProfile'), '201'),
  });
  paths['/api/v2/recruitment/search-profiles/{profileId}']!.get!.responses = responses(
    ref('RecruitmentSearchProfile'),
  );
  Object.assign(paths['/api/v2/recruitment/search-profiles/{profileId}']!.patch!, {
    requestBody: body({
      type: 'object',
      required: ['revision', 'profile'],
      properties: {
        revision: { type: 'integer', minimum: 1 },
        profile: ref('RecruitmentSearchProfileInput'),
      },
    }),
    responses: responses(ref('RecruitmentSearchProfile')),
  });
  paths['/api/v2/recruitment/search-profiles/{profileId}']!.delete!.responses = {
    '204': { description: 'Deleted' },
    default: problemResponse,
  };
  Object.assign(paths['/api/v2/recruitment/imports/preview']!.post!, {
    requestBody: body(ref('RecruitmentFileInput')),
    responses: responses(ref('RecruitmentImportPreview')),
  });
  Object.assign(paths['/api/v2/recruitment/imports']!.post!, {
    requestBody: body(ref('RecruitmentFileInput')),
    responses: responses(ref('RecruitmentImportJob'), '201'),
  });
  paths['/api/v2/recruitment/imports/{importId}']!.get!.responses = responses(
    ref('RecruitmentImportJob'),
  );
  paths['/api/v2/recruitment/imports/{importId}/errors']!.get!.responses = responses({
    type: 'object',
    required: ['items', 'artifactId'],
    properties: {
      items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      artifactId: { type: ['string', 'null'], format: 'uuid' },
    },
  });
  paths['/api/v2/recruitment/import-mappings']!.get!.responses = responses({
    type: 'array',
    items: ref('RecruitmentImportMapping'),
  });
  Object.assign(paths['/api/v2/recruitment/import-mappings']!.post!, {
    requestBody: body(ref('RecruitmentImportMappingInput')),
    responses: responses(ref('RecruitmentImportMapping'), '201'),
  });
  Object.assign(paths['/api/v2/recruitment/import-mappings/{mappingId}']!.patch!, {
    requestBody: body({
      type: 'object',
      required: ['revision', 'mapping'],
      properties: {
        revision: { type: 'integer', minimum: 1 },
        mapping: ref('RecruitmentImportMappingInput'),
      },
    }),
    responses: responses(ref('RecruitmentImportMapping')),
  });
  paths['/api/v2/recruitment/import-mappings/{mappingId}']!.delete!.responses = {
    '204': { description: 'Deleted' },
    default: problemResponse,
  };
  Object.assign(paths['/api/v2/recruitment/job-clusters']!.get!, {
    parameters: [
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
      { name: 'profileId', in: 'query', schema: { type: 'string', format: 'uuid' } },
      {
        name: 'sourceKey',
        in: 'query',
        schema: { type: 'string', enum: ['boss', 'liepin', 'huibo'] },
      },
      { name: 'workflowState', in: 'query', schema: { type: 'string' } },
      { name: 'city', in: 'query', schema: { type: 'string' } },
      { name: 'keyword', in: 'query', schema: { type: 'string' } },
      { name: 'salaryMin', in: 'query', schema: { type: 'integer', minimum: 0 } },
      { name: 'salaryMax', in: 'query', schema: { type: 'integer', minimum: 0 } },
      { name: 'publishedAfter', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'publishedBefore', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'includeArchived', in: 'query', schema: { type: 'boolean' } },
    ],
    responses: responses(page(ref('RecruitmentJobCluster'))),
  });
  paths['/api/v2/recruitment/job-clusters/{clusterId}']!.get!.responses = responses(
    ref('RecruitmentJobCluster'),
  );
  Object.assign(paths['/api/v2/recruitment/job-clusters/{clusterId}/state']!.put!, {
    requestBody: body(ref('RecruitmentWorkflowUpdate')),
    responses: responses(ref('RecruitmentJobCluster')),
  });
  Object.assign(paths['/api/v2/recruitment/job-clusters/merge']!.post!, {
    requestBody: body({
      type: 'object',
      required: ['targetClusterId', 'sourceClusterIds'],
      properties: {
        targetClusterId: { type: 'string', format: 'uuid' },
        sourceClusterIds: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', format: 'uuid' },
        },
      },
    }),
    responses: responses(ref('RecruitmentJobCluster')),
  });
  Object.assign(paths['/api/v2/recruitment/job-clusters/{clusterId}/split']!.post!, {
    requestBody: body({
      type: 'object',
      required: ['postingIds'],
      properties: {
        postingIds: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', format: 'uuid' },
        },
      },
    }),
    responses: responses(ref('RecruitmentJobCluster')),
  });
  Object.assign(paths['/api/v2/tasks']!.get!, {
    parameters: [
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
    ],
    responses: responses(page(ref('TaskListItem'))),
  });
  Object.assign(paths['/api/v2/tasks']!.post!, {
    requestBody: body(ref('TaskCreate')),
    responses: responses(ref('TaskDetail'), '201'),
  });
  Object.assign(paths['/api/v2/schedules/preview']!.post!, {
    requestBody: body(ref('Schedule')),
    responses: responses({
      type: 'object',
      required: ['nextRuns'],
      properties: {
        nextRuns: {
          type: 'array',
          minItems: 5,
          maxItems: 5,
          items: { type: 'string', format: 'date-time' },
        },
      },
    }),
  });
  Object.assign(paths['/api/v2/inspection-sessions']!.post!, {
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: { taskId: { type: 'string', format: 'uuid' } },
    }),
    responses: responses(
      {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'url', 'expiresAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          url: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
      '201',
    ),
  });
  paths['/api/v2/inspection-sessions/{sessionId}/screenshot']!.get!.responses = responses({
    type: 'object',
    additionalProperties: false,
    required: ['url', 'image', 'width', 'height'],
    properties: {
      url: { type: 'string' },
      image: { type: 'string', contentEncoding: 'base64' },
      width: { type: 'integer', minimum: 1 },
      height: { type: 'integer', minimum: 1 },
    },
  });
  Object.assign(paths['/api/v2/inspection-sessions/{sessionId}/actions']!.post!, {
    requestBody: body({
      oneOf: [
        ref('InspectionStepInput'),
        {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ['click', 'scroll', 'refresh'] },
            x: { type: 'number' },
            y: { type: 'number' },
            deltaY: { type: 'number' },
          },
        },
      ],
    }),
    responses: responses({
      oneOf: [
        ref('InspectionStepResult'),
        {
          type: 'object',
          additionalProperties: false,
          required: ['url'],
          properties: { url: { type: 'string' } },
        },
      ],
    }),
  });
  Object.assign(paths['/api/v2/inspection-sessions/{sessionId}/select']!.post!, {
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: {
        x: { type: 'number', minimum: 0 },
        y: { type: 'number', minimum: 0 },
      },
    }),
    responses: responses(ref('InspectionElementSelection')),
  });
  Object.assign(paths['/api/v2/task-health']!.get!, {
    parameters: [
      {
        name: 'taskIds',
        in: 'query',
        required: true,
        schema: { type: 'string', description: 'Comma-separated task IDs, at most 100' },
      },
    ],
    responses: responses({ type: 'array', items: ref('TaskHealth') }),
  });
  paths['/api/v2/tasks/{id}/quality-policy']!.get!.responses = responses(ref('QualityPolicy'));
  Object.assign(paths['/api/v2/tasks/{id}/quality-policy']!.put!, {
    parameters: [idempotencyHeader()],
    requestBody: body(ref('QualityPolicy')),
    responses: responses(ref('QualityPolicy')),
  });
  paths['/api/v2/tasks/{id}/health']!.get!.responses = responses(ref('TaskHealth'));
  Object.assign(paths['/api/v2/tasks/{id}/quality-evaluations']!.get!, {
    parameters: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
    ],
    responses: responses({ type: 'array', items: ref('QualityEvaluation') }),
  });
  paths['/api/v2/task-templates']!.get!.responses = responses({
    type: 'array',
    items: ref('TaskTemplate'),
  });
  paths['/api/v2/task-templates/{templateId}']!.get!.responses = responses(ref('TaskTemplate'));
  Object.assign(paths['/api/v2/task-templates/{templateId}/instantiate']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['parameters'],
      anyOf: [{ required: ['startUrl'] }, { required: ['task'] }],
      properties: {
        startUrl: { type: 'string', format: 'uri' },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        instruction: { type: 'string', minLength: 1 },
        schedule: ref('Schedule'),
        task: ref('TaskCreate'),
        definition: ref('CrawlPlanDefinition'),
        previewKey: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 10 },
        saveAsDraft: { type: 'boolean', default: false },
        parameters: { type: 'object', additionalProperties: true },
      },
    }),
    responses: responses(ref('TaskDetail'), '201'),
  });
  paths['/api/v2/auth/status']!.get!.responses = responses({
    type: 'object',
    required: ['initialized'],
    properties: { initialized: { type: 'boolean' } },
  });
  const identityCredentialFields = {
    email: { type: 'string', format: 'email' },
    displayName: { type: 'string', minLength: 1, maxLength: 200 },
    password: { type: 'string', minLength: 12, writeOnly: true },
  };
  Object.assign(paths['/api/v2/auth/setup']!.post!, {
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['bootstrapToken', 'email', 'displayName', 'password'],
      properties: {
        bootstrapToken: { type: 'string', minLength: 32, writeOnly: true },
        ...identityCredentialFields,
      },
    }),
    responses: responses(ref('IdentityUser'), '201'),
  });
  Object.assign(paths['/api/v2/auth/login']!.post!, {
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['email', 'password'],
      properties: {
        email: identityCredentialFields.email,
        password: identityCredentialFields.password,
      },
    }),
    responses: responses({
      type: 'object',
      required: ['user', 'csrfToken', 'idleExpiresAt', 'absoluteExpiresAt'],
      properties: {
        user: ref('IdentityUser'),
        csrfToken: { type: 'string', writeOnly: true },
        idleExpiresAt: { type: 'string', format: 'date-time' },
        absoluteExpiresAt: { type: 'string', format: 'date-time' },
      },
    }),
  });
  paths['/api/v2/auth/logout']!.post!.parameters = [
    {
      name: 'X-CSRF-Token',
      in: 'header',
      required: true,
      schema: { type: 'string', minLength: 1 },
    },
  ];
  paths['/api/v2/auth/logout']!.post!.responses = {
    '204': { description: 'Logged out' },
    default: problemResponse,
  };
  paths['/api/v2/auth/me']!.get!.responses = responses({
    type: 'object',
    required: ['user', 'permissions', 'csrfToken', 'idleExpiresAt', 'absoluteExpiresAt'],
    properties: {
      user: ref('IdentityUser'),
      permissions: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      csrfToken: { type: 'string', writeOnly: true },
      idleExpiresAt: { type: 'string', format: 'date-time' },
      absoluteExpiresAt: { type: 'string', format: 'date-time' },
    },
  });
  Object.assign(paths['/api/v2/auth/password']!.post!, {
    requestBody: body({
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', writeOnly: true },
            newPassword: { type: 'string', minLength: 12, writeOnly: true },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['resetToken', 'newPassword'],
          properties: {
            resetToken: { type: 'string', writeOnly: true },
            newPassword: { type: 'string', minLength: 12, writeOnly: true },
          },
        },
      ],
    }),
    responses: { '204': { description: 'Password changed' }, default: problemResponse },
  });
  paths['/api/v2/members']!.get!.responses = responses({
    type: 'object',
    required: ['items'],
    properties: { items: { type: 'array', items: ref('IdentityUser') } },
  });
  Object.assign(paths['/api/v2/members/{memberId}']!.patch!, {
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
        disabled: { type: 'boolean' },
        displayName: { type: 'string', minLength: 1, maxLength: 200 },
      },
    }),
    responses: responses(ref('IdentityUser')),
  });
  paths['/api/v2/members/{memberId}/password-reset']!.post!.responses = responses(
    {
      type: 'object',
      required: ['token', 'expiresAt'],
      properties: {
        token: { type: 'string', writeOnly: true },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
    '201',
  );
  paths['/api/v2/invitations']!.get!.responses = responses({
    type: 'object',
    required: ['items'],
    properties: { items: { type: 'array', items: ref('IdentityInvitation') } },
  });
  Object.assign(paths['/api/v2/invitations']!.post!, {
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['email', 'role'],
      properties: {
        email: identityCredentialFields.email,
        role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
      },
    }),
    responses: responses(
      {
        type: 'object',
        required: ['invitation', 'token'],
        properties: {
          invitation: ref('IdentityInvitation'),
          token: { type: 'string', writeOnly: true },
        },
      },
      '201',
    ),
  });
  paths['/api/v2/invitations/{invitationId}']!.delete!.responses = {
    '204': { description: 'Invitation revoked' },
    default: problemResponse,
  };
  Object.assign(paths['/api/v2/invitations/accept']!.post!, {
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['token', 'displayName', 'password'],
      properties: {
        token: { type: 'string', writeOnly: true },
        displayName: identityCredentialFields.displayName,
        password: identityCredentialFields.password,
      },
    }),
    responses: responses(ref('IdentityUser'), '201'),
  });
  Object.assign(paths['/api/v2/audit-events']!.get!, {
    parameters: [
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
    ],
    responses: responses(page(ref('IdentityAuditEvent'))),
  });
  const initialRuleRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['task', 'definition'],
    properties: {
      task: ref('TaskCreate'),
      definition: ref('CrawlPlanDefinition'),
      ruleName: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
  };
  Object.assign(paths['/api/v2/rules/preview']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body(initialRuleRequest),
    responses: responses({
      type: 'object',
      required: ['records', 'previewKey'],
      properties: {
        records: { type: 'array', items: ref('ExtractedRecord') },
        previewKey: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
      },
    }),
  });
  Object.assign(paths['/api/v2/tasks/initialize']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body({
      ...initialRuleRequest,
      required: initialRuleRequest.required,
      properties: {
        ...initialRuleRequest.properties,
        previewKey: { type: 'string', minLength: 1, maxLength: 200 },
        runAfterCreate: { type: 'boolean', default: false },
        saveAsDraft: { type: 'boolean', default: false },
      },
    }),
    responses: responses(
      {
        type: 'object',
        required: ['task', 'run'],
        properties: {
          task: ref('TaskDetail'),
          run: { oneOf: [ref('CrawlRun'), { type: 'null' }] },
        },
      },
      '201',
    ),
  });
  paths['/api/v2/tasks/{id}']!.get!.responses = responses(ref('TaskDetail'));
  Object.assign(paths['/api/v2/tasks/{id}']!.put!, {
    requestBody: body(ref('TaskUpdate')),
    responses: responses(ref('TaskDetail')),
  });
  paths['/api/v2/tasks/{id}']!.delete!.responses = {
    '204': { description: 'Deleted' },
    default: problemResponse,
  };
  Object.assign(paths['/api/v2/tasks/{id}/rule-analysis']!.post!, {
    requestBody: body({
      type: 'object',
      required: ['useAi', 'forceBrowser'],
      properties: { useAi: { type: 'boolean' }, forceBrowser: { type: 'boolean' } },
    }),
    responses: responses(ref('RuleAnalysisResult')),
  });
  Object.assign(paths['/api/v2/rules/analyze']!.post!, {
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['task', 'useAi', 'forceBrowser'],
      properties: {
        task: ref('TaskCreate'),
        useAi: { type: 'boolean' },
        forceBrowser: { type: 'boolean' },
      },
    }),
    responses: responses(ref('RuleAnalysisResult')),
  });
  Object.assign(paths['/api/v2/rules/ai-extract']!.post!, {
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['task', 'definition'],
      properties: {
        task: ref('TaskCreate'),
        definition: ref('CrawlPlanDefinition'),
        instruction: { type: 'string' },
      },
    }),
    responses: responses({
      type: 'object',
      required: ['records', 'sourceUrl', 'persisted'],
      properties: {
        records: { type: 'array', items: { type: 'object', additionalProperties: true } },
        sourceUrl: { type: 'string', format: 'uri' },
        persisted: { type: 'boolean', const: false },
      },
    }),
  });
  paths['/api/v2/tasks/{id}/runs']!.get!.responses = responses(page(ref('CrawlRun')));
  paths['/api/v2/datasets/{datasetId}/records']!.get!.responses = responses(
    page(ref('DatasetRecord'), { stats: ref('DatasetStats') }),
  );
  paths['/api/v2/datasets/{datasetId}/changes']!.get!.responses = responses(
    page(ref('RecordChange')),
  );
  paths['/api/v2/tasks/{id}/runs']!.post!.responses = responses(
    {
      type: 'object',
      required: ['runId', 'status'],
      properties: { runId: { type: 'string', format: 'uuid' }, status: { type: 'string' } },
    },
    '202',
  );
  paths['/api/v2/runs/{id}']!.get!.responses = responses(ref('CrawlRun'));
  paths['/api/v2/runs/{id}/records']!.get!.responses = responses(page(ref('ExtractedRecord')));
  paths['/api/v2/runs/{id}/logs']!.get!.responses = responses(page(ref('RunLogEntry')));
  paths['/api/v2/runs/{id}/requests']!.get!.responses = responses(page(ref('RunRequestEntry')));
  paths['/api/v2/datasets/{datasetId}/diff']!.get!.responses = responses({
    type: 'object',
    required: ['items', 'nextCursor', 'stats'],
    properties: {
      items: { type: 'array', items: ref('DatasetDiffEntry') },
      nextCursor: { type: ['string', 'null'] },
      stats: ref('DatasetDiffStats'),
    },
  });
  paths['/api/v2/output-destinations']!.get!.responses = responses({
    type: 'array',
    items: ref('OutputDestination'),
  });
  const outputDestinationInput = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'type', 'config'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      type: {
        type: 'string',
        enum: ['webhook', 'postgres', 'local-directory', 'google-sheets', 's3'],
      },
      config: { type: 'object', additionalProperties: true },
      credential: { description: 'Write-only credential payload; never returned by the API' },
      enabled: { type: 'boolean', default: true },
    },
  };
  Object.assign(paths['/api/v2/output-destinations']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body(outputDestinationInput),
    responses: responses(ref('OutputDestination'), '201'),
  });
  paths['/api/v2/output-destinations/{id}']!.get!.responses = responses(ref('OutputDestination'));
  Object.assign(paths['/api/v2/output-destinations/{id}']!.put!, {
    parameters: [idempotencyHeader()],
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      properties: {
        name: outputDestinationInput.properties.name,
        config: outputDestinationInput.properties.config,
        enabled: outputDestinationInput.properties.enabled,
      },
    }),
    responses: responses(ref('OutputDestination')),
  });
  appendParameters(paths['/api/v2/output-destinations/{id}']!.delete!, idempotencyHeader());
  paths['/api/v2/output-destinations/{id}']!.delete!.responses = {
    '204': { description: 'Deleted' },
    default: problemResponse,
  };
  appendParameters(paths['/api/v2/output-destinations/{id}/test']!.post!, idempotencyHeader());
  paths['/api/v2/output-destinations/{id}/test']!.post!.responses = responses({
    type: 'object',
    required: ['ok', 'destinationId'],
    properties: {
      ok: { type: 'boolean', const: true },
      destinationId: { type: 'string', format: 'uuid' },
    },
  });
  appendParameters(
    paths['/api/v2/output-destinations/{id}/credential/prompt']!.post!,
    idempotencyHeader(),
  );
  paths['/api/v2/output-destinations/{id}/credential/prompt']!.post!.responses = responses(
    ref('OutputDestination'),
  );
  paths['/api/v2/delivery-attempts']!.get!.responses = responses({
    type: 'array',
    items: ref('DeliveryAttempt'),
  });
  appendParameters(paths['/api/v2/delivery-attempts/{id}/retry']!.post!, idempotencyHeader());
  paths['/api/v2/delivery-attempts/{id}/retry']!.post!.responses = responses(
    ref('DeliveryAttempt'),
  );
  paths['/api/v2/api-tokens']!.get!.responses = responses({
    type: 'array',
    items: ref('ApiToken'),
  });
  Object.assign(paths['/api/v2/api-tokens']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['name', 'taskIds', 'rateLimitPerMinute'],
      properties: {
        name: { type: 'string', minLength: 1 },
        taskIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
        rateLimitPerMinute: { type: 'integer', minimum: 1, maximum: 10_000 },
        expiresAt: { type: ['string', 'null'], format: 'date-time' },
      },
    }),
    responses: responses(
      {
        allOf: [ref('ApiToken')],
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string', description: 'Returned once' } },
      },
      '201',
    ),
  });
  appendParameters(paths['/api/v2/api-tokens/{id}']!.delete!, idempotencyHeader());
  paths['/api/v2/api-tokens/{id}']!.delete!.responses = {
    '204': { description: 'Revoked' },
    default: problemResponse,
  };
  paths['/api/v2/analytics/methods']!.get!.responses = responses({
    type: 'array',
    items: ref('AnalysisMethodDescriptor'),
  });
  Object.assign(paths['/api/v2/analytics/recipes']!.get!, {
    parameters: [
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
    ],
    responses: responses(page(ref('AnalysisRecipe'))),
  });
  Object.assign(paths['/api/v2/analytics/recipes']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body(ref('AnalysisRecipeInput')),
    responses: responses(ref('AnalysisRecipe'), '201'),
  });
  paths['/api/v2/analytics/recipes/{recipeId}']!.get!.responses = responses(ref('AnalysisRecipe'));
  Object.assign(paths['/api/v2/analytics/recipes/{recipeId}']!.put!, {
    requestBody: body(ref('AnalysisRecipeInput')),
    responses: responses(ref('AnalysisRecipe')),
  });
  appendParameters(
    paths['/api/v2/analytics/recipes/{recipeId}']!.put!,
    idempotencyHeader(),
    ifMatchHeader(),
  );
  appendParameters(
    paths['/api/v2/analytics/recipes/{recipeId}']!.delete!,
    idempotencyHeader(),
    ifMatchHeader(),
  );
  paths['/api/v2/analytics/recipes/{recipeId}']!.delete!.responses = responses({
    type: 'object',
    required: ['deleted'],
    properties: { deleted: { type: 'boolean' } },
  });
  paths['/api/v2/analytics/jobs']!.get!.responses = responses({
    type: 'array',
    items: ref('AnalysisJob'),
  });
  Object.assign(paths['/api/v2/analytics/jobs']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body(ref('AnalysisJobInput')),
    responses: responses(ref('AnalysisJob'), '202'),
  });
  paths['/api/v2/analytics/jobs/{jobId}']!.get!.responses = responses(ref('AnalysisJob'));
  for (const path of [
    '/api/v2/analytics/jobs/{jobId}/cancel',
    '/api/v2/analytics/jobs/{jobId}/retry',
  ]) {
    appendParameters(paths[path]!.post!, idempotencyHeader());
    paths[path]!.post!.responses = responses(ref('AnalysisJob'), '202');
  }
  paths['/api/v2/analytics/results/{resultId}']!.get!.responses = responses(ref('AnalysisResult'));
  appendParameters(
    paths['/api/v2/analytics/results/{resultId}/exports']!.post!,
    idempotencyHeader(),
  );
  paths['/api/v2/analytics/results/{resultId}/exports']!.post!.responses = responses(
    ref('AnalysisResult'),
  );
  Object.assign(paths['/api/v2/corpora']!.get!, {
    parameters: [
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
    ],
    responses: responses(page(ref('Corpus'))),
  });
  Object.assign(paths['/api/v2/corpora']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body(ref('CorpusInput')),
    responses: responses(ref('Corpus'), '201'),
  });
  paths['/api/v2/corpora/{corpusId}']!.get!.responses = responses(ref('Corpus'));
  Object.assign(paths['/api/v2/corpora/{corpusId}']!.put!, {
    requestBody: body(ref('CorpusInput')),
    responses: responses(ref('Corpus')),
  });
  appendParameters(paths['/api/v2/corpora/{corpusId}']!.put!, idempotencyHeader(), ifMatchHeader());
  appendParameters(
    paths['/api/v2/corpora/{corpusId}']!.delete!,
    idempotencyHeader(),
    ifMatchHeader(),
  );
  paths['/api/v2/corpora/{corpusId}']!.delete!.responses = responses({
    type: 'object',
    required: ['deleted'],
    properties: { deleted: { type: 'boolean' } },
  });
  paths['/api/v2/corpora/{corpusId}/recipes']!.get!.responses = responses({
    type: 'array',
    items: ref('CorpusRecipe'),
  });
  Object.assign(paths['/api/v2/corpora/{corpusId}/recipes']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body(ref('CorpusRecipeInput')),
    responses: responses(ref('CorpusRecipe'), '201'),
  });
  Object.assign(paths['/api/v2/corpora/{corpusId}/recipes/{recipeId}']!.put!, {
    requestBody: body(ref('CorpusRecipeInput')),
    responses: responses(ref('CorpusRecipe')),
  });
  appendParameters(
    paths['/api/v2/corpora/{corpusId}/recipes/{recipeId}']!.put!,
    idempotencyHeader(),
    ifMatchHeader(),
  );
  appendParameters(
    paths['/api/v2/corpora/{corpusId}/recipes/{recipeId}']!.delete!,
    idempotencyHeader(),
    ifMatchHeader(),
  );
  paths['/api/v2/corpora/{corpusId}/recipes/{recipeId}']!.delete!.responses = responses({
    type: 'object',
    required: ['deleted'],
    properties: { deleted: { type: 'boolean' } },
  });
  Object.assign(paths['/api/v2/corpora/{corpusId}/builds']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['recipeId', 'snapshotId'],
      properties: {
        recipeId: { type: 'string', format: 'uuid' },
        snapshotId: { type: 'string', format: 'uuid' },
      },
    }),
    responses: responses(ref('CorpusBuild'), '202'),
  });
  Object.assign(paths['/api/v2/corpus-builds']!.get!, {
    parameters: [
      { name: 'corpusId', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000 } },
    ],
    responses: responses({ type: 'array', items: ref('CorpusBuild') }),
  });
  paths['/api/v2/corpus-builds/{buildId}']!.get!.responses = responses(ref('CorpusBuild'));
  for (const path of [
    '/api/v2/corpus-builds/{buildId}/cancel',
    '/api/v2/corpus-builds/{buildId}/retry',
  ]) {
    appendParameters(paths[path]!.post!, idempotencyHeader());
    paths[path]!.post!.responses = responses(ref('CorpusBuild'), '202');
  }
  Object.assign(paths['/api/v2/corpora/{corpusId}/versions']!.get!, {
    parameters: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000 } },
    ],
    responses: responses({ type: 'array', items: ref('CorpusVersion') }),
  });
  paths['/api/v2/corpora/{corpusId}/versions/{versionId}']!.get!.responses = responses(
    ref('CorpusVersion'),
  );
  appendParameters(
    paths['/api/v2/corpora/{corpusId}/versions/{versionId}/exports']!.post!,
    idempotencyHeader(),
  );
  paths['/api/v2/corpora/{corpusId}/versions/{versionId}/exports']!.post!.responses = responses({
    type: 'object',
    required: ['versionId', 'artifacts'],
    properties: {
      versionId: { type: 'string', format: 'uuid' },
      artifacts: corpusVersionOpenApiSchema().properties.artifacts,
    },
  });
  const assistantObject = { type: 'object', additionalProperties: true };
  Object.assign(paths['/api/v2/crawler-assistant/conversations']!.get!, {
    parameters: [
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
    responses: responses(assistantObject),
  });
  Object.assign(paths['/api/v2/crawler-assistant/conversations']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      properties: { title: { type: 'string', maxLength: 120 } },
    }),
    responses: responses(assistantObject, '201'),
  });
  paths['/api/v2/crawler-assistant/conversations/{id}']!.get!.responses =
    responses(assistantObject);
  appendParameters(
    paths['/api/v2/crawler-assistant/conversations/{id}']!.delete!,
    idempotencyHeader(),
  );
  paths['/api/v2/crawler-assistant/conversations/{id}']!.delete!.responses =
    responses(assistantObject);
  paths['/api/v2/crawler-assistant/conversations/{id}/messages']!.get!.responses = responses({
    type: 'array',
    items: assistantObject,
  });
  Object.assign(paths['/api/v2/crawler-assistant/conversations/{id}/messages']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: { content: { type: 'string', minLength: 1, maxLength: 8000 } },
    }),
    responses: responses(assistantObject, '202'),
  });
  Object.assign(paths['/api/v2/crawler-assistant/conversations/{id}/site-selection']!.post!, {
    parameters: [idempotencyHeader(), ifMatchHeader()],
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: { url: { type: 'string', format: 'uri' } },
    }),
    responses: responses(assistantObject, '202'),
  });
  appendParameters(
    paths['/api/v2/crawler-assistant/conversations/{id}/draft/test']!.post!,
    idempotencyHeader(),
    ifMatchHeader(),
  );
  paths['/api/v2/crawler-assistant/conversations/{id}/draft/test']!.post!.responses =
    responses(assistantObject);
  appendParameters(
    paths['/api/v2/crawler-assistant/conversations/{id}/commit']!.post!,
    idempotencyHeader(),
    ifMatchHeader(),
  );
  paths['/api/v2/crawler-assistant/conversations/{id}/commit']!.post!.responses = {
    ...responses(assistantObject, '201'),
    '200': jsonResponse(assistantObject),
  };
  appendParameters(
    paths['/api/v2/crawler-assistant/turns/{id}/cancel']!.post!,
    idempotencyHeader(),
  );
  paths['/api/v2/crawler-assistant/turns/{id}/cancel']!.post!.responses =
    responses(assistantObject);
  appendParameters(paths['/api/v2/crawler-assistant/turns/{id}/retry']!.post!, idempotencyHeader());
  paths['/api/v2/crawler-assistant/turns/{id}/retry']!.post!.responses = responses(
    assistantObject,
    '202',
  );
  paths['/api/v2/ai/provider']!.get!.responses = responses(assistantObject);
  Object.assign(paths['/api/v2/ai/provider']!.put!, {
    parameters: [idempotencyHeader(), ifMatchHeader()],
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['providerId', 'model'],
      properties: {
        providerId: { type: 'string', minLength: 1, maxLength: 100 },
        model: { type: 'string', minLength: 1, maxLength: 200 },
      },
    }),
    responses: responses(assistantObject),
  });
  appendParameters(
    paths['/api/v2/ai/provider/credential/prompt']!.post!,
    idempotencyHeader(),
    ifMatchHeader(),
  );
  paths['/api/v2/ai/provider/credential/prompt']!.post!.responses = responses(assistantObject);
  appendParameters(
    paths['/api/v2/ai/provider/credential']!.delete!,
    idempotencyHeader(),
    ifMatchHeader(),
  );
  paths['/api/v2/ai/provider/credential']!.delete!.responses = responses(assistantObject);
  Object.assign(paths['/api/v2/ai/provider/test']!.post!, {
    parameters: [idempotencyHeader()],
    requestBody: body({
      type: 'object',
      additionalProperties: false,
      required: ['providerId', 'model'],
      properties: {
        providerId: { type: 'string', minLength: 1, maxLength: 100 },
        model: { type: 'string', minLength: 1, maxLength: 200 },
      },
    }),
    responses: responses(assistantObject),
  });
  paths['/api/v2/data/tasks/{id}/records']!.get!.security = [{ dataApiBearer: [] }];
  const publishedPaths: typeof paths = {};
  const graph = resolveProductGraph(profileId);
  for (const { descriptor } of graph.plugins) {
    for (const route of descriptor.routes ?? []) {
      const method = route.method.toLowerCase();
      const sourcePath = Object.keys(paths).find(
        (candidate) => canonicalOpenApiPath(candidate) === canonicalOpenApiPath(route.path),
      );
      const operation = sourcePath ? paths[sourcePath]?.[method] : undefined;
      const secured = route.requiredPermission !== null;
      const workspaceSecurity =
        profileId === 'headless-server' ? [{ workspaceCookie: [] }] : [{ sessionBearer: [] }];
      const mutation = ['post', 'put', 'patch', 'delete'].includes(method);
      const parameters = synchronizePathParameters(
        Array.isArray(operation?.parameters) ? operation.parameters : [],
        sourcePath,
        route.path,
      );
      publishedPaths[route.path] ??= {};
      publishedPaths[route.path]![method] = {
        ...(operation ?? { responses: { '200': { description: 'Success' } } }),
        operationId: route.operationId,
        'x-required-permission': route.requiredPermission,
        ...(route.path.startsWith('/api/v2/data/')
          ? { security: [{ dataApiBearer: [] }] }
          : { security: secured ? workspaceSecurity : [] }),
        parameters,
        ...(profileId === 'headless-server' && secured && mutation
          ? {
              parameters: [
                ...parameters,
                {
                  name: 'X-CSRF-Token',
                  in: 'header',
                  required: true,
                  schema: { type: 'string', minLength: 1 },
                },
              ],
            }
          : {}),
      };
    }
  }
  assertOpenApiPathParameters(publishedPaths);
  return {
    openapi: '3.1.0',
    info: { title: 'ZhiYun Runtime API', version: '1.0.0' },
    paths: publishedPaths,
    components: {
      schemas: {
        TaskCreate: z.toJSONSchema(taskCreateSchema),
        TaskUpdate: z.toJSONSchema(taskUpdateSchema),
        TaskDetail: z.toJSONSchema(taskDetailSchema),
        TaskListItem: z.toJSONSchema(taskListItemSchema),
        TaskHealth: z.toJSONSchema(taskHealthSchema),
        QualityPolicy: z.toJSONSchema(qualityPolicySchema),
        QualityEvaluation: z.toJSONSchema(qualityEvaluationSchema),
        TaskTemplate: z.toJSONSchema(taskTemplateSchema),
        Schedule: z.toJSONSchema(scheduleSchema),
        InspectionStepInput: z.toJSONSchema(inspectionStepInputSchema),
        InspectionStepResult: z.toJSONSchema(inspectionStepResultSchema),
        InspectionElementSelection: z.toJSONSchema(inspectionElementSelectionSchema),
        CrawlPlanDefinition: z.toJSONSchema(crawlPlanDefinitionSchema),
        CrawlRun: z.toJSONSchema(crawlRunSchema),
        RuleAnalysisResult: z.toJSONSchema(analysisResultSchema),
        AnalysisMethodDescriptor: analysisMethodDescriptorOpenApiSchema(),
        AnalysisRecipeInput: analysisRecipeInputOpenApiSchema(),
        AnalysisRecipe: analysisRecipeOpenApiSchema(),
        AnalysisJobInput: analysisJobInputOpenApiSchema(),
        AnalysisJob: analysisJobOpenApiSchema(),
        AnalysisResult: analysisResultOpenApiSchema(),
        CorpusInput: corpusInputOpenApiSchema(),
        Corpus: corpusOpenApiSchema(),
        CorpusRecipeInput: corpusRecipeInputOpenApiSchema(),
        CorpusRecipe: corpusRecipeOpenApiSchema(),
        CorpusBuild: corpusBuildOpenApiSchema(),
        CorpusVersion: corpusVersionOpenApiSchema(),
        RuleVersion: z.toJSONSchema(ruleVersionSchema),
        DatasetRecord: z.toJSONSchema(datasetRecordSchema),
        DatasetStats: z.toJSONSchema(datasetStatsSchema),
        DatasetDiffEntry: z.toJSONSchema(datasetDiffEntrySchema),
        DatasetDiffStats: z.toJSONSchema(datasetDiffStatsSchema),
        RecordChange: z.toJSONSchema(recordChangeSchema),
        ExtractedRecord: z.toJSONSchema(extractedRecordSchema),
        RunLogEntry: z.toJSONSchema(runLogEntrySchema),
        RunRequestEntry: z.toJSONSchema(runRequestEntrySchema),
        OutputDestination: z.toJSONSchema(outputDestinationSchema),
        DeliveryAttempt: z.toJSONSchema(deliveryAttemptSchema),
        ApiToken: z.toJSONSchema(apiTokenSchema),
        RuleRepairProposal: z.toJSONSchema(ruleRepairProposalSchema),
        PreferenceSignalInput: z.toJSONSchema(preferenceSignalInputSchema),
        PreferenceSignal: z.toJSONSchema(preferenceSignalSchema),
        PreferenceProfile: z.toJSONSchema(preferenceProfileSchema),
        PreferenceImport: z.toJSONSchema(preferenceImportSchema),
        RecruitmentSource: z.toJSONSchema(recruitmentSourceSchema),
        RecruitmentSyncResult: z.toJSONSchema(recruitmentSyncResultSchema),
        RecruitmentSearchProfileInput: z.toJSONSchema(recruitmentSearchProfileInputSchema),
        RecruitmentSearchProfile: z.toJSONSchema(recruitmentSearchProfileSchema),
        RecruitmentImportMappingInput: z.toJSONSchema(recruitmentImportMappingInputSchema),
        RecruitmentImportMapping: z.toJSONSchema(recruitmentImportMappingSchema),
        RecruitmentFileInput: z.toJSONSchema(recruitmentFileInputSchema),
        RecruitmentImportPreview: z.toJSONSchema(recruitmentImportPreviewSchema),
        RecruitmentImportJob: z.toJSONSchema(recruitmentImportJobSchema),
        RecruitmentJobCluster: z.toJSONSchema(recruitmentJobClusterSchema),
        RecruitmentWorkflowUpdate: z.toJSONSchema(recruitmentWorkflowUpdateSchema),
        TrendSource: z.toJSONSchema(trendSourceSchema),
        TrendSourceUpdate: z.toJSONSchema(trendSourceUpdateSchema),
        TrendItem: z.toJSONSchema(trendItemSchema),
        TrendTerm: z.toJSONSchema(trendTermSchema),
        TrendsResponse: z.toJSONSchema(trendsResponseSchema),
        ArtifactDescriptor: z.toJSONSchema(artifactDescriptorSchema),
        DomainEvent: z.toJSONSchema(domainEventSchema),
        RuntimeMetadata: z.toJSONSchema(runtimeMetadataSchema),
        RuntimeCapabilities: z.toJSONSchema(runtimeCapabilitiesSchema),
        IdentityUser: identityUserOpenApiSchema(),
        IdentityInvitation: identityInvitationOpenApiSchema(),
        IdentityAuditEvent: identityAuditEventOpenApiSchema(),
        ProblemDetails: z.toJSONSchema(problemDetailsSchema),
      },
      securitySchemes: {
        sessionBearer: { type: 'http', scheme: 'bearer' },
        dataApiBearer: { type: 'http', scheme: 'bearer' },
        workspaceCookie: { type: 'apiKey', in: 'cookie', name: 'zhiyun_session' },
      },
    },
  };
}

function canonicalOpenApiPath(path: string): string {
  return path.replaceAll(/\{[^}]+\}/g, '{}');
}

function openApiPathParameterNames(path: string | undefined): string[] {
  return [...(path ?? '').matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
}

function synchronizePathParameters(
  parameters: unknown[],
  sourcePath: string | undefined,
  publishedPath: string,
): unknown[] {
  const sourceNames = openApiPathParameterNames(sourcePath);
  const publishedNames = openApiPathParameterNames(publishedPath);
  const pathParameters = parameters.filter(
    (parameter): parameter is Record<string, unknown> =>
      typeof parameter === 'object' &&
      parameter !== null &&
      (parameter as Record<string, unknown>).in === 'path',
  );
  const nonPathParameters = parameters.filter(
    (parameter) =>
      !(
        typeof parameter === 'object' &&
        parameter !== null &&
        (parameter as Record<string, unknown>).in === 'path'
      ),
  );

  return [
    ...nonPathParameters,
    ...publishedNames.map((name, index) => {
      const sourceName = sourceNames[index];
      const existing =
        pathParameters.find((parameter) => parameter.name === name) ??
        pathParameters.find((parameter) => parameter.name === sourceName);
      return {
        ...(existing ?? { schema: { type: 'string', minLength: 1 } }),
        name,
        in: 'path',
        required: true,
      };
    }),
  ];
}

export function assertOpenApiPathParameters(paths: Record<string, Record<string, unknown>>): void {
  for (const [path, pathItem] of Object.entries(paths)) {
    const expected = openApiPathParameterNames(path).sort();
    for (const [method, operation] of Object.entries(pathItem)) {
      if (typeof operation !== 'object' || operation === null) continue;
      const parameters = Array.isArray((operation as Record<string, unknown>).parameters)
        ? ((operation as Record<string, unknown>).parameters as unknown[])
        : [];
      const declared = parameters
        .filter(
          (parameter): parameter is Record<string, unknown> =>
            typeof parameter === 'object' &&
            parameter !== null &&
            (parameter as Record<string, unknown>).in === 'path',
        )
        .map((parameter) => String(parameter.name))
        .sort();
      if (expected.join('\0') !== declared.join('\0')) {
        throw new Error(
          `OpenAPI ${method.toUpperCase()} ${path} declares path parameters [${declared.join(', ')}], expected [${expected.join(', ')}]`,
        );
      }
    }
  }
}
