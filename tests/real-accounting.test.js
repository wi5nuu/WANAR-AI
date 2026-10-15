/**
 * Analytics must come from REAL model calls: provider-reported tokens (prompt + completion),
 * real timing, the channel, and failures — not "characters x 1.3" of the output only.
 */

import { describe, it, expect } from 'vitest';
import AIManager from '../src/ai-manager.js';
import { SmartFailover } from '../src/ai-failover.js';
import { traceHub } from '../src/observability/trace-hub.js';
import * as db from '../src/database.js';

function mgr(providers, primary) {
  const m = new AIManager();
  m.providers = providers;
  m.currentProvider = primary;
  m.failover = new SmartFailover(providers, {}, {});
  return m;
}
async function drain(g) { const out = []; for await (const e of g) out.push(e); return out; }

describe('real per-call accounting', () => {
  it('reports provider-sent tokens, timing and channel for a call, and failures separately', async () => {
    const bad = {
      name: 'bad', defaultModel: 'b1', isAvailable: () => true, getAvailableModels: () => [{ id: 'b1' }],
      async *chatStream() { yield { type: 'error', content: 'HTTP 410' }; },
    };
    const good = {
      name: 'good', defaultModel: 'g1', isAvailable: () => true, getAvailableModels: () => [{ id: 'g1' }],
      async *chatStream() {
        yield { type: 'usage', usage: { prompt_tokens: 1200, completion_tokens: 40 } };
        await new Promise((r) => setTimeout(r, 15));
        yield { type: 'content', content: 'halo' };
        yield { type: 'done' };
      },
    };
    const m = mgr({ bad, good }, 'bad');
    const calls = [];
    const fails = [];
    m.onUsage = (u) => calls.push(u);
    m.onFailure = (f) => fails.push(f);

    const t = traceHub.start({ channel: 'telegram', meta: { session: 's1', ip: '1.2.3.4' } });
    await traceHub.run(t, () => drain(m.chatStream([{ role: 'user', content: 'hai' }], {})));

    expect(fails).toHaveLength(1);
    expect(fails[0]).toMatchObject({ provider: 'bad', reason: 'gone', channel: 'telegram', session: 's1', ip: '1.2.3.4' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'good', model: 'g1', prompt: 1200, completion: 40, total: 1240, estimated: false, channel: 'telegram', traceId: t.id });
    expect(calls[0].ms).toBeGreaterThanOrEqual(10);
    expect(calls[0].ttft).toBeGreaterThanOrEqual(10);
  });

  it('logCall stores the split, flags real vs estimated, and analytics aggregate it honestly', () => {
    db.logCall({ provider: 'p', model: 'm', prompt_tokens: 1000, completion_tokens: 100, response_time_ms: 2000, ttft_ms: 400, status: 'ok', channel: 'telegram', real: true });
    db.logCall({ provider: 'p', model: 'm', prompt_tokens: 500, completion_tokens: 50, response_time_ms: 1000, ttft_ms: 200, status: 'ok', channel: 'web', real: false });
    db.logCall({ provider: 'p', model: 'm', response_time_ms: 5000, status: 'error: quota', channel: 'web', real: true });

    const a = db.getAnalytics(1);
    expect(a.total).toBe(3);
    expect(a.totalTokens).toBe(1650);
    expect(a.promptTokens).toBe(1500);
    expect(a.completionTokens).toBe(150);
    expect(a.realTokens).toBe(1100); // only the call whose usage the provider reported
    expect(a.okCount).toBe(2);
    expect(a.avgResponse).toBe(1500); // failed attempts do not pollute latency
    expect(a.avgSpeed).toBeGreaterThan(40); // (50 tps + 50 tps) / 2 over calls that produced tokens
    expect(a.avgTtft).toBe(300);
    const rec = a.recent.find((r) => r.status === 'error: quota');
    expect(rec).toMatchObject({ channel: 'web', total_tokens: 0 });
    expect(a.recent.some((r) => r.prompt_tokens === 1000 && r.real === 1)).toBe(true);
  });
});
