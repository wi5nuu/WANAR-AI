/**
 * Market desk: symbol resolution, live-quote parsing (mocked network), scenario maths,
 * one-shot price alerts, and the plain-language Telegram commands — including the rule
 * that it informs but never recommends.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { resolveSymbol, fetchQuotes } from '../src/market/sources.js';
import { project, scenarios, monthsToTarget } from '../src/market/scenario.js';
import { MarketService } from '../src/market/service.js';
import { quickMarket } from '../src/market/quick.js';

const json = (data) => ({ ok: true, status: 200, json: async () => data });

/** Fake network: TradingView scanner, open.er-api and CoinGecko. */
function fakeFetch(prices = {}) {
  const tableNow = () => ({
    'IDX:BBCA': { d: ['BBCA', prices.BBCA ?? 6075, -0.8163, -50, 6125, 6025, 134763200, 'IDR', 'PT Bank Central Asia Tbk', 6100] },
    'IDX:BBRI': { d: ['BBRI', 3100, 0.32, 10, 3110, 3060, 107210100, 'IDR', 'PT Bank Rakyat Indonesia', 3090] },
    'IDX:COMPOSITE': { d: ['COMPOSITE', 5863.78, -1.33, -79.2, 5917, 5804, null, null, 'IDX Composite Index', 5900] },
    'OANDA:XAUUSD': { d: ['XAUUSD', 3110.25, -0.4, -12, 3130, 3100, null, null, 'Gold', 3120] },
    'BINANCE:BTCUSDT': { d: ['BTCUSDT', 82000, 0.05, 40, 82500, 81000, 1, null, 'Bitcoin', 81960] },
  });
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push(String(url));
    if (url.includes('scanner.tradingview.com')) {
      const tickers = JSON.parse(init.body).symbols.tickers;
      const table = tableNow(); // read the live `prices` object on every request
      return json({ totalCount: tickers.length, data: tickers.filter((t) => table[t]).map((t) => ({ s: t, ...table[t] })) });
    }
    if (url.includes('open.er-api.com')) return json({ result: 'success', rates: { IDR: 16000 }, time_last_update_utc: 'Fri, 16 Oct 2026 00:02:31 +0000' });
    if (url.includes('coingecko')) return json({ bitcoin: { idr: 1_300_000_000, idr_24h_change: 1.5 } });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.calls = calls;
  return f;
}

function desk(over = {}) {
  const sent = [];
  const fetchImpl = over.fetchImpl || fakeFetch();
  const svc = new MarketService({
    db: new Database(':memory:'), fetchImpl, chatId: () => '111', notify: async (c, t) => { sent.push({ c, t }); }, env: {},
  });
  return { svc, sent, fetchImpl };
}

describe('symbol resolution', () => {
  it('maps friendly names and tickers', () => {
    expect(resolveSymbol('bbca')).toMatchObject({ symbol: 'BBCA', tv: 'IDX:BBCA', market: 'indonesia' });
    expect(resolveSymbol('IHSG').tv).toBe('IDX:COMPOSITE');
    expect(resolveSymbol('emas')).toMatchObject({ kind: 'gold', tv: 'OANDA:XAUUSD' });
    expect(resolveSymbol('bitcoin').symbol).toBe('BTC');
    expect(resolveSymbol('NASDAQ:AAPL')).toMatchObject({ market: 'america' });
    expect(resolveSymbol('???')).toBeNull();
  });
});

describe('live quotes', () => {
  it('parses stocks (flagged delayed), gold per gram in rupiah, crypto in IDR and the USD/IDR rate', async () => {
    const f = fakeFetch();
    const { quotes, errors } = await fetchQuotes(['BBCA', 'EMAS', 'BTC', 'USDIDR', 'IHSG'], { fetchImpl: f });
    expect(errors).toEqual([]);
    const by = Object.fromEntries(quotes.map((q) => [q.symbol, q]));
    expect(by.BBCA).toMatchObject({ price: 6075, currency: 'IDR', delayed: true, source: 'TradingView' });
    expect(by.BBCA.changePct).toBeCloseTo(-0.8163, 3);
    expect(by.IHSG.price).toBeCloseTo(5863.78, 2);
    // 3110.25 USD/oz * 16000 / 31.1035 g
    expect(by.EMAS).toMatchObject({ currency: 'IDR/gram', price: Math.round((3110.25 * 16000) / 31.1035), delayed: false });
    expect(by.BTC).toMatchObject({ currency: 'IDR', price: 1_300_000_000, source: 'CoinGecko' });
    expect(by.USDIDR.price).toBe(16000);
  });

  it('a failing source degrades to errors, not a crash, and the cache serves the last good data', async () => {
    const { svc } = desk();
    const ok = await svc.quotes({ force: true });
    expect(ok.quotes.length).toBeGreaterThan(3);
    svc.fetchImpl = async () => { throw new Error('jaringan putus'); };
    const stale = await svc.quotes({ force: true });
    expect(stale.quotes.length).toBe(ok.quotes.length);
    expect(stale.errors.join(' ')).toMatch(/jaringan|kurs/i);
  });
});

describe('scenario maths', () => {
  it('compounds monthly at the equivalent rate and separates contributions from gain', () => {
    const r = project({ principal: 1_000_000, monthly: 0, annualPct: 12, months: 12 });
    expect(r.finalValue).toBe(1_120_000); // 12%/year for one year
    expect(r.contributed).toBe(1_000_000);
    expect(r.gain).toBe(120_000);
    const m = project({ principal: 0, monthly: 100_000, annualPct: 0, months: 10 });
    expect(m.finalValue).toBe(1_000_000);
    expect(m.gain).toBe(0);
  });

  it('shows three labelled illustrations when no rate is given, and a disclaimer', () => {
    const s = scenarios({ principal: 300_000, months: 12 });
    expect(s.illustrative).toBe(true);
    expect(s.results.map((x) => x.annualPct)).toEqual([4, 8, 15]);
    expect(s.disclaimer).toMatch(/bukan prediksi/);
    expect(monthsToTarget({ principal: 1_000_000, monthly: 100_000, annualPct: 0, target: 2_000_000 })).toBe(10);
  });
});

describe('price alerts', () => {
  it('fire once, message Telegram with the disclaimer, and then stay quiet', async () => {
    const prices = { BBCA: 6075 };
    const fetchImpl = fakeFetch(prices);
    const { svc, sent } = desk({ fetchImpl });
    svc.addAlert({ symbol: 'BBCA', op: 'lte', value: 6000 });
    expect(await svc.tick()).toHaveLength(0); // 6075 > 6000: not yet

    prices.BBCA = 5950;
    const fired = await svc.tick();
    expect(fired).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].t).toMatch(/Alarm harga — BBCA/);
    expect(sent[0].t).toMatch(/bukan nasihat investasi/);
    expect(await svc.tick()).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(svc.alerts()[0].status).toBe('fired');
  });
});

describe('Telegram commands', () => {
  it('answers a price question from real data', async () => {
    const { svc } = desk();
    const r = await quickMarket(svc, 'harga BBCA');
    expect(r).toMatch(/BBCA: Rp6\.075/);
    expect(r).toMatch(/tertunda/);
    expect(await quickMarket(svc, 'harga emas')).toMatch(/IDR\/gram|\/gram/);
  });

  it('sets a price alert from plain words', async () => {
    const { svc } = desk();
    const r = await quickMarket(svc, 'kabari kalau BBCA di bawah 6000');
    expect(r).toMatch(/Alarm dipasang/);
    expect(svc.alerts()[0]).toMatchObject({ symbol: 'BBCA', op: 'lte', value: 6000 });
    const p = await quickMarket(svc, 'kabari kalau bitcoin turun 5%');
    expect(p).toMatch(/Alarm dipasang/);
    expect(svc.alerts().find((a) => a.symbol === 'BTC')).toMatchObject({ op: 'pct_down', value: 5 });
  });

  it('adds and removes watchlist symbols', async () => {
    const { svc } = desk();
    expect(await quickMarket(svc, 'pantau TLKM')).toMatch(/masuk watchlist/);
    expect(svc.watchlist()).toContain('TLKM');
    expect(await quickMarket(svc, 'hapus TLKM dari watchlist')).toMatch(/dihapus/);
    expect(svc.watchlist()).not.toContain('TLKM');
  });

  it('computes a scenario from the owner\'s own numbers', async () => {
    const { svc } = desk();
    const r = await quickMarket(svc, 'simulasi investasi 1jt return 12% setahun');
    expect(r).toMatch(/Rp1\.120\.000/);
    expect(r).toMatch(/bukan prediksi/);
    const m = await quickMarket(svc, 'simulasi nabung 300rb tiap bulan 12 bulan return 0%');
    expect(m).toMatch(/Rp3\.600\.000/);
  });

  it('does not recommend what to buy and says what it can do instead', async () => {
    const { svc } = desk();
    for (const q of ['saham apa yang bagus untuk dibeli sekarang', 'rekomendasi saham dong', 'investasi apa yang pasti untung']) {
      const r = await quickMarket(svc, q);
      expect(r).toMatch(/tidak mau asal menyarankan|tidak bisa memastikan/);
      expect(r).not.toMatch(/Rp\d/);
    }
  });

  it('ignores ordinary sentences (no ticker hijacking)', async () => {
    const { svc, fetchImpl } = desk();
    for (const q of ['tadi hari ini', 'jam berapa', 'kerja hari ini', 'tolong ingatkan meeting jam 3', 'tugas berapa']) {
      expect(await quickMarket(svc, q)).toBeNull();
    }
    expect(fetchImpl.calls).toHaveLength(0); // nothing was fetched
  });
});
