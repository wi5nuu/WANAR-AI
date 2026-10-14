import dotenv from 'dotenv';
import path from 'path';
import os from 'os';

// Baca .env dari beberapa lokasi — prioritas dari atas ke bawah:
// 1. Folder project (development)
// 2. ~/.wanar-ai/.env (global install via npm)
dotenv.config();
dotenv.config({ path: path.join(os.homedir(), '.wanar-ai', '.env') });

const config = {
  openagentic: {
    apiKey: process.env.OPENAGENTIC_API_KEY,
    baseUrl: process.env.OPENAGENTIC_BASE_URL || 'https://openagentic.id/api/v1',
    defaultModel: process.env.OPENAGENTIC_DEFAULT_MODEL || 'deepseek-v4.1-flash-free',
    // Disinkronkan dengan live API (GET /models). CATATAN: ID gateway memakai TITIK (claude-sonnet-4.6),
    // bukan dash (claude-sonnet-4-6). Ketersediaan per model bergantung plan yang aktif di akun.
    // Untuk daftar real-time sesuai plan: GET {baseUrl}/models atau endpoint /api/models/live.
    models: [
      // ===== Anthropic Claude =====
      { id: 'claude-sonnet-4.6',        label: 'Claude Sonnet 4.6',           family: 'Anthropic', rec: true, tags: ['Latest', 'Coding', 'Reasoning'], contextWindow: 1000000, maxOutput: 64000 },
      { id: 'claude-opus-4.8',          label: 'Claude Opus 4.8',             family: 'Anthropic', rec: true, tags: ['Most Capable', 'Deep Analysis'], contextWindow: 1000000, maxOutput: 65000 },
      { id: 'claude-opus-4.8-thinking', label: 'Claude Opus 4.8 Thinking',    family: 'Anthropic', tags: ['Reasoning', 'Extended Thinking'], contextWindow: 1000000, maxOutput: 65000 },
      { id: 'claude-opus-5',            label: 'Claude Opus 5',               family: 'Anthropic', tags: ['Newest', 'Frontier'], contextWindow: 1000000, maxOutput: 65000 },

      // ===== OpenAI GPT =====
      { id: 'gpt-5.6-luna',             label: 'GPT-5.6 Luna',                family: 'OpenAI', rec: true, tags: ['Latest', 'Multimodal'], contextWindow: 1000000, maxOutput: 65000 },
      { id: 'gpt-5.6-sol',              label: 'GPT-5.6 Sol',                 family: 'OpenAI', tags: ['Fast', 'Multimodal'], contextWindow: 1000000, maxOutput: 65000 },
      { id: 'gpt-5.6-terra',            label: 'GPT-5.6 Terra',               family: 'OpenAI', tags: ['Balanced', 'Multimodal'], contextWindow: 1000000, maxOutput: 65000 },

      // ===== Google Gemini =====
      { id: 'gemini-3.5-flash',         label: 'Gemini 3.5 Flash',            family: 'Google', rec: true, tags: ['Fast', 'Latest'], contextWindow: 1000000, maxOutput: 65536 },
      { id: 'gemini-3.1-pro',           label: 'Gemini 3.1 Pro',              family: 'Google', rec: true, tags: ['Powerful', 'Reasoning'], contextWindow: 1000000, maxOutput: 65536 },
      { id: 'gemini-3.8-flash-high',    label: 'Gemini 3.8 Flash High',       family: 'Google', tags: ['Fast', 'High Quality'], contextWindow: 1000000, maxOutput: 65536 },

      // ===== DeepSeek =====
      { id: 'deepseek-v4-flash',        label: 'DeepSeek V4 Flash',           family: 'DeepSeek', rec: true, tags: ['Coding', 'Fast'], contextWindow: 1000000, maxOutput: 65536 },
      { id: 'deepseek-v4-flash-free',   label: 'DeepSeek V4 Flash (Free)',    family: 'DeepSeek', tags: ['FREE', 'Coding', 'Fast'], contextWindow: 1000000, maxOutput: 65536 },
      { id: 'deepseek-v4-flash-0731',   label: 'DeepSeek V4 Flash 0731',      family: 'DeepSeek', tags: ['Coding', 'Fast'], contextWindow: 1000000, maxOutput: 65536 },
      { id: 'deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision', family: 'DeepSeek', tags: ['Vision', 'Experimental'], contextWindow: 1000000, maxOutput: 65536 },
      { id: 'deepseek-v4.1-flash-free', label: 'DeepSeek V4.1 Flash (Free)',  family: 'DeepSeek', tags: ['FREE', 'Coding', 'Fast'], contextWindow: 1000000, maxOutput: 65536 },
      { id: 'deepseek-v4-pro-0813',     label: 'DeepSeek V4 Pro',             family: 'DeepSeek', tags: ['Coding', 'Powerful'], contextWindow: 1000000, maxOutput: 65536 },

      // ===== Qwen / Alibaba =====
      { id: 'qwen3.8-flash-free',       label: 'Qwen3.8 Flash (Free)',        family: 'Alibaba', tags: ['FREE', 'Fast'], contextWindow: 1000000, maxOutput: 65536 },
      { id: 'qwen3.8-max',              label: 'Qwen3.8 Max',                 family: 'Alibaba', rec: true, tags: ['Powerful'], contextWindow: 1000000, maxOutput: 65000 },
      { id: 'qwen3.7-max',              label: 'Qwen3.7 Max',                 family: 'Alibaba', tags: ['Powerful'], contextWindow: 1000000, maxOutput: 65000 },
      { id: 'qwen3.6-plus',             label: 'Qwen3.6 Plus',                family: 'Alibaba', tags: ['Balanced'], contextWindow: 1000000, maxOutput: 65536 },

      // ===== Moonshot Kimi =====
      { id: 'kimi-k3',                  label: 'Kimi K3',                     family: 'Moonshot', rec: true, tags: ['Long Context', 'Coding'], contextWindow: 1000000 },
      { id: 'kimi-k3-high',             label: 'Kimi K3 High',                family: 'Moonshot', tags: ['Long Context', 'High Quality'], contextWindow: 1000000 },
      { id: 'kimi-k3-low',              label: 'Kimi K3 Low',                 family: 'Moonshot', tags: ['Long Context', 'Fast'], contextWindow: 1000000 },
      { id: 'kimi-k2.7-code',           label: 'Kimi K2.7 Code',              family: 'Moonshot', tags: ['Coding'], contextWindow: 1000000 },

      // ===== Mistral / MiniMax / Muse Spark =====
      { id: 'mistral-large-3',          label: 'Mistral Large 3',             family: 'Mistral', tags: ['Powerful', 'Reasoning'], contextWindow: 256000 },
      { id: 'minimax-m3-free',          label: 'MiniMax M3 (Free)',           family: 'MiniMax', tags: ['FREE', 'Fast'], contextWindow: 1000000 },
      { id: 'muse-spark-1.3-free',      label: 'Muse Spark 1.3 (Free)',       family: 'Meta', tags: ['FREE', 'Reasoning'], contextWindow: 1000000 },

      // ===== Zhipu GLM =====
      { id: 'glm-5.3-flash',            label: 'GLM 5.3 Flash',               family: 'Zhipu', rec: true, tags: ['Fast', 'Tool Calling', 'Plan-friendly'], contextWindow: 1000000, maxOutput: 16384 },
      { id: 'glm-5.3',                  label: 'GLM 5.3',                     family: 'Zhipu', tags: ['Powerful'], contextWindow: 1000000, maxOutput: 65536 },
      { id: 'glm-5.2',                  label: 'GLM 5.2',                     family: 'Zhipu', tags: ['Stable'], contextWindow: 1000000, maxOutput: 65536 },
      { id: 'glm-5.1',                  label: 'GLM 5.1',                     family: 'Zhipu', tags: ['Stable'], contextWindow: 1000000, maxOutput: 65536 },

      // ===== xAI Grok =====
      { id: 'grok-4.5',                 label: 'Grok 4.5',                    family: 'xAI', rec: true, tags: ['Powerful', 'Reasoning'], contextWindow: 1000000, maxOutput: 65536 },

      // ===== Image (output gambar) =====
      { id: 'ali-z-image-turbo',        label: 'Z Image Turbo (Free)',        family: 'Alibaba', tags: ['FREE', 'Image', 'Text-to-Image'], contextWindow: 4096, maxOutput: 4096 },
    ],
    // Model yang DILARANG dipakai di sistem ini. Jika ada request/pilihan model memakai id ini,
    // provider otomatis memetakan ke varian "-free" (contoh: deepseek-v4.1-flash -> deepseek-v4.1-flash-free).
    blockedModels: ['deepseek-v4.1-flash'],
    // Batas OUTPUT (bukan context window), dipakai bila model tidak ada di maxTokensByModel.
    maxTokens: parseInt(process.env.OPENAGENTIC_MAX_TOKENS || '16000', 10),
    // max_tokens per model — nilai conservative, naikkan per model setelah probe ceiling upstream.
    // Terverifikasi: glm-5.3-flash menolak 200000 (upstream 503 "All accounts failed"); 16000 OK.
    maxTokensByModel: {
      'default': 16000,
      'glm-5.3-flash': 16000,
      'glm-5.3': 32000,
      'glm-5.2': 32000,
      'glm-5.1': 32000,
      'claude-sonnet-4.6': 64000,
      'claude-opus-4.8': 32000,
      'claude-opus-4.8-thinking': 32000,
      'claude-opus-5': 32000,
      'gpt-5.6-luna': 32000,
      'gpt-5.6-sol': 32000,
      'gpt-5.6-terra': 32000,
      'gemini-3.5-flash': 32000,
      'gemini-3.1-pro': 32000,
      'gemini-3.8-flash-high': 32000,
      'deepseek-v4-flash': 32000,
      'deepseek-v4-flash-free': 16000,
      'deepseek-v4-flash-0731': 32000,
      'deepseek-v4-flash-vision-exp': 16000,
      'deepseek-v4.1-flash-free': 16000,
      'deepseek-v4-pro-0813': 32000,
      'qwen3.8-flash-free': 16000,
      'qwen3.8-max': 32000,
      'qwen3.7-max': 32000,
      'qwen3.6-plus': 32000,
      'kimi-k3': 32000,
      'kimi-k3-high': 32000,
      'kimi-k3-low': 16000,
      'kimi-k2.7-code': 32000,
      'mistral-large-3': 32000,
      'minimax-m3-free': 16000,
      'muse-spark-1.3-free': 16000,
      'grok-4.5': 32000,
      'ali-z-image-turbo': 4096,
    },
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
    defaultModel: process.env.NVIDIA_DEFAULT_MODEL || 'nvidia/nemotron-3-super-120b-a12b',
    models: [
      // Verified working via free endpoint (tested 2026-08-26)
      { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B', family: 'NVIDIA', rec: true, tags: ['FREE', 'Reasoning', 'MoE', '1M Context'] },
      { id: 'minimaxai/minimax-m3', label: 'MiniMax M3', family: 'MiniMax', rec: true, tags: ['FREE', 'Fast'] },
      { id: 'meta/muse-glimmer-30b', label: 'Muse Glimmer 30B', family: 'Meta', tags: ['FREE'] },
      { id: 'deepseek-ai/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash', family: 'DeepSeek', tags: ['FREE', 'Coding', '1M Context'] },
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3', family: 'Moonshot', tags: ['FREE', 'Long Context'] },
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

  // ===== FREE PROVIDERS =====

  // OpenRouter — satu API untuk ratusan model, termasuk varian `:free`.
  // AUTO-SWITCH: bila model pilihan kena rate-limit/kuota/hilang, provider
  // otomatis pindah ke model gratis berikutnya (lihat src/providers/openrouter.js).
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    defaultModel: process.env.OPENROUTER_DEFAULT_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free',
    autoSwitchFree: process.env.OPENROUTER_AUTO_SWITCH_FREE !== 'false',
    referer: process.env.OPENROUTER_HTTP_REFERER || '',
    title: process.env.OPENROUTER_X_TITLE || 'Wanar AI',
    // Urutan prioritas fallback model gratis (diurutkan dari yang paling
    // stabil & cepat berdasarkan pengujian langsung ke katalog OpenRouter).
    // `openrouter/free` adalah router resmi OpenRouter yang selalu tersedia —
    // jaring pengaman sebelum kandidat dicocokkan lagi ke katalog live.
    freeModels: (process.env.OPENROUTER_FREE_MODELS ||
      'nvidia/nemotron-3-super-120b-a12b:free,openrouter/free,cohere/north-mini-code:free,' +
      'nvidia/nemotron-3.5-lightning:free,nvidia/nemotron-3-ultra-550b-a55b:free,' +
      'poolside/laguna-s-2.1:free,liquid/lfm-2.5-2.6b:free,google/gemma-4-31b-it:free,' +
      'google/gemma-4-26b-a4b-it:free'
    ).split(',').map(s => s.trim()).filter(Boolean),
    models: [
      // ── GRATIS (target auto-switch; diverifikasi langsung ke katalog OpenRouter) ──
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B (Free)', family: 'NVIDIA', rec: true, tags: ['FREE', 'Fast', 'Auto-Switch'] },
      { id: 'openrouter/free', label: 'Auto Free Router', family: 'OpenRouter', rec: true, tags: ['FREE', 'Always Available', 'Fallback'] },
      { id: 'cohere/north-mini-code:free', label: 'North Mini Code (Free)', family: 'Cohere', rec: true, tags: ['FREE', 'Coding'] },
      { id: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning (Free)', family: 'NVIDIA', tags: ['FREE', 'Ultra Fast'] },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B (Free)', family: 'NVIDIA', tags: ['FREE', 'Largest'] },
      { id: 'poolside/laguna-s-2.1:free', label: 'Laguna S 2.1 (Free)', family: 'Poolside', tags: ['FREE'] },
      { id: 'liquid/lfm-2.5-2.6b:free', label: 'LFM 2.5 2.6B (Free)', family: 'Liquid', tags: ['FREE', 'Tiny', 'Fast'] },
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (Free)', family: 'Google', tags: ['FREE', 'Sering penuh (429)'] },
      { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B (Free)', family: 'Google', tags: ['FREE', 'MoE', 'Sering penuh (429)'] },
      // ── BERBAYAR (bila kuota gratis habis; otomatis pindah ke gratis saat gagal) ──
      { id: 'deepseek/deepseek-chat-v3', label: 'DeepSeek Chat V3 (Paid)', family: 'DeepSeek', tags: ['Paid', 'Coding'] },
      { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B (Paid)', family: 'NVIDIA', tags: ['Paid'] },
      { id: 'google/gemma-4-31b-it', label: 'Gemma 4 31B (Paid)', family: 'Google', tags: ['Paid'] },
    ],
    maxTokens: parseInt(process.env.OPENROUTER_MAX_TOKENS || '8192', 10),
    maxContextTokens: parseInt(process.env.OPENROUTER_MAX_CONTEXT_TOKENS || '131072', 10),
  },

  // OpenCode Router - Access ALL FREE models via local OpenCode
  opencode: {
    apiKey: process.env.OPENCODE_API_KEY || 'sk-9router',
    baseUrl: process.env.OPENCODE_BASE_URL || 'http://localhost:20128/v1',
    defaultModel: process.env.OPENCODE_DEFAULT_MODEL || 'ox-alpha',
    models: [
      // Ox Alpha - OpenCode's primary model (FREE & UNLIMITED)
      { id: 'ox-alpha', label: 'Ox Alpha Free (Unlimited)', family: 'OpenCode', rec: true, tags: ['FREE', 'Unlimited', 'OpenCode', 'Primary'] },
      
      // DeepSeek Models (FREE via OpenCode)
      { id: 'kc/deepseek/deepseek-chat', label: 'DeepSeek Chat (OpenCode)', family: 'DeepSeek', rec: true, tags: ['FREE', 'Unlimited', 'Coding', 'OpenCode'] },
      { id: 'kc/deepseek/deepseek-reasoner', label: 'DeepSeek Reasoner (OpenCode)', family: 'DeepSeek', rec: true, tags: ['FREE', 'Reasoning', 'OpenCode'] },
      
      // Llama Models (FREE via OpenCode)
      { id: 'kc/meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (OpenCode)', family: 'Meta', rec: true, tags: ['FREE', 'Powerful', 'OpenCode'] },
      { id: 'kc/meta-llama/llama-3.1-405b-instruct', label: 'Llama 3.1 405B (OpenCode)', family: 'Meta', rec: true, tags: ['FREE', 'Largest', 'OpenCode'] },
      { id: 'kc/meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B (OpenCode)', family: 'Meta', tags: ['FREE', 'OpenCode'] },
      { id: 'kc/meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B (OpenCode)', family: 'Meta', tags: ['FREE', 'Fast', 'OpenCode'] },
      
      // Qwen Models (FREE via OpenCode)
      { id: 'kc/qwen/qwen2.5-72b-instruct', label: 'Qwen 2.5 72B (OpenCode)', family: 'Alibaba', rec: true, tags: ['FREE', 'Multilingual', 'OpenCode'] },
      { id: 'kc/qwen/qwen2.5-coder-32b-instruct', label: 'Qwen 2.5 Coder 32B (OpenCode)', family: 'Alibaba', rec: true, tags: ['FREE', 'Coding', 'OpenCode'] },
      
      // Mistral Models (FREE via OpenCode)
      { id: 'kc/mistralai/mixtral-8x7b-instruct', label: 'Mixtral 8x7B (OpenCode)', family: 'Mistral', tags: ['FREE', 'MoE', 'OpenCode'] },
      { id: 'kc/mistralai/mistral-nemo-instruct', label: 'Mistral NeMo (OpenCode)', family: 'Mistral', tags: ['FREE', 'OpenCode'] },
      
      // Google Models (FREE via OpenCode)
      { id: 'kc/google/gemma-2-27b-it', label: 'Gemma 2 27B (OpenCode)', family: 'Google', tags: ['FREE', 'OpenCode'] },
      
      // Microsoft Models (FREE via OpenCode)
      { id: 'kc/microsoft/phi-3.5-mini-instruct', label: 'Phi-3.5 Mini (OpenCode)', family: 'Microsoft', tags: ['FREE', 'Fast', 'OpenCode'] },
    ],
    maxTokens: parseInt(process.env.OPENCODE_MAX_TOKENS || '8192', 10),
    maxContextTokens: parseInt(process.env.OPENCODE_MAX_CONTEXT_TOKENS || '200000', 10),
  },

  // Cerebras - Ultra-Fast Inference - FREE tier (quota-based)
  cerebras: {
    apiKey: process.env.CEREBRAS_API_KEY,
    baseUrl: process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
    defaultModel: process.env.CEREBRAS_DEFAULT_MODEL || 'gpt-oss-120b',
    models: [
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B (Cerebras)', family: 'OpenAI', rec: true, tags: ['FREE Tier', 'Ultra Fast', '128K Context'] },
      { id: 'gemma-4-31b', label: 'Gemma 4 31B (Cerebras)', family: 'Google', tags: ['FREE Tier', 'Ultra Fast'] },
    ],
    maxTokens: parseInt(process.env.CEREBRAS_MAX_TOKENS || '8192', 10),
    maxContextTokens: parseInt(process.env.CEREBRAS_MAX_CONTEXT_TOKENS || '128000', 10),
  },

  // SambaNova - Llama 405B/70B/8B - FREE & UNLIMITED
  sambanova: {
    apiKey: process.env.SAMBANOVA_API_KEY,
    baseUrl: process.env.SAMBANOVA_BASE_URL || 'https://api.sambanova.ai/v1',
    defaultModel: process.env.SAMBANOVA_DEFAULT_MODEL || 'llama-3.1-405b',
    models: [
      { id: 'llama-3.1-405b', label: 'Llama 3.1 405B (SambaNova)', family: 'Meta', rec: true, tags: ['FREE', 'Largest', '405B Params', '128K Context'] },
      { id: 'llama-3.1-70b', label: 'Llama 3.1 70B (SambaNova)', family: 'Meta', tags: ['FREE', 'Powerful', '128K Context'] },
      { id: 'llama-3.1-8b', label: 'Llama 3.1 8B (SambaNova)', family: 'Meta', tags: ['FREE', 'Fast', '128K Context'] },
      { id: 'llama-3.2-3b', label: 'Llama 3.2 3B (SambaNova)', family: 'Meta', tags: ['FREE', 'Lightweight'] },
      { id: 'llama-3.2-1b', label: 'Llama 3.2 1B (SambaNova)', family: 'Meta', tags: ['FREE', 'Ultra Light'] },
    ],
    maxTokens: parseInt(process.env.SAMBANOVA_MAX_TOKENS || '8192', 10),
    maxContextTokens: parseInt(process.env.SAMBANOVA_MAX_CONTEXT_TOKENS || '128000', 10),
  },

  // Hyperbolic - DeepSeek V3, Qwen 2.5 72B, Llama 405B - FREE
  hyperbolic: {
    apiKey: process.env.HYPERBOLIC_API_KEY,
    baseUrl: process.env.HYPERBOLIC_BASE_URL || 'https://api.hyperbolic.xyz/v1',
    defaultModel: process.env.HYPERBOLIC_DEFAULT_MODEL || 'deepseek-ai/DeepSeek-V3',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3 (Hyperbolic)', family: 'DeepSeek', rec: true, tags: ['FREE', 'Coding', 'Latest', '128K Context'] },
      { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B (Hyperbolic)', family: 'Alibaba', rec: true, tags: ['FREE', 'Multilingual', '128K Context'] },
      { id: 'meta-llama/Llama-3.1-405B-Instruct', label: 'Llama 3.1 405B (Hyperbolic)', family: 'Meta', tags: ['FREE', 'Largest', '128K Context'] },
      { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B (Hyperbolic)', family: 'Meta', tags: ['FREE', 'Latest'] },
      { id: 'meta-llama/Llama-3.1-70B-Instruct', label: 'Llama 3.1 70B (Hyperbolic)', family: 'Meta', tags: ['FREE', 'Stable'] },
      { id: 'NousResearch/Hermes-3-Llama-3.1-70B', label: 'Hermes 3 70B (Hyperbolic)', family: 'NousResearch', tags: ['FREE', 'Instruct-Tuned'] },
    ],
    maxTokens: parseInt(process.env.HYPERBOLIC_MAX_TOKENS || '8192', 10),
    maxContextTokens: parseInt(process.env.HYPERBOLIC_MAX_CONTEXT_TOKENS || '128000', 10),
  },

  // HuggingFace - Community Models - FREE (Rate Limited)
  huggingface: {
    apiKey: process.env.HUGGINGFACE_API_KEY,
    baseUrl: process.env.HUGGINGFACE_BASE_URL || 'https://api-inference.huggingface.co/models',
    defaultModel: process.env.HUGGINGFACE_DEFAULT_MODEL || 'meta-llama/Llama-3.3-70B-Instruct',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B (HF)', family: 'Meta', rec: true, tags: ['FREE', 'Open Source', '128K Context'] },
      { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B (HF)', family: 'Alibaba', rec: true, tags: ['FREE', 'Multilingual'] },
      { id: 'mistralai/Mistral-Nemo-Instruct-2407', label: 'Mistral NeMo 12B (HF)', family: 'Mistral', tags: ['FREE', 'Fast'] },
      { id: 'microsoft/Phi-3.5-mini-instruct', label: 'Phi-3.5 Mini (HF)', family: 'Microsoft', tags: ['FREE', 'Lightweight'] },
      { id: 'google/gemma-2-27b-it', label: 'Gemma 2 27B (HF)', family: 'Google', tags: ['FREE', 'Open'] },
      { id: 'NousResearch/Hermes-3-Llama-3.1-8B', label: 'Hermes 3 8B (HF)', family: 'NousResearch', tags: ['FREE', 'Fast'] },
    ],
    maxTokens: parseInt(process.env.HUGGINGFACE_MAX_TOKENS || '8192', 10),
    maxContextTokens: parseInt(process.env.HUGGINGFACE_MAX_CONTEXT_TOKENS || '128000', 10),
  },

  // Clouvia Router - gateway OpenAI-compatible (https://router.clouvia.id). Akun punya saldo
  // BERBAYAR di samping gratis, jadi hanya model di CLOUVIA_MODELS yang boleh dipakai
  // (bawaan: deepseek-v4.1-flash yang gratis). Lihat src/providers/clouvia.js.
  clouvia: {
    apiKey: process.env.CLOUVIA_API_KEY,
    baseUrl: process.env.CLOUVIA_BASE_URL || 'https://router.clouvia.id/v1',
    defaultModel: process.env.CLOUVIA_DEFAULT_MODEL || 'deepseek-v4.1-flash',
    models: (process.env.CLOUVIA_MODELS || 'deepseek-v4.1-flash').split(',').map((s) => s.trim()).filter(Boolean).map((id, i) => ({
      id,
      label: id === 'deepseek-v4.1-flash' ? 'DeepSeek V4.1 Flash (Clouvia, gratis)' : id + ' (Clouvia)',
      family: 'Clouvia',
      rec: i === 0,
      tags: id === 'deepseek-v4.1-flash' ? ['FREE', 'Fast', 'Coding'] : ['Clouvia'],
    })),
    maxTokens: parseInt(process.env.CLOUVIA_MAX_TOKENS || '8192', 10),
    maxContextTokens: parseInt(process.env.CLOUVIA_MAX_CONTEXT_TOKENS || '128000', 10),
  },

  // Together AI - Free $25 Credit
  together: {
    apiKey: process.env.TOGETHER_API_KEY,
    baseUrl: process.env.TOGETHER_BASE_URL || 'https://api.together.xyz/v1',
    defaultModel: process.env.TOGETHER_DEFAULT_MODEL || 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
    models: [
      { id: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', label: 'Llama 3.1 405B Turbo (Together)', family: 'Meta', rec: true, tags: ['$25 Free', 'Largest', 'Turbo', '130K Context'] },
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo (Together)', family: 'Meta', rec: true, tags: ['$25 Free', 'Fast', '128K Context'] },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', label: 'Qwen 2.5 72B Turbo (Together)', family: 'Alibaba', tags: ['$25 Free', 'Multilingual'] },
      { id: 'deepseek-ai/deepseek-llm-67b-chat', label: 'DeepSeek 67B (Together)', family: 'DeepSeek', tags: ['$25 Free', 'Coding'] },
      { id: 'NousResearch/Nous-Hermes-2-Yi-34B', label: 'Hermes 2 Yi 34B (Together)', family: 'NousResearch', tags: ['$25 Free'] },
      { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', label: 'Mixtral 8x7B (Together)', family: 'Mistral', tags: ['$25 Free', 'MoE'] },
    ],
    maxTokens: parseInt(process.env.TOGETHER_MAX_TOKENS || '8192', 10),
    maxContextTokens: parseInt(process.env.TOGETHER_MAX_CONTEXT_TOKENS || '128000', 10),
  },

  // Fireworks AI - Free Tier with Coding Models
  fireworks: {
    apiKey: process.env.FIREWORKS_API_KEY,
    baseUrl: process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1',
    defaultModel: process.env.FIREWORKS_DEFAULT_MODEL || 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    models: [
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B (Fireworks)', family: 'Meta', rec: true, tags: ['Free Tier', 'Fast', '128K Context'] },
      { id: 'accounts/fireworks/models/llama-v3p1-405b-instruct', label: 'Llama 3.1 405B (Fireworks)', family: 'Meta', rec: true, tags: ['Free Tier', 'Largest'] },
      { id: 'accounts/fireworks/models/qwen2p5-coder-32b-instruct', label: 'Qwen 2.5 Coder 32B (Fireworks)', family: 'Alibaba', tags: ['Free Tier', 'Coding', 'Specialized'] },
      { id: 'accounts/fireworks/models/deepseek-coder-v2-instruct', label: 'DeepSeek Coder V2 (Fireworks)', family: 'DeepSeek', tags: ['Free Tier', 'Coding'] },
      { id: 'accounts/fireworks/models/mixtral-8x22b-instruct', label: 'Mixtral 8x22B (Fireworks)', family: 'Mistral', tags: ['Free Tier', 'MoE', '65K Context'] },
      { id: 'accounts/fireworks/models/qwen2p5-72b-instruct', label: 'Qwen 2.5 72B (Fireworks)', family: 'Alibaba', tags: ['Free Tier', 'Multilingual'] },
    ],
    maxTokens: parseInt(process.env.FIREWORKS_MAX_TOKENS || '16384', 10),
    maxContextTokens: parseInt(process.env.FIREWORKS_MAX_CONTEXT_TOKENS || '128000', 10),
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
