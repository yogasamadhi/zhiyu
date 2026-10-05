export interface AiProviderCatalogModel {
  id: string;
  name: string;
  status: 'stable' | 'preview';
}

export interface AiProviderCatalogEntry {
  id: string;
  name: string;
  baseUrl: string;
  documentationUrl: string;
  defaultModel: string;
  models: AiProviderCatalogModel[];
}

export interface AiProviderSelection {
  providerId: string;
  baseUrl: string;
  model: string;
}

export const aiProviderCatalogUpdatedAt = '2026-08-29';

/**
 * Curated Chat Completions providers supported by the current provider adapter.
 * Keep this list limited to text models with streaming and function/tool calling.
 */
export const aiProviderCatalog: AiProviderCatalogEntry[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    documentationUrl: 'https://developers.openai.com/api/docs/models',
    defaultModel: 'gpt-5.6-terra',
    models: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', status: 'stable' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', status: 'stable' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', status: 'stable' },
      { id: 'gpt-5.5', name: 'GPT-5.5', status: 'stable' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', status: 'stable' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    documentationUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    defaultModel: 'claude-sonnet-5',
    models: [
      { id: 'claude-fable-5', name: 'Claude Fable 5', status: 'stable' },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', status: 'stable' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', status: 'stable' },
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        status: 'stable',
      },
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    documentationUrl: 'https://ai.google.dev/gemini-api/docs/models',
    defaultModel: 'gemini-3.7-flash',
    models: [
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', status: 'stable' },
      { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', status: 'stable' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', status: 'stable' },
      { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', status: 'stable' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', status: 'preview' },
    ],
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    documentationUrl: 'https://docs.x.ai/developers/models',
    defaultModel: 'grok-4.6',
    models: [
      { id: 'grok-4.6', name: 'Grok 4.6', status: 'stable' },
      { id: 'grok-4.3', name: 'Grok 4.3', status: 'stable' },
      { id: 'grok-build-0.1', name: 'Grok Build 0.1', status: 'stable' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    documentationUrl: 'https://api-docs.deepseek.com/updates',
    defaultModel: 'deepseek-v4-pro',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', status: 'stable' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', status: 'stable' },
    ],
  },
  {
    id: 'qwen',
    name: '阿里云百炼 · Qwen（北京）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    documentationUrl: 'https://help.aliyun.com/zh/model-studio/text-generation-model',
    defaultModel: 'qwen3.7-plus',
    models: [
      { id: 'qwen3.8-max', name: 'Qwen3.8 Max', status: 'stable' },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', status: 'stable' },
      { id: 'qwen3.7-flash', name: 'Qwen3.7 Flash', status: 'stable' },
    ],
  },
  {
    id: 'kimi',
    name: '月之暗面 · Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    documentationUrl: 'https://platform.kimi.com/docs/overview',
    defaultModel: 'kimi-k3',
    models: [
      { id: 'kimi-k3', name: 'Kimi K3', status: 'stable' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', status: 'stable' },
      {
        id: 'kimi-k2.7-code-highspeed',
        name: 'Kimi K2.7 Code Highspeed',
        status: 'stable',
      },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', status: 'stable' },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 AI · GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    documentationUrl: 'https://docs.bigmodel.cn/api-reference/模型-api/对话补全',
    defaultModel: 'glm-5.2',
    models: [
      { id: 'glm-5.2', name: 'GLM-5.2', status: 'stable' },
      { id: 'glm-5.1', name: 'GLM-5.1', status: 'stable' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', status: 'stable' },
      { id: 'glm-4.7-flash', name: 'GLM-4.7 Flash', status: 'stable' },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    documentationUrl: 'https://platform.minimaxi.com/docs/guides/text-generation',
    defaultModel: 'MiniMax-M2.7',
    models: [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', status: 'stable' },
      {
        id: 'MiniMax-M2.7-highspeed',
        name: 'MiniMax M2.7 Highspeed',
        status: 'stable',
      },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', status: 'stable' },
      {
        id: 'MiniMax-M2.5-highspeed',
        name: 'MiniMax M2.5 Highspeed',
        status: 'stable',
      },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    documentationUrl: 'https://docs.mistral.ai/models',
    defaultModel: 'mistral-medium-3-5',
    models: [
      { id: 'mistral-medium-3-5', name: 'Mistral Medium 3.5', status: 'stable' },
      { id: 'mistral-small-2603', name: 'Mistral Small 4', status: 'stable' },
      { id: 'mistral-medium-latest', name: 'Mistral Medium Latest', status: 'stable' },
    ],
  },
  {
    id: 'baidu',
    name: '百度智能云 · ERNIE',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    documentationUrl: 'https://cloud.baidu.com/doc/qianfan-docs/s/qm8qxemze',
    defaultModel: 'ernie-5.1',
    models: [
      { id: 'ernie-5.1', name: 'ERNIE 5.1', status: 'stable' },
      { id: 'ernie-5.0', name: 'ERNIE 5.0', status: 'stable' },
      { id: 'ernie-4.5-turbo-32k', name: 'ERNIE 4.5 Turbo 32K', status: 'stable' },
    ],
  },
  {
    id: 'doubao',
    name: '火山引擎 · 豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    documentationUrl: 'https://www.volcengine.com/docs/82379/2549861',
    defaultModel: 'doubao-seed-2-1-pro-260628',
    models: [
      {
        id: 'doubao-seed-2-1-pro-260628',
        name: 'Doubao Seed 2.1 Pro',
        status: 'stable',
      },
    ],
  },
  {
    id: 'tencent-tokenhub',
    name: '腾讯云 TokenHub · 混元',
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    documentationUrl: 'https://cloud.tencent.com/document/product/1729/131925',
    defaultModel: 'hy3-preview',
    models: [{ id: 'hy3-preview', name: 'Hunyuan HY 3', status: 'preview' }],
  },
];

export function resolveAiProviderSelection(
  providerId: string,
  modelId: string,
): AiProviderSelection {
  const provider = aiProviderCatalog.find((candidate) => candidate.id === providerId.trim());
  if (!provider) throw new Error('Unsupported AI model provider');
  const model = modelId.trim();
  if (!provider.models.some((candidate) => candidate.id === model)) {
    throw new Error(`Model ${model || '(empty)'} is not available for ${provider.name}`);
  }
  return { providerId: provider.id, baseUrl: provider.baseUrl, model };
}

export function inferAiProviderId(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  const normalized = baseUrl.replace(/\/$/, '').toLowerCase();
  return (
    aiProviderCatalog.find(
      (provider) => provider.baseUrl.replace(/\/$/, '').toLowerCase() === normalized,
    )?.id ?? null
  );
}
