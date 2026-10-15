/**
 * Live system map: trace hub, AIManager tracing (route, attempts, failover,
 * usage, tools), rate-limit header capture and the guarded API.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import AIManager from '../src/ai-manager.js';
import { SmartFailover } from '../src/ai-failover.js';
import { TraceHub, traceHub, redact, estimateTokens } from '../src/observability/trace-hub.js';
import { parseRateHeaders, recordResponseHeaders, headerQuotaFor, providerApiQuota, _resetQuotaState } from '../src/observability/quota.js';
import { createSystemMapRouter, describeProviders } from '../src/observability/routes.js';
import { TelegramInbox } from '../src/automation/telegram-inbox.js';

function streamProvider({ name, text = 'halo', fail = null, usage = null, available = true, defaultModel = 'm1' }) {
  return {
    name,
    defaultModel,
    isAvailable: () => available,
    getAvailableModels: () => [{ id: defaultModel }],
    async *chatStream() {
      if (fail) { yield { type: 'error', content: fail }; return; }
      if (usage) yield { type: 'usage', usage };
      for (const ch of text) yield { type: 'content', content: ch };
      yield { type: 'done' };
    },
  };
}

function managerWith(providers, primary) {
  const m = new AIManager();
  m.providers = providers;
  m.currentProvider = primary;
  m.failover = new SmartFailover(providers, {}, {});
  return m;
}

async function drain(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('trace hub', () => {
  it('carries the active trace across awaits and records steps', async () => {
    const hub = new TraceHub();
    const t = hub.start({ channel: 'telegram', title: 'x', input: 'halo' });
    await hub.run(t, async () => {
      await new Promise((r) => setTimeout(r, 5));
      hub.step('receive', { chars: 4 });
      expect(hub.current().id).toBe(t.id);
    });
    expect(hub.current()).toBeNull();
    expect(t.events.map((e) => e.type)).toEqual(['receive']);
  });

  it('withTrace reuses an active trace instead of nesting', async () => {
    const hub = new TraceHub();
    let inner = null;
    await hub.withTrace({ channel: 'web' }, async (outer) => {
      await hub.withTrace({ channel: 'system' }, async (t) => { inner = t; });
      expect(inner.id).toBe(outer.id);
    });
    expect(hub.list().length).toBe(1);
  });

  it('marks a trace as error when every provider failed and nothing came out', async () => {
    const hub = new TraceHub();
    await hub.withTrace({ channel: 'web' }, async () => { hub.step('all_failed', { error: 'x' }); return ''; });
    expect(hub.list()[0].status).toBe('error');
  });

  it('keeps only the newest traces (ring buffer)', () => {
    const hub = new TraceHub({ max: 3 });
    for (let i = 0; i < 5; i++) hub.start({ title: `t${i}` });
    expect(hub.list().map((t) => t.title)).toEqual(['t4', 't3', 't2']);
  });

  it('masks credentials in text and nested data', () => {
    expect(redact('key clv_live_abcdefgh12345678 ok')).not.toContain('abcdefgh12345678');
    expect(redact('Authorization: Bearer abcdefghijklmnop1234')).toContain('Bearer ••••');
    expect(redact('password=rahasia123 lanjut')).not.toContain('rahasia123');
    const hub = new TraceHub();
    const t = hub.start({});
    hub.step('tool_start', { args: { token: 'x', nested: { k: 'sk-abcdefghijklmnopqrstuvwx' } } }, t);
    expect(JSON.stringify(t.events[0])).not.toContain('abcdefghijklmnopqrstuvwx');
  });

  it('estimates tokens', () => {
    expect(estimateTokens('a'.repeat(36))).toBe(10);
  });
});

describe('AIManager tracing', () => {
  beforeEach(() => traceHub.clear());

  it('records route, attempt, first token, success and real usage for one request', async () => {
    const m = managerWith({ a: streamProvider({ name: 'a', text: 'jawaban', usage: { prompt_tokens: 12, completion_tokens: 3 } }) }, 'a');
    const usages = [];
    m.onUsage = (u) => usages.push(u);
    const trace = traceHub.start({ channel: 'telegram', title: 't' });
    const events = await traceHub.run(trace, () => drain(m.chatStream([{ role: 'user', content: 'hai' }], {})));
    expect(events.map((e) => e.type)).not.toContain('usage'); // consumed, not leaked to callers
    const types = trace.events.map((e) => e.type);
    expect(types).toEqual(['context', 'route', 'attempt', 'first_token', 'success', 'usage']);
    const route = trace.events.find((e) => e.type === 'route');
    expect(route.source).toBe('default');
    expect(route.requested).toEqual({ provider: 'a', model: 'm1' });
    expect(trace.tokens).toMatchObject({ prompt: 12, completion: 3, total: 15, estimated: false });
    expect(trace.provider).toBe('a');
    expect(usages[0]).toMatchObject({ provider: 'a', model: 'm1', total: 15, estimated: false, channel: 'telegram' });
  });

  it('records the failure reason and the provider that took over', async () => {
    const m = managerWith({
      a: streamProvider({ name: 'a', fail: 'Payment required (402): insufficient credits' }),
      b: streamProvider({ name: 'b', text: 'oke', defaultModel: 'b1' }),
    }, 'a');
    const trace = traceHub.start({ channel: 'web' });
    await traceHub.run(trace, () => drain(m.chatStream([{ role: 'user', content: 'hai' }], { provider: 'a', routeSource: 'web-form' })));
    const fail = trace.events.find((e) => e.type === 'fail');
    expect(fail).toMatchObject({ provider: 'a', reason: 'quota' });
    const route = trace.events.find((e) => e.type === 'route');
    expect(route.source).toBe('web-form');
    expect(trace.provider).toBe('b');
    expect(trace.tokens.estimated).toBe(true);
    // the next request explains WHY a is skipped
    const next = traceHub.start({ channel: 'web' });
    await traceHub.run(next, () => drain(m.chatStream([{ role: 'user', content: 'lagi' }], { provider: 'b' })));
    const r2 = next.events.find((e) => e.type === 'route');
    expect(r2.chain.find((c) => c.provider === 'a').skip).toMatchObject({ why: 'quota' });
  });

  it('never tries the default model twice when no model was requested', async () => {
    const a = { ...streamProvider({ name: 'a', fail: 'user quota is not enough' }), getAvailableModels: () => [{ id: 'm1' }, { id: 'm2' }] };
    const m = managerWith({ a, b: streamProvider({ name: 'b', text: 'ok', defaultModel: 'b1' }) }, 'a');
    const trace = traceHub.start({ channel: 'web' });
    await traceHub.run(trace, () => drain(m.chatStream([{ role: 'user', content: 'hai' }], { provider: 'a' })));
    const tried = trace.events.filter((e) => e.type === 'attempt').map((e) => `${e.provider}/${e.model}`);
    expect(tried).toEqual(['a/m1', 'a/m2', 'b/b1']);
  });

  it('an empty answer fails over instead of returning nothing', async () => {
    const m = managerWith({
      a: streamProvider({ name: 'a', text: '' }),
      b: streamProvider({ name: 'b', text: 'ada', defaultModel: 'b1' }),
    }, 'a');
    const events = await drain(m.chatStream([{ role: 'user', content: 'hai' }], {}));
    expect(events.filter((e) => e.type === 'content').map((e) => e.content).join('')).toBe('ada');
  });

  it('opens its own trace when the caller did not (system channel) and closes it', async () => {
    const m = managerWith({ a: streamProvider({ name: 'a', text: 'ok' }) }, 'a');
    await drain(m.chatStream([{ role: 'user', content: 'cek' }], {}));
    const [t] = traceHub.list();
    expect(t).toMatchObject({ channel: 'system', status: 'ok', output: 'ok', input: 'cek' });
  });

  it('a consumer that stops early leaves a "stopped" trace, not a running one', async () => {
    const m = managerWith({ a: streamProvider({ name: 'a', text: 'panjang sekali' }) }, 'a');
    for await (const ev of m.chatStream([{ role: 'user', content: 'x' }], {})) { if (ev.type === 'content') break; }
    expect(traceHub.list()[0].status).toBe('stopped');
  });
});

describe('quota sources', () => {
  beforeEach(() => _resetQuotaState());

  it('reads OpenAI-style and Anthropic-style rate-limit headers', () => {
    expect(parseRateHeaders({ 'X-RateLimit-Remaining-Requests': '99', 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-tokens': '5000' }).info)
      .toMatchObject({ remainingRequests: '99', limitRequests: '100', remainingTokens: '5000' });
    expect(parseRateHeaders({ 'anthropic-ratelimit-tokens-remaining': '777' }).info.remainingTokens).toBe('777');
    expect(parseRateHeaders({ 'content-type': 'json' })).toBeNull();
  });

  it('remembers the last headers per provider host', () => {
    recordResponseHeaders('https://router.clouvia.id/v1/chat/completions', 200, { 'x-ratelimit-remaining-requests': '42' });
    expect(headerQuotaFor('https://router.clouvia.id/v1').info.remainingRequests).toBe('42');
    expect(headerQuotaFor('https://openrouter.ai/api/v1')).toBeNull();
  });

  it('asks OpenRouter for the key credit and caches it', async () => {
    let calls = 0;
    const fetcher = { get: async (url, opts) => { calls++; expect(url).toBe('https://openrouter.ai/api/v1/key'); expect(opts.headers.Authorization).toBe('Bearer k'); return { data: { data: { limit: 10, usage: 2.5, is_free_tier: false } } }; } };
    const inst = { apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1' };
    const q = await providerApiQuota('openrouter', inst, { fetcher });
    expect(q).toMatchObject({ creditLimit: 10, creditUsed: 2.5, creditRemaining: 7.5, freeTier: false });
    await providerApiQuota('openrouter', inst, { fetcher });
    expect(calls).toBe(1);
    expect(await providerApiQuota('clouvia', { apiKey: 'x' }, { fetcher })).toBeNull(); // no published API: nothing guessed
  });
});

describe('system map API', () => {
  const env = { AUTOMATION_TOKEN: 'tok' };

  function app(hub) {
    const m = managerWith({
      a: streamProvider({ name: 'a' }),
      off: streamProvider({ name: 'off', available: false }),
    }, 'a');
    const db = { getDailyUsage: () => ({ total: 120, cost: 0, providers: { a: 120 }, models: { 'a:m1': 120 } }) };
    const x = express();
    x.use('/api/system-map', createSystemMapRouter({ aiManager: m, db, config: { tokens: { dailyLimit: 1000 } }, hub, env, tools: [{ function: { name: 'browser_open' } }, { function: { name: 'read_file' } }] }));
    return x;
  }

  it('refuses remote callers without the token', async () => {
    const res = await request(app(new TraceHub())).get('/api/system-map/overview').set('X-Forwarded-For', '1.2.3.4');
    expect(res.status).toBe(401);
  });

  it('describes channels, providers, usage and recent traces', async () => {
    const hub = new TraceHub();
    hub.finish(hub.start({ channel: 'telegram', title: 'Pesan', input: 'hai' }), { output: 'halo' });
    const res = await request(app(hub)).get('/api/system-map/overview').set('X-Automation-Token', 'tok');
    expect(res.status).toBe(200);
    expect(res.body.channels.find((c) => c.id === 'telegram').stats.requests).toBe(1);
    const [first, second] = res.body.providers;
    expect(first).toMatchObject({ id: 'a', configured: true, isDefault: true, usageToday: 120 });
    expect(first.models[0]).toMatchObject({ id: 'm1', tokensToday: 120 });
    expect(second).toMatchObject({ id: 'off', configured: false });
    expect(res.body.usage).toMatchObject({ total: 120, limit: 1000, remaining: 880 });
    expect(res.body.tools.count).toBe(2);
    expect(res.body.traces[0]).toMatchObject({ channel: 'telegram', status: 'ok' });
  });

  it('returns one full trace, and 404 for an unknown one', async () => {
    const hub = new TraceHub();
    const t = hub.start({ channel: 'web', input: 'pertanyaan' });
    hub.step('route', { requested: { provider: 'a' } }, t);
    const a = app(hub);
    const ok = await request(a).get(`/api/system-map/traces/${t.id}`).set('X-Automation-Token', 'tok');
    expect(ok.body.trace.events[0].type).toBe('route');
    const nf = await request(a).get('/api/system-map/traces/tr_nope').set('X-Automation-Token', 'tok');
    expect(nf.status).toBe(404);
  });

  it('describeProviders never asks unconfigured providers', async () => {
    const m = managerWith({ openrouter: { ...streamProvider({ name: 'openrouter', available: false }), apiKey: 'k' } }, 'openrouter');
    let asked = false;
    const { providers } = await describeProviders({ aiManager: m, fetcher: { get: async () => { asked = true; return { data: {} }; } } });
    expect(asked).toBe(false);
    expect(providers[0].quota.api).toBeNull();
  });
});

describe('Telegram path on the map', () => {
  const OWNER = '123456789';
  const store = { subscribers: { upsert() {}, setActive() {}, counts: () => ({}) }, suppressions: { add() {}, remove() {} } };
  const msg = (text) => ({ message: { chat: { id: Number(OWNER), type: 'private' }, from: { first_name: 'W' }, text } });
  beforeEach(() => traceHub.clear());

  it('a chat message becomes one telegram trace: received, AI steps, delivered', async () => {
    const replies = [];
    const channel = { mode: 'live', reply: async (c, h) => replies.push(h), sendAction: async () => {} };
    const m = managerWith({ a: streamProvider({ name: 'a', text: 'Siap Pak' }) }, 'a');
    const responder = async ({ text }) => {
      let out = '';
      for await (const ev of m.chatStream([{ role: 'user', content: text }], {})) if (ev.type === 'content') out += ev.content;
      return out;
    };
    const inbox = new TelegramInbox({ channel, store, env: { TELEGRAM_AI_CHAT_IDS: OWNER }, responder });
    const r = await inbox.handleUpdate(msg('ingatkan saya jam 3'));
    await r.done;
    const [t] = traceHub.list();
    expect(t).toMatchObject({ channel: 'telegram', status: 'ok', input: 'ingatkan saya jam 3', output: 'Siap Pak', provider: 'a' });
    const full = traceHub.get(t.id);
    const types = full.events.map((e) => e.type);
    expect(types[0]).toBe('receive');
    expect(types).toContain('route');
    expect(types.at(-1)).toBe('deliver');
    expect(full.meta.chat).toBe('…6789'); // chat id is masked
    expect(replies).toEqual(['Siap Pak']);
  });

  it('owner commands are traced as "handled by code" with the reply delivered', async () => {
    const replies = [];
    const channel = { mode: 'live', reply: async (c, h) => replies.push(h), sendAction: async () => {} };
    const inbox = new TelegramInbox({ channel, store, env: { TELEGRAM_AI_CHAT_IDS: OWNER } });
    inbox.registerCommands({ brief: { description: 'briefing', run: async () => 'Agenda hari ini kosong' } });
    await inbox.handleUpdate(msg('/brief'));
    const t = traceHub.get(traceHub.list()[0].id);
    expect(t.title).toBe('Perintah /brief');
    expect(t.events.find((e) => e.type === 'intent')).toMatchObject({ model: false });
    expect(t.events.at(-1)).toMatchObject({ type: 'deliver', ok: true, parts: 1 });
    expect(t.output).toBe('Agenda hari ini kosong');
  });
});
