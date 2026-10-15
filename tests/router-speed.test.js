/**
 * Router speed: a stuck or empty model must cost seconds, not minutes; retired models
 * are not retried; providers that just answered are tried first.
 */
import { describe, it, expect, beforeAll } from 'vitest';

process.env.AI_FIRST_TOKEN_MS = '250';
process.env.AI_LATE_FIRST_TOKEN_MS = '250';
process.env.AI_STREAM_IDLE_MS = '250';

let AIManager; let SmartFailover; let classifyError; let traceHub;
beforeAll(async () => {
  ({ default: AIManager } = await import('../src/ai-manager.js'));
  ({ SmartFailover, classifyError } = await import('../src/ai-failover.js'));
  ({ traceHub } = await import('../src/observability/trace-hub.js'));
});

const prov = (name, gen, defaultModel = 'm1') => ({
  name, defaultModel, isAvailable: () => true, getAvailableModels: () => [{ id: defaultModel }], chatStream: gen,
});
function mgr(providers, primary) {
  const m = new AIManager();
  m.providers = providers;
  m.currentProvider = primary;
  m.failover = new SmartFailover(providers, {}, {});
  return m;
}
async function drain(g) { const out = []; for await (const e of g) out.push(e); return out; }

describe('router speed', () => {
  it('a stalled model is abandoned after the first-token limit and the next one answers', async () => {
    const stuck = prov('stuck', async function* () { await new Promise(() => {}); yield { type: 'done' }; });
    const good = prov('good', async function* () { yield { type: 'content', content: 'ok' }; yield { type: 'done' }; }, 'g1');
    const m = mgr({ stuck, good }, 'stuck');
    const t = traceHub.start({ channel: 'web' });
    const t0 = Date.now();
    const ev = await traceHub.run(t, () => drain(m.chatStream([{ role: 'user', content: 'hai' }], {})));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(ev.filter((e) => e.type === 'content').map((e) => e.content).join('')).toBe('ok');
    expect(t.events.find((e) => e.type === 'fail')).toMatchObject({ provider: 'stuck', reason: 'network' });
  });

  it('a model that goes silent mid-stream is cut too', async () => {
    const half = prov('half', async function* () { yield { type: 'content', content: 'ha' }; await new Promise(() => {}); }, 'h1');
    const good = prov('good', async function* () { yield { type: 'content', content: 'ok' }; yield { type: 'done' }; }, 'g1');
    const m = mgr({ half, good }, 'half');
    const ev = await drain(m.chatStream([{ role: 'user', content: 'hai' }], {}));
    expect(ev.some((e) => e.type === 'content' && e.content === 'ok')).toBe(true);
  });

  it('classifies a retired model (HTTP 410) as gone and keeps it out for hours', () => {
    expect(classifyError('HTTP 410')).toBe('gone');
    expect(classifyError('The model `x` does not exist')).toBe('gone');
    const f = new SmartFailover({ a: { isAvailable: () => true, defaultModel: 'x' } }, {}, {});
    f.markFailure('a', 'x', 'gone', 'HTTP 410');
    expect(f.isCoolingDown('a', 'x')).toBe(true);
    expect(f.lastFailure.get('a::x').until - Date.now()).toBeGreaterThan(5 * 3600_000);
  });

  it('after the primary fails, a provider that answered recently is tried before an untested one', () => {
    const a = prov('a', async function* () {}); const b = prov('b', async function* () {}); const c = prov('c', async function* () {});
    const f = new SmartFailover({ a, b, c }, { }, {});
    f.markSuccess('c', 'm1'); // c answered just now
    const chain = f.buildChain('a', 'm1').map((x) => x.provider);
    expect(chain[0]).toBe('a');
    expect(chain.indexOf('c')).toBeLessThan(chain.indexOf('b'));
  });
});

describe('key errors are recognised in any wording', () => {
  it.each([
    ['Clouvia API error: API key tidak valid.', 'auth'],
    ['x-api-key header is required', 'auth'],
    ['Incorrect API key provided', 'auth'],
    ['Request failed with status code 401', 'auth'],
  ])('%s -> %s', (msg, reason) => {
    expect(classifyError(msg)).toBe(reason);
  });
});
