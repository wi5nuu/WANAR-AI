import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, '..', '..', 'data', 'provider-registry.json');

let registry = null;

function loadRegistry() {
  if (registry) return registry;
  try {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    if (fs.existsSync(REGISTRY_PATH)) {
      registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    }
  } catch { /* ignore */ }
  if (!registry) {
    registry = {};
  }
  return registry;
}

function saveRegistry() {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  } catch { /* ignore */ }
}

export async function testProviderConnection(baseUrl, apiKey, model, options = {}) {
  const signal = AbortSignal.timeout(15000);
  try {
    const testMessages = [{ role: 'user', content: 'Hi, respond with exactly: OK' }];

    let response;
    if (options.format === 'anthropic') {
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
          max_tokens: 10,
        }),
        signal,
      });
    } else {
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: testMessages,
          max_tokens: 10,
        }),
        signal,
      });
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return {
        success: false,
        error: err.error?.message || err.error || `HTTP ${response.status}`,
        status: response.status,
      };
    }

    const data = await response.json();
    const ok = options.format === 'anthropic'
      ? data.content?.length > 0
      : data.choices?.length > 0;

    return {
      success: ok,
      model: data.model || model,
      error: ok ? null : 'Invalid response format from API',
    };
  } catch (err) {
    return { success: false, error: err.message || err.name || 'Connection failed' };
  }
}

export function getProviders() {
  return loadRegistry();
}

export function getProvider(name) {
  const reg = loadRegistry();
  return reg[name] || null;
}

export async function addProvider(name, config_) {
  const reg = loadRegistry();
  if (reg[name]) {
    return { success: false, error: `Provider "${name}" already exists` };
  }

  const testResult = await testProviderConnection(
    config_.baseUrl,
    config_.apiKey,
    config_.models?.[0]?.id || 'gpt-4o',
    { format: config_.format }
  );

  if (!testResult.success && config_.requireValidation !== false) {
    return {
      success: false,
      error: `Connection test failed: ${testResult.error}`,
      testResult,
    };
  }

  reg[name] = {
    label: config_.label || name,
    baseUrl: config_.baseUrl,
    apiKey: config_.apiKey,
    format: config_.format || 'openai',
    requireValidation: config_.requireValidation !== false,
    models: config_.models || [],
    validated: testResult.success,
    addedAt: new Date().toISOString(),
  };

  saveRegistry();
  return { success: true, provider: reg[name] };
}

export function removeProvider(name) {
  const reg = loadRegistry();
  if (!reg[name]) return { success: false, error: 'Provider not found' };
  delete reg[name];
  saveRegistry();
  return { success: true };
}

export async function addModel(providerName, modelId, modelLabel) {
  const reg = loadRegistry();
  const prov = reg[providerName];
  if (!prov) return { success: false, error: `Provider "${providerName}" not found` };

  if (prov.models.some(m => m.id === modelId)) {
    return { success: false, error: `Model "${modelId}" already exists for ${providerName}` };
  }

  const testResult = await testProviderConnection(prov.baseUrl, prov.apiKey, modelId, { format: prov.format });

  if (!testResult.success) {
    return {
      success: false,
      error: `Model validation failed: ${testResult.error}`,
      testResult,
    };
  }

  prov.models.push({
    id: modelId,
    label: modelLabel || modelId,
    validated: true,
    validatedAt: new Date().toISOString(),
  });

  saveRegistry();
  return { success: true, model: prov.models[prov.models.length - 1], testResult };
}

export function removeModel(providerName, modelId) {
  const reg = loadRegistry();
  const prov = reg[providerName];
  if (!prov) return { success: false, error: 'Provider not found' };
  const idx = prov.models.findIndex(m => m.id === modelId);
  if (idx === -1) return { success: false, error: 'Model not found' };
  prov.models.splice(idx, 1);
  saveRegistry();
  return { success: true };
}

export function getAllModels() {
  const reg = loadRegistry();
  const result = {};
  for (const [name, prov] of Object.entries(reg)) {
    if (prov.models.length > 0) {
      result[name] = prov.models.filter(m => m.validated !== false).map(m => ({
        id: m.id,
        label: m.label || m.id,
      }));
    }
  }
  return result;
}

export function getProviderConfig(name) {
  const reg = loadRegistry();
  const prov = reg[name];
  if (!prov) return null;
  return {
    apiKey: prov.apiKey,
    baseUrl: prov.baseUrl,
    format: prov.format || 'openai',
    validated: prov.validated,
  };
}

export class DynamicProvider {
  constructor(config) {
    this.config = config;
    this.name = config.label || 'dynamic';
  }

  async chat(messages, options = {}) {
    const model = options.model || this.config.models?.[0]?.id || 'gpt-4o';
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens || 4096,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: err.error?.message || `HTTP ${response.status}`, provider: this.name };
      }

      const data = await response.json();
      if (data.choices && data.choices.length > 0) {
        return {
          success: true,
          content: data.choices[0].message.content,
          model: data.model || model,
          usage: data.usage || { total_tokens: 0 },
          provider: this.name,
        };
      }

      return { success: false, error: 'Invalid response', provider: this.name };
    } catch (error) {
      return { success: false, error: error.message, provider: this.name };
    }
  }

  async *chatStream(messages, options = {}) {
    const model = options.model || this.config.models?.[0]?.id || 'gpt-4o';
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens || 4096,
          stream: true,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        yield { type: 'error', content: err.error?.message || `HTTP ${response.status}` };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') {
            if (trimmed === 'data: [DONE]') { yield { type: 'done' }; return; }
            continue;
          }
          if (trimmed.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              const content = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.text || '';
              if (content) yield { type: 'content', content };
              if (parsed.choices?.[0]?.finish_reason === 'stop') yield { type: 'done' };
            } catch { }
          }
        }
      }
      yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', content: error.message };
    }
  }
}

export function createDynamicProvider(name) {
  const config = getProviderConfig(name);
  if (!config) return null;
  return new DynamicProvider({ ...config, label: name });
}
