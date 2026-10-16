/**
 * src/market/sources.js
 *
 * Market data from free, key-less public sources (nothing is invented):
 *   - TradingView scanner  : IDX stocks + IHSG, global stocks, gold, crypto pairs
 *   - open.er-api.com      : USD -> IDR (to express gold / crypto in rupiah)
 *   - CoinGecko            : crypto directly in IDR (fallback for crypto)
 *
 * IMPORTANT: exchange data from these sources can be delayed (IDX is typically 10-15
 * minutes behind). Every quote says so via `delayed`.
 *
 * Symbols the owner writes: "BBCA", "IHSG", "BTC", "EMAS", "USDIDR", "NASDAQ:AAPL".
 *
 * @author Wisnu Alfian Nur Ashar
 */

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

/** Friendly names -> scanner ticker + display metadata. */
const ALIASES = {
  IHSG: { tv: 'IDX:COMPOSITE', label: 'IHSG', kind: 'index', market: 'indonesia' },
  COMPOSITE: { tv: 'IDX:COMPOSITE', label: 'IHSG', kind: 'index', market: 'indonesia' },
  LQ45: { tv: 'IDX:LQ45', label: 'LQ45', kind: 'index', market: 'indonesia' },
  EMAS: { tv: 'OANDA:XAUUSD', label: 'Emas (XAU/USD)', kind: 'gold', market: 'global' },
  GOLD: { tv: 'OANDA:XAUUSD', label: 'Emas (XAU/USD)', kind: 'gold', market: 'global' },
  XAU: { tv: 'OANDA:XAUUSD', label: 'Emas (XAU/USD)', kind: 'gold', market: 'global' },
  PERAK: { tv: 'OANDA:XAGUSD', label: 'Perak (XAG/USD)', kind: 'metal', market: 'global' },
  BTC: { tv: 'BINANCE:BTCUSDT', label: 'Bitcoin', kind: 'crypto', market: 'global', coingecko: 'bitcoin' },
  BITCOIN: { tv: 'BINANCE:BTCUSDT', label: 'Bitcoin', kind: 'crypto', market: 'global', coingecko: 'bitcoin' },
  ETH: { tv: 'BINANCE:ETHUSDT', label: 'Ethereum', kind: 'crypto', market: 'global', coingecko: 'ethereum' },
  ETHEREUM: { tv: 'BINANCE:ETHUSDT', label: 'Ethereum', kind: 'crypto', market: 'global', coingecko: 'ethereum' },
  SOL: { tv: 'BINANCE:SOLUSDT', label: 'Solana', kind: 'crypto', market: 'global', coingecko: 'solana' },
  BNB: { tv: 'BINANCE:BNBUSDT', label: 'BNB', kind: 'crypto', market: 'global', coingecko: 'binancecoin' },
  XRP: { tv: 'BINANCE:XRPUSDT', label: 'XRP', kind: 'crypto', market: 'global', coingecko: 'ripple' },
  DOGE: { tv: 'BINANCE:DOGEUSDT', label: 'Dogecoin', kind: 'crypto', market: 'global', coingecko: 'dogecoin' },
  USDIDR: { fx: 'IDR', label: 'USD/IDR', kind: 'fx' },
  KURS: { fx: 'IDR', label: 'USD/IDR', kind: 'fx' },
  DOLAR: { fx: 'IDR', label: 'USD/IDR', kind: 'fx' },
};

export const DEFAULT_WATCHLIST = ['IHSG', 'BBCA', 'BBRI', 'BMRI', 'TLKM', 'BTC', 'ETH', 'EMAS', 'USDIDR'];

const MARKET_OF = { IDX: 'indonesia', NASDAQ: 'america', NYSE: 'america', AMEX: 'america' };

/** "bbca" -> {symbol:'BBCA', tv:'IDX:BBCA', market:'indonesia', ...}; null if it cannot be a ticker. */
export function resolveSymbol(input) {
  const raw = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return null;
  if (ALIASES[raw]) return { symbol: raw === 'BITCOIN' ? 'BTC' : raw === 'ETHEREUM' ? 'ETH' : raw === 'GOLD' || raw === 'XAU' ? 'EMAS' : raw === 'COMPOSITE' ? 'IHSG' : raw, ...ALIASES[raw] };
  const m = /^([A-Z]{2,10}):([A-Z0-9._-]{1,15})$/.exec(raw);
  if (m) return { symbol: raw, tv: raw, label: m[2], kind: 'stock', market: MARKET_OF[m[1]] || 'global' };
  if (/^[A-Z]{4}$/.test(raw)) return { symbol: raw, tv: `IDX:${raw}`, label: raw, kind: 'stock', market: 'indonesia' };
  if (/^[A-Z]{2,5}$/.test(raw)) return { symbol: raw, tv: `NASDAQ:${raw}`, label: raw, kind: 'stock', market: 'america', guessed: true };
  return null;
}

async function getJson(fetchImpl, url, { timeoutMs = 8000, init = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { ...init, signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA, ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** USD -> IDR rate and when the source last updated it. */
export async function fetchUsdIdr(fetchImpl = globalThis.fetch) {
  const j = await getJson(fetchImpl, 'https://open.er-api.com/v6/latest/USD');
  const rate = Number(j?.rates?.IDR);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('kurs USD/IDR tidak tersedia');
  return { rate, updatedAt: j.time_last_update_utc ? Date.parse(j.time_last_update_utc) : Date.now() };
}

async function scan(fetchImpl, market, tickers) {
  const body = {
    symbols: { tickers },
    columns: ['name', 'close', 'change', 'change_abs', 'high', 'low', 'volume', 'currency', 'description', 'open'],
  };
  const j = await getJson(fetchImpl, `https://scanner.tradingview.com/${market}/scan`, {
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  });
  const out = new Map();
  for (const row of j?.data || []) {
    const [name, close, change, changeAbs, high, low, volume, currency, description, open] = row.d || [];
    if (!Number.isFinite(close)) continue;
    out.set(row.s, { name, price: close, changePct: change, change: changeAbs, high, low, volume, currency, description, open });
  }
  return out;
}

async function coingeckoIdr(fetchImpl, ids) {
  if (!ids.length) return {};
  return getJson(fetchImpl, `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=idr&include_24hr_change=true`);
}

/**
 * @param {string[]} symbols  owner symbols
 * @returns {Promise<{quotes: object[], fx: object|null, errors: string[]}>}
 */
export async function fetchQuotes(symbols, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const resolved = [...new Map(symbols.map((s) => [String(s).toUpperCase(), resolveSymbol(s)]).filter(([, r]) => r)).values()];
  const errors = [];
  let fx = null;
  const needFx = resolved.some((r) => r.fx || r.kind === 'gold' || r.kind === 'metal' || r.kind === 'crypto');
  if (needFx) {
    try { fx = await fetchUsdIdr(fetchImpl); } catch (e) { errors.push(`kurs: ${e.message}`); }
  }

  // one scanner request per market
  const byMarket = new Map();
  for (const r of resolved) if (r.tv) (byMarket.get(r.market) || byMarket.set(r.market, []).get(r.market)).push(r.tv);
  const scanned = new Map();
  await Promise.all([...byMarket].map(async ([market, tickers]) => {
    try { for (const [k, v] of await scan(fetchImpl, market, tickers)) scanned.set(k, v); } catch (e) { errors.push(`${market}: ${e.message}`); }
  }));

  // crypto fallback / IDR price
  const cgIds = resolved.filter((r) => r.coingecko).map((r) => r.coingecko);
  let cg = {};
  if (cgIds.length) { try { cg = await coingeckoIdr(fetchImpl, cgIds); } catch (e) { errors.push(`coingecko: ${e.message}`); } }

  const at = now();
  const quotes = [];
  for (const r of resolved) {
    if (r.fx) {
      if (fx) quotes.push({ symbol: r.symbol, label: r.label, kind: 'fx', price: Math.round(fx.rate * 100) / 100, currency: 'IDR', changePct: null, delayed: false, source: 'open.er-api.com', at, asOf: fx.updatedAt });
      continue;
    }
    const q = scanned.get(r.tv);
    const base = { symbol: r.symbol, label: r.label, kind: r.kind, at };
    if (r.kind === 'crypto') {
      const idr = cg[r.coingecko]?.idr;
      if (idr) { quotes.push({ ...base, price: Math.round(idr), currency: 'IDR', changePct: cg[r.coingecko].idr_24h_change ?? q?.changePct ?? null, usd: q?.price ?? null, delayed: false, source: 'CoinGecko', asOf: at }); continue; }
      if (q && fx) { quotes.push({ ...base, price: Math.round(q.price * fx.rate), currency: 'IDR', changePct: q.changePct, usd: q.price, delayed: false, source: 'TradingView × kurs', asOf: at }); continue; }
    }
    if (!q) continue;
    if ((r.kind === 'gold' || r.kind === 'metal') && fx) {
      // per gram, in rupiah (1 troy ounce = 31.1035 g)
      const perGram = (q.price * fx.rate) / 31.1035;
      quotes.push({ ...base, price: Math.round(perGram), currency: 'IDR/gram', changePct: q.changePct, usd: q.price, usdUnit: 'USD/oz', delayed: false, source: 'TradingView × kurs', asOf: at, note: 'harga internasional per gram, belum termasuk selisih/pajak toko emas' });
      continue;
    }
    quotes.push({
      ...base, name: q.description || q.name, price: q.price, currency: q.currency || (r.market === 'indonesia' ? 'IDR' : 'USD'),
      change: q.change, changePct: q.changePct, high: q.high, low: q.low, open: q.open, volume: q.volume,
      delayed: r.market === 'indonesia', source: 'TradingView', asOf: at,
    });
  }
  return { quotes, fx, errors };
}
