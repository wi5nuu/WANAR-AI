import dotenv from 'dotenv';
dotenv.config();

const config = {
  openagentic: {
    apiKey: process.env.OPENAGENTIC_API_KEY,
    baseUrl: process.env.OPENAGENTIC_BASE_URL || 'https://openagentic.id/api/v1',
    defaultModel: process.env.OPENAGENTIC_DEFAULT_MODEL || 'claude-sonnet-4-5',
    models: [
      // ===== Anthropic Claude =====
      { id: 'claude-sonnet-4-5',        label: 'Claude Sonnet 4.5',           family: 'Anthropic', rec: true, tags: ['Unlimited', 'Coding', 'Reasoning', '200K Context'] },
      { id: 'claude-sonnet-4-5-20251101', label: 'Claude Sonnet 4.5 (Nov)',   family: 'Anthropic', tags: ['Latest', 'Coding'] },
      { id: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6',           family: 'Anthropic', tags: ['Latest', 'Coding', 'Reasoning'] },
      { id: 'claude-sonnet-4-5-1m',     label: 'Claude Sonnet 4.5 (1M)',      family: 'Anthropic', tags: ['Long Context', '1M Tokens'] },
      { id: 'claude-sonnet-4',          label: 'Claude Sonnet 4',             family: 'Anthropic', tags: ['Stable', 'Balanced'] },
      { id: 'claude-opus-4-5',          label: 'Claude Opus 4.5',             family: 'Anthropic', rec: true, tags: ['Most Capable', 'Deep Analysis'] },
      { id: 'claude-opus-4',            label: 'Claude Opus 4',               family: 'Anthropic', tags: ['Powerful', 'Complex Tasks'] },
      { id: 'claude-haiku-4-5',         label: 'Claude Haiku 4.5',            family: 'Anthropic', tags: ['Fast', 'Lightweight', 'Budget'] },
      { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet',         family: 'Anthropic', rec: true, tags: ['Coding', 'Fast', 'Stable'] },
      { id: 'claude-3-5-haiku-20241022',  label: 'Claude 3.5 Haiku',          family: 'Anthropic', tags: ['Fast', 'Budget', 'Lightweight'] },
      { id: 'claude-3-opus-20240229',     label: 'Claude 3 Opus',             family: 'Anthropic', tags: ['Deep Analysis', 'Stable'] },

      // ===== OpenAI GPT =====
      { id: 'gpt-4.5',                  label: 'GPT-4.5',                     family: 'OpenAI', rec: true, tags: ['Latest', 'Multimodal', 'Tool Calling'] },
      { id: 'gpt-4.1',                  label: 'GPT-4.1',                     family: 'OpenAI', tags: ['Balanced', 'Tool Calling'] },
      { id: 'gpt-4.1-mini',             label: 'GPT-4.1 Mini',                family: 'OpenAI', tags: ['Fast', 'Budget'] },
      { id: 'gpt-4.1-nano',             label: 'GPT-4.1 Nano',                family: 'OpenAI', tags: ['Ultra Fast', 'Budget'] },
      { id: 'gpt-4o',                   label: 'GPT-4o',                      family: 'OpenAI', rec: true, tags: ['Fast', 'Multimodal', '128K'] },
      { id: 'gpt-4o-mini',              label: 'GPT-4o Mini',                 family: 'OpenAI', tags: ['Fast', 'Cheap'] },
      { id: 'gpt-4-turbo',              label: 'GPT-4 Turbo',                 family: 'OpenAI', tags: ['Powerful', '128K'] },
      { id: 'o3',                       label: 'o3',                          family: 'OpenAI', rec: true, tags: ['Reasoning', 'Advanced'] },
      { id: 'o3-mini',                  label: 'o3 Mini',                     family: 'OpenAI', tags: ['Reasoning', 'Fast', 'Coding'] },
      { id: 'o4-mini',                  label: 'o4 Mini',                     family: 'OpenAI', tags: ['Reasoning', 'Latest', 'Coding'] },
      { id: 'o1',                       label: 'o1',                          family: 'OpenAI', tags: ['Reasoning', 'Deep Analysis'] },
      { id: 'o1-mini',                  label: 'o1 Mini',                     family: 'OpenAI', tags: ['Reasoning', 'Fast'] },

      // ===== Google Gemini =====
      { id: 'gemini-2.5-pro',           label: 'Gemini 2.5 Pro',              family: 'Google', rec: true, tags: ['Latest', 'Powerful', '2M Context'] },
      { id: 'gemini-2.5-flash',         label: 'Gemini 2.5 Flash',            family: 'Google', rec: true, tags: ['Fast', 'Latest', '2M Context'] },
      { id: 'gemini-2.0-flash',         label: 'Gemini 2.0 Flash',            family: 'Google', tags: ['Fast', '1M Context'] },
      { id: 'gemini-2.0-flash-thinking', label: 'Gemini 2.0 Flash Thinking',  family: 'Google', tags: ['Reasoning', 'Thinking'] },
      { id: 'gemini-1.5-pro',           label: 'Gemini 1.5 Pro',              family: 'Google', tags: ['Stable', '2M Context'] },
      { id: 'gemini-1.5-flash',         label: 'Gemini 1.5 Flash',            family: 'Google', tags: ['Fast', '1M Context'] },

      // ===== xAI Grok =====
      { id: 'grok-3',                   label: 'Grok 3',                      family: 'xAI', rec: true, tags: ['Powerful', 'Reasoning'] },
      { id: 'grok-3-mini',              label: 'Grok 3 Mini',                 family: 'xAI', tags: ['Fast', 'Budget'] },
      { id: 'grok-2',                   label: 'Grok 2',                      family: 'xAI', tags: ['Stable', 'Fast'] },

      // ===== Meta Llama =====
      { id: 'llama-4-maverick',         label: 'Llama 4 Maverick',            family: 'Meta', rec: true, tags: ['Latest', 'Multimodal'] },
      { id: 'llama-4-scout',            label: 'Llama 4 Scout',               family: 'Meta', tags: ['Fast', 'Efficient'] },
      { id: 'llama-3.3-70b-instruct',   label: 'Llama 3.3 70B',              family: 'Meta', tags: ['Open Source', 'Reasoning'] },
      { id: 'llama-3.1-405b-instruct',  label: 'Llama 3.1 405B',             family: 'Meta', tags: ['Open Source', 'Powerful'] },
      { id: 'llama-3.1-70b-instruct',   label: 'Llama 3.1 70B',              family: 'Meta', tags: ['Open Source', 'Balanced'] },
      { id: 'llama-3.1-8b-instruct',    label: 'Llama 3.1 8B',               family: 'Meta', tags: ['Fast', 'Budget'] },

      // ===== DeepSeek =====
      { id: 'deepseek-v3',              label: 'DeepSeek V3',                 family: 'DeepSeek', rec: true, tags: ['Coding', 'Reasoning', 'MoE'] },
      { id: 'deepseek-v3-0324',         label: 'DeepSeek V3 (Mar 24)',        family: 'DeepSeek', tags: ['Coding', 'Latest'] },
      { id: 'deepseek-r1',              label: 'DeepSeek R1',                 family: 'DeepSeek', rec: true, tags: ['Reasoning', 'Math', 'Chain-of-Thought'] },
      { id: 'deepseek-r1-0528',         label: 'DeepSeek R1 (May 28)',        family: 'DeepSeek', tags: ['Reasoning', 'Latest'] },
      { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill 70B', family: 'DeepSeek', tags: ['Reasoning', 'Fast'] },

      // ===== Mistral =====
      { id: 'mistral-large-2',          label: 'Mistral Large 2',             family: 'Mistral', rec: true, tags: ['Powerful', 'Multilingual', 'Tool Calling'] },
      { id: 'mistral-small-3',          label: 'Mistral Small 3',             family: 'Mistral', tags: ['Fast', 'Efficient'] },
      { id: 'codestral',                label: 'Codestral',                   family: 'Mistral', tags: ['Coding', 'Fill-in-the-Middle'] },
      { id: 'mixtral-8x22b-instruct',   label: 'Mixtral 8x22B',              family: 'Mistral', tags: ['MoE', 'Powerful'] },

      // ===== Qwen / Alibaba =====
      { id: 'qwen3-235b-a22b',          label: 'Qwen3 235B MoE',             family: 'Alibaba', rec: true, tags: ['Latest', 'MoE', 'Reasoning'] },
      { id: 'qwen3-32b',                label: 'Qwen3 32B',                  family: 'Alibaba', tags: ['Reasoning', 'Coding'] },
      { id: 'qwen2.5-72b-instruct',     label: 'Qwen2.5 72B',               family: 'Alibaba', tags: ['Coding', 'Multilingual'] },
      { id: 'qwen2.5-coder-32b-instruct', label: 'Qwen2.5 Coder 32B',       family: 'Alibaba', tags: ['Coding', 'Specialized'] },

      // ===== Microsoft =====
      { id: 'phi-4',                    label: 'Phi-4',                       family: 'Microsoft', tags: ['Efficient', 'Reasoning', 'Lightweight'] },
      { id: 'phi-4-mini',               label: 'Phi-4 Mini',                  family: 'Microsoft', tags: ['Ultra Fast', 'Budget'] },
    ],
    maxTokens: parseInt(process.env.OPENAGENTIC_MAX_TOKENS || '200000', 10),
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-sonnet-4-20250514',
    models: [
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Direct)', family: 'Anthropic', rec: true, tags: ['Latest', 'Balanced', 'Direct API'] },
      { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Direct)', family: 'Anthropic', rec: true, tags: ['Fast', 'Coding', 'Direct API'] },
      { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Direct)', family: 'Anthropic', tags: ['Fast', 'Light', 'Direct API'] },
      { id: 'claude-3-opus-20240229', label: 'Claude 3 Opus (Direct)', family: 'Anthropic', tags: ['Deep Analysis', 'Direct API'] },
    ],
    maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '4096', 10),
  },

  nvidia: {
    apiKey: process.env.NVIDIA_API_KEY,
    apiKeys: process.env.NVIDIA_KEYS
      ? process.env.NVIDIA_KEYS.split(',').map(k => k.trim()).filter(Boolean)
      : (process.env.NVIDIA_API_KEY ? [process.env.NVIDIA_API_KEY] : []),
    baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    defaultModel: process.env.NVIDIA_DEFAULT_MODEL || 'deepseek-ai/deepseek-v4-pro',
    models: [
      { id: 'deepseek-ai/deepseek-v4-pro',     label: 'DeepSeek V4 Pro',     family: 'DeepSeek', rec: true, tags: ['Coding', 'Reasoning'] },
      { id: 'deepseek-ai/deepseek-v4-flash',   label: 'DeepSeek V4 Flash',   family: 'DeepSeek', tags: ['Coding', 'Fast'] },
      { id: 'meta/llama-3.1-405b-instruct',    label: 'Llama 3.1 405B',      family: 'Meta', rec: true, tags: ['Reasoning', 'Complex'] },
      { id: 'meta/llama-3.1-70b-instruct',     label: 'Llama 3.1 70B',       family: 'Meta', tags: ['General', 'Balanced'] },
      { id: 'meta/llama-3.1-8b-instruct',      label: 'Llama 3.1 8B',        family: 'Meta', tags: ['Fast', 'Budget'] },
      { id: 'mistralai/mistral-large',          label: 'Mistral Large',       family: 'Mistral', rec: true, tags: ['Analysis', 'Multilingual'] },
      { id: 'mistralai/mistral-small',          label: 'Mistral Small',       family: 'Mistral', tags: ['Fast'] },
      { id: 'microsoft/phi-4',                 label: 'Phi-4',               family: 'Microsoft', rec: true, tags: ['Efficiency', 'Reasoning'] },
      { id: 'google/gemma-2-27b-it',           label: 'Gemma 2 27B',         family: 'Google', tags: ['Research'] },
      { id: 'google/gemma-2-9b-it',            label: 'Gemma 2 9B',          family: 'Google', tags: ['Lightweight'] },
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B', family: 'NVIDIA', rec: true, tags: ['Enterprise', 'Reasoning'] },
      { id: 'z-ai/glm-4.5',                   label: 'GLM 4.5 (Z-AI)',      family: 'Z-AI', tags: ['Chinese', 'Lightweight'] },
      { id: 'z-ai/glm-5.2',                   label: 'GLM 5.2 (Z-AI)',      family: 'Z-AI', tags: ['Chinese'] },
      { id: 'moonshotai/kimi-k2.6',           label: 'Kimi K2.6 (Moonshot)', family: 'Moonshot', tags: ['Chinese', 'Long Context'] },
    ],
    maxTokens: parseInt(process.env.NVIDIA_MAX_TOKENS || '16384', 10),
  },

  vector: {
    apiKey: process.env.VECTOR_API_KEY,
    baseUrl: process.env.VECTOR_BASE_URL || 'https://api.vectorengine.ai/v1',
    defaultModel: 'claude-sonnet-5',
    models: [
      { id: 'claude-sonnet-5', rec: true, tags: ['Coding', 'Reasoning'] },
    ],
    maxTokens: parseInt(process.env.VECTOR_MAX_TOKENS || '16384', 10),
  },

  puter: {
    enabled: process.env.PUTER_ENABLED !== 'false',
    defaultModel: process.env.PUTER_DEFAULT_MODEL || 'claude-sonnet-5',
    models: [
      { id: 'claude-sonnet-5',    label: 'Claude Sonnet 5', rec: true, tags: ['Creative', 'Balanced'] },
      { id: 'claude-fable-5',     label: 'Claude Fable 5', tags: ['Storytelling'] },
      { id: 'claude-opus-4.8-fast', label: 'Claude Opus 4.8 Fast', rec: true, tags: ['Deep Analysis', 'Fast'] },
      { id: 'claude-opus-4-8',    label: 'Claude Opus 4.8', rec: true, tags: ['Deep Analysis', 'Reasoning'] },
      { id: 'claude-opus-4-7',    label: 'Claude Opus 4.7', tags: ['Analysis'] },
      { id: 'claude-sonnet-4-6',  label: 'Claude Sonnet 4.6', tags: ['Writing'] },
      { id: 'claude-haiku-4-5',   label: 'Claude Haiku 4.5', tags: ['Fast', 'Lightweight'] },
      { id: 'gpt-5.4-nano',       label: 'GPT-5.4 Nano', tags: ['Ultra Fast', 'Budget'] },
      { id: 'gpt-5.4-mini',       label: 'GPT-5.4 Mini', tags: ['Fast', 'Budget'] },
      { id: 'gpt-5.4',            label: 'GPT-5.4', rec: true, tags: ['General', 'Balanced'] },
    ],
  },

  // OpenAI - GPT-4, GPT-4o, GPT-4 Turbo, o1, o3
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', family: 'OpenAI', rec: true, tags: ['Fast', 'Multimodal', '128K Context', 'Tool Calling'] },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', family: 'OpenAI', tags: ['Fast', 'Cheap', '128K Context'] },
      { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', family: 'OpenAI', tags: ['Powerful', '128K Context'] },
      { id: 'gpt-4', label: 'GPT-4', family: 'OpenAI', tags: ['Powerful', '8K Context'] },
      { id: 'o1-preview', label: 'o1 Preview', family: 'OpenAI', rec: true, tags: ['Reasoning', 'Advanced', 'Complex Problems'] },
      { id: 'o1-mini', label: 'o1 Mini', family: 'OpenAI', tags: ['Reasoning', 'Fast', 'Coding'] },
      { id: 'o3-mini', label: 'o3 Mini', family: 'OpenAI', tags: ['Latest', 'Reasoning', 'Coding'] },
    ],
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '16384', 10),
    maxContextTokens: parseInt(process.env.OPENAI_MAX_CONTEXT_TOKENS || '128000', 10),
  },

  // Google Gemini - Gemini 2.0, 1.5 Pro, Flash with 2M context!
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: process.env.GEMINI_DEFAULT_MODEL || 'gemini-2.0-flash-exp',
    models: [
      { id: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash', family: 'Google', rec: true, tags: ['Fast', 'Latest', '2M Context', 'Tool Calling'] },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', family: 'Google', rec: true, tags: ['Powerful', '2M Context', 'Tool Calling'] },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', family: 'Google', tags: ['Fast', '1M Context'] },
      { id: 'gemini-1.5-flash-8b', label: 'Gemini 1.5 Flash-8B', family: 'Google', tags: ['Fast', 'Cheap', '1M Context'] },
    ],
    maxTokens: parseInt(process.env.GEMINI_MAX_TOKENS || '8192', 10),
    maxContextTokens: parseInt(process.env.GEMINI_MAX_CONTEXT_TOKENS || '2000000', 10), // 2M tokens!
  },

  // Groq - Ultra-fast inference with LPU
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: process.env.GROQ_DEFAULT_MODEL || 'llama-3.3-70b-versatile',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', family: 'Meta', rec: true, tags: ['Ultra Fast', 'Versatile', '128K Context', 'Tool Calling'] },
      { id: 'llama-3.1-70b-versatile', label: 'Llama 3.1 70B', family: 'Meta', tags: ['Ultra Fast', '128K Context'] },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', family: 'Meta', tags: ['Ultra Fast', 'Cheap', '128K Context'] },
      { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B', family: 'Mistral', tags: ['Ultra Fast', 'MoE'] },
      { id: 'gemma2-9b-it', label: 'Gemma 2 9B', family: 'Google', tags: ['Ultra Fast', 'Efficient'] },
    ],
    maxTokens: parseInt(process.env.GROQ_MAX_TOKENS || '8192', 10),
    maxContextTokens: parseInt(process.env.GROQ_MAX_CONTEXT_TOKENS || '128000', 10),
  },

  // Azure OpenAI - Enterprise GPT-4, GPT-4o with SLA
  azureOpenai: {
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-01',
    defaultModel: process.env.AZURE_OPENAI_DEFAULT_MODEL || 'gpt-4o',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o (Azure)', family: 'OpenAI', rec: true, tags: ['Fast', 'Enterprise', 'SLA', 'Tool Calling'] },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini (Azure)', family: 'OpenAI', tags: ['Fast', 'Cheap', 'Enterprise'] },
      { id: 'gpt-4-turbo', label: 'GPT-4 Turbo (Azure)', family: 'OpenAI', tags: ['Powerful', 'Enterprise'] },
      { id: 'gpt-4', label: 'GPT-4 (Azure)', family: 'OpenAI', tags: ['Powerful', 'Enterprise'] },
      { id: 'gpt-35-turbo', label: 'GPT-3.5 Turbo (Azure)', family: 'OpenAI', tags: ['Fast', 'Cheap', 'Enterprise'] },
    ],
    maxTokens: parseInt(process.env.AZURE_OPENAI_MAX_TOKENS || '16384', 10),
    maxContextTokens: parseInt(process.env.AZURE_OPENAI_MAX_CONTEXT_TOKENS || '128000', 10),
  },

  tokens: {
    dailyLimit: parseInt(process.env.DAILY_TOKEN_LIMIT || '300000000', 10),
    dailyCostLimit: parseFloat(process.env.DAILY_COST_LIMIT_USD || '50'),
  },

  context: {
    maxTurns: parseInt(process.env.CONTEXT_MAX_TURNS || '20', 10),
    maxContextTokens: parseInt(process.env.CONTEXT_MAX_TOKENS || '131072', 10),
    enableSummarization: process.env.CONTEXT_ENABLE_SUMMARIZATION !== 'false',
  },

  rag: {
    enabled: process.env.RAG_ENABLED === 'true',
    workspaceDir: process.env.RAG_WORKSPACE_DIR || process.cwd(),
    maxFileSize: parseInt(process.env.RAG_MAX_FILE_SIZE || '1048576', 10),
    chunkSize: parseInt(process.env.RAG_CHUNK_SIZE || '1000', 10),
    chunkOverlap: parseInt(process.env.RAG_CHUNK_OVERLAP || '100', 10),
    maxFiles: parseInt(process.env.RAG_MAX_FILES || '100000', 10),
    maxResults: parseInt(process.env.RAG_MAX_RESULTS || '5', 10),
    poolSize: parseInt(process.env.RAG_POOL_SIZE || '0', 10),
  },

  defaultProvider: process.env.DEFAULT_PROVIDER || 'openagentic',

  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || 'localhost',
  },

  cli: {
    colorEnabled: process.env.CLI_COLOR_ENABLED !== 'false',
    animationEnabled: process.env.CLI_ANIMATION_ENABLED !== 'false',
  },
};

export default config;
