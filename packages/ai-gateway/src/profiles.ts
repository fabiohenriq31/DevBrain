import type { CatalogImportEntry } from './catalog.js';

/** Curated connection recipes. Unknown commercial facts deliberately remain unknown. */
const recipes = [
  [
    'openai',
    'OpenAI',
    'https://api.openai.com/v1',
    'openai-chat',
    'https://platform.openai.com/docs/api-reference/chat',
  ],
  [
    'anthropic',
    'Anthropic',
    'https://api.anthropic.com',
    'anthropic-messages',
    'https://docs.anthropic.com/en/api/messages',
  ],
  [
    'google',
    'Google Gemini',
    'https://generativelanguage.googleapis.com/v1beta',
    'google-gemini',
    'https://ai.google.dev/gemini-api/docs/text-generation',
  ],
  [
    'groq',
    'Groq',
    'https://api.groq.com/openai/v1',
    'openai-chat',
    'https://console.groq.com/docs/api-reference',
  ],
  [
    'openrouter',
    'OpenRouter',
    'https://openrouter.ai/api/v1',
    'openai-chat',
    'https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request',
  ],
  [
    'mistral',
    'Mistral AI',
    'https://api.mistral.ai/v1',
    'openai-chat',
    'https://docs.mistral.ai/api/endpoint/chat',
  ],
  [
    'nvidia',
    'NVIDIA NIM',
    'https://integrate.api.nvidia.com/v1',
    'openai-chat',
    'https://docs.api.nvidia.com/nim/reference/llm-apis',
  ],
  [
    'cohere',
    'Cohere',
    'https://api.cohere.ai/compatibility/v1',
    'openai-chat',
    'https://docs.cohere.com/docs/compatibility-api',
  ],
  [
    'cerebras',
    'Cerebras',
    'https://api.cerebras.ai/v1',
    'openai-chat',
    'https://inference-docs.cerebras.ai/resources/glm-47-migration',
  ],
  [
    'deepseek',
    'DeepSeek',
    'https://api.deepseek.com',
    'openai-chat',
    'https://api-docs.deepseek.com/api/create-chat-completion/',
  ],
  [
    'huggingface',
    'Hugging Face Inference Providers',
    'https://router.huggingface.co/v1',
    'openai-chat',
    'https://huggingface.co/docs/inference-providers/index',
  ],
  [
    'vercel',
    'Vercel AI Gateway',
    'https://ai-gateway.vercel.sh/v1',
    'openai-chat',
    'https://vercel.com/docs/ai-gateway/sdks-and-apis',
  ],
  [
    'togetherai',
    'Together AI',
    'https://api.together.xyz/v1',
    'openai-chat',
    'https://docs.together.ai/docs/openai-api-compatibility',
  ],
  [
    'fireworks-ai',
    'Fireworks AI',
    'https://api.fireworks.ai/inference/v1',
    'openai-chat',
    'https://docs.fireworks.ai/guides/querying-text-models',
  ],
  [
    'deepinfra',
    'DeepInfra',
    'https://api.deepinfra.com/v1/openai',
    'openai-chat',
    'https://deepinfra.com/docs/openai_api',
  ],
  [
    'siliconflow-cn',
    'SiliconFlow',
    'https://api.siliconflow.cn/v1',
    'openai-chat',
    'https://docs.siliconflow.cn/docs/api/chat-completions-post',
  ],
  [
    'alibaba-cn',
    'Alibaba Model Studio',
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'openai-chat',
    'https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope',
  ],
  [
    'zai',
    'Z.ai',
    'https://api.z.ai/api/paas/v4',
    'openai-chat',
    'https://docs.z.ai/guides/overview/quick-start',
  ],
  [
    'cloudflare-workers-ai',
    'Cloudflare Workers AI',
    null,
    'openai-chat',
    'https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/',
  ],
  ['ollama', 'Ollama', 'http://127.0.0.1:11434', 'ollama', 'https://docs.ollama.com/api/overview'],
  [
    'lmstudio',
    'LM Studio',
    'http://127.0.0.1:1234/v1',
    'openai-chat',
    'https://lmstudio.ai/docs/developer/openai-compat',
  ],
  [
    'llama-cpp',
    'llama.cpp server',
    'http://127.0.0.1:8080/v1',
    'openai-chat',
    'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
  ],
] as const;

export const SPECIFIC_CONNECTION_PROFILES: readonly CatalogImportEntry[] = recipes.map(
  ([id, name, endpointUrl, protocol, documentationUrl]) => ({
    id,
    name,
    documentationUrl,
    kind: protocol === 'ollama' || id === 'lmstudio' || id === 'llama-cpp' ? 'local' : 'api',
    signupUrl: null,
    termsUrl: null,
    sourceId: 'devbrain-official',
    verifiedAt: '2026-11-27T00:00:00.000Z',
    siteUrl: new URL(documentationUrl).origin,
    endpointUrl,
    authType: protocol === 'ollama' || id === 'lmstudio' || id === 'llama-cpp' ? 'none' : 'api-key',
    offer: protocol === 'ollama' || id === 'lmstudio' || id === 'llama-cpp' ? 'local' : 'unknown',
    requiresCard: null,
    regionalRestrictions: null,
    commercialUse: 'unknown',
    retentionPolicyUrl: null,
    trainingPolicyUrl: null,
    knownModelIds: [],
    publishedQuotaIds: [],
    quotaScope: null,
    consumptionUnit: null,
    verificationState: 'documented',
    sourceUrls: [documentationUrl],
    dataLicense: 'DevBrain original metadata',
  }),
);

export const connectionRecipe = (providerId: string) => {
  const profile = SPECIFIC_CONNECTION_PROFILES.find((item) => item.id === providerId);
  if (!profile || !profile.endpointUrl) return null;
  const recipe = recipes.find((item) => item[0] === providerId);
  return recipe ? { baseUrl: profile.endpointUrl, protocol: recipe[3] } : null;
};
