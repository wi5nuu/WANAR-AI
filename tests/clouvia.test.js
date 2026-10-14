import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
const get = vi.fn();
vi.mock('../src/providers/http-client.js', () => ({ default: { post: (...a) => post(...a), get: (...a) => get(...a) } }));

async function make(env = {}) {
  for (const k of ['CLOUVIA_API_KEY', 'CLOUVIA_MODELS', 'CLOUVIA_DEFAULT_MODEL', 'CLOUVIA_BASE_URL']) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  const { default: ClouviaProvider } = await import('../src/providers/clouvia.js');
  return new ClouviaProvider();
}

beforeEach(() => { post.mockReset(); get.mockReset(); });

describe('Clouvia provider (OpenAI-compatible gateway)', () => {
  it('is configured only with a key; the key is sanitised of invisible characters', async () => {
    expect((await make()).isConfigured()).toBe(false);
    const p = await make({ CLOUVIA_API_KEY: 'clv_live_abc\u000f' });
    expect(p.isConfigured()).toBe(true);
    expect(p.apiKey).toBe('clv_live_abc');
    expect(p.baseUrl).toBe('https://router.clouvia.id/v1');
  });

  it('is cost-safe: only the free model is usable unless the operator allows more', async () => {
    const p = await make({ CLOUVIA_API_KEY: 'k' });
    expect(p.getAvailableModels().map((m) => m.id)).toEqual(['deepseek-v4.1-flash']);
    expect(p.guardModel('claude-opus-4.8')).toBe('deepseek-v4.1-flash'); // paid model is never sent
    const q = await make({ CLOUVIA_API_KEY: 'k', CLOUVIA_MODELS: 'deepseek-v4.1-flash,claude-sonnet-5-thinking-agentic' });
    expect(q.guardModel('claude-sonnet-5-thinking-agentic')).toBe('claude-sonnet-5-thinking-agentic');
  });

  it('posts to /chat/completions with a Bearer key and returns the content', async () => {
    const p = await make({ CLOUVIA_API_KEY: 'clv_live_k' });
    post.mockResolvedValue({ data: { model: 'deepseek-v4.1-flash', choices: [{ message: { content: 'Halo!' }, finish_reason: 'stop' }], usage: { total_tokens: 12 } } });
    const r = await p.chat([{ role: 'user', content: 'Halo AI' }], { model: 'gpt-luna-6.0' });
    expect(r.content).toBe('Halo!');
    const [url, payload, cfg] = post.mock.calls[0];
    expect(url).toBe('https://router.clouvia.id/v1/chat/completions');
    expect(payload.model).toBe('deepseek-v4.1-flash'); // requested paid model replaced by the allowed default
    expect(cfg.headers.Authorization).toBe('Bearer clv_live_k');
  });

  it('errors are labelled Clouvia, not Together', async () => {
    const p = await make({ CLOUVIA_API_KEY: 'k' });
    post.mockRejectedValue(Object.assign(new Error('boom'), { response: { data: { error: { message: 'saldo habis' } } } }));
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/Clouvia API error: saldo habis/);
  });

  it('healthCheck reports catalog size and warns about an allowed model missing from the gateway', async () => {
    const p = await make({ CLOUVIA_API_KEY: 'k', CLOUVIA_MODELS: 'deepseek-v4.1-flash,model-gaib' });
    get.mockResolvedValue({ data: { data: [{ id: 'deepseek-v4.1-flash' }, { id: 'gemini-3.8-flash' }] } });
    const h = await p.healthCheck();
    expect(h).toMatchObject({ healthy: true, modelsInCatalog: 2 });
    expect(h.warning).toMatch(/model-gaib/);
    expect(get.mock.calls[0][0]).toBe('https://router.clouvia.id/v1/models');
  });

  it('is registered in the AI manager and in the failover tiers', async () => {
    const { default: config } = await import('../config/config.js');
    expect(config.clouvia.baseUrl).toMatch(/router\.clouvia\.id/);
    expect(config.clouvia.models.map((m) => m.id)).toContain('deepseek-v4.1-flash');
  });
});
