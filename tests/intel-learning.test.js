import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createIntelService } from '../src/command-center/intel.js';
import { createNightlyLearning } from '../src/command-center/nightly-learning.js';

const json = (data, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });

function fakeFetch(map, calls = []) {
  return async (url) => {
    calls.push(url);
    for (const [k, v] of Object.entries(map)) if (url.includes(k)) return typeof v === 'function' ? v(url) : json(v);
    return json({}, false);
  };
}

const FX = {
  'open.er-api.com': { result: 'success', time_last_update_unix: 1_760_000_000, rates: { IDR: 16500, EUR: 0.9, SGD: 1.3, JPY: 150, CNY: 7.2, MYR: 4.5, SAR: 3.75, AUD: 1.5 } },
  'frankfurter.dev': { rates: { '2026-10-13': { IDR: 16400 }, '2026-10-14': { IDR: 16450 } } },
};

describe('intel service', () => {
  it('computes IDR rates, change and caches', async () => {
    const calls = [];
    const svc = createIntelService({ fetch: fakeFetch(FX, calls) });
    const a = await svc.fx();
    expect(a.ok).toBe(true);
    expect(a.usdIdr).toBe(16500);
    expect(a.rates.find((r) => r.code === 'EUR').idr).toBeCloseTo(16500 / 0.9, 0);
    expect(a.rates.find((r) => r.code === 'JPY').per).toBe(100);
    expect(a.trend).toBe('weaker');
    const n = calls.length;
    const b = await svc.fx();
    expect(b.cached).toBe(true);
    expect(calls.length).toBe(n);
  });

  it('serves stale data when the source fails later', async () => {
    let t = 0;
    let fail = false;
    const f = async (u) => (fail ? json({}, false) : fakeFetch(FX)(u));
    const svc = createIntelService({ fetch: f, now: () => t });
    await svc.fx();
    fail = true;
    t += 10 * 60_000;
    const r = await svc.fx();
    expect(r.stale).toBe(true);
    expect(r.usdIdr).toBe(16500);
  });

  it('reports a clean error with no cache', async () => {
    const svc = createIntelService({ fetch: fakeFetch({}) });
    const r = await svc.fx();
    expect(r.ok).toBe(false);
  });

  it('reads Indonesia indicators and tech headlines', async () => {
    const svc = createIntelService({
      fetch: fakeFetch({
        'api.worldbank.org': (url) => json([{}, [{ date: '2024', value: url.includes('FP.CPI') ? 2.3 : 5.03 }]]),
        'topstories.json': [1, 2],
        'item/1.json': { id: 1, title: 'Hello', score: 10, descendants: 2, time: 1, url: 'https://www.example.com/x' },
        'item/2.json': { id: 2, title: 'World', score: 5, descendants: 0, time: 1 },
      }),
    });
    const e = await svc.economy();
    expect(e.indicators.find((i) => i.key === 'inflation').value).toBe(2.3);
    const t = await svc.tech();
    expect(t.items[0].host).toBe('example.com');
    expect(t.items[1].url).toContain('news.ycombinator.com');
  });
});

describe('nightly learning', () => {
  function setup(nowMs) {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE request_logs (id INTEGER PRIMARY KEY, provider TEXT, model TEXT, status TEXT, response_time_ms INTEGER, created_at TEXT);
             CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, role TEXT, content TEXT, created_at TEXT);`);
    const store = new Map();
    const meta = { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v) };
    const clock = { t: nowMs };
    const learning = createNightlyLearning({ db, meta, now: () => clock.t, tz: 'UTC', hour: 0 });
    return { db, meta, clock, learning };
  }
  const at = (iso) => Date.parse(iso);

  it('derives lessons from failures, corrections and topics', async () => {
    const { db, learning, clock } = setup(at('2026-10-16T00:05:00Z'));
    const ts = '2026-10-15 10:00:00';
    for (let i = 0; i < 5; i++) db.prepare('INSERT INTO request_logs (provider, model, status, response_time_ms, created_at) VALUES (?,?,?,?,?)').run('nvidia', 'm1', i < 3 ? 'error' : 'ok', 2000, ts);
    db.prepare('INSERT INTO chat_messages (role, content, created_at) VALUES (?,?,?)').run('user', 'Salah, bukan itu. Hubungi budi@mail.com 081234567890', ts);
    for (let i = 0; i < 4; i++) db.prepare('INSERT INTO chat_messages (role, content, created_at) VALUES (?,?,?)').run('user', 'bagaimana kurs dolar hari ini', ts);
    expect(await learning.tick()).toBe(true);
    const st = learning.status();
    const kinds = st.last.lessons.map((l) => l.kind);
    expect(kinds).toContain('reliability');
    expect(kinds).toContain('correction');
    expect(kinds).toContain('topic');
    const json = JSON.stringify(st.last.lessons);
    expect(json).not.toContain('budi@mail.com');
    expect(json).not.toContain('081234567890');
    expect(learning.promptBlock()).toContain('Pelajaran dari interaksi sebelumnya');
    clock.t += 60_000;
    expect(await learning.tick()).toBe(false); // once per day
  });

  it('does not run outside the midnight window', async () => {
    const { learning } = setup(at('2026-10-16T13:00:00Z'));
    expect(await learning.tick()).toBe(false);
    expect(learning.promptBlock()).toBe('');
  });
});
