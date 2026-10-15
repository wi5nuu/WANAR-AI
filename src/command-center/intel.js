/**
 * src/command-center/intel.js
 *
 * Live "intel" for the Pusat Kendali: USD→IDR and other currencies, Indonesia's
 * macro indicators and the top technology headlines. Only free, key-less public
 * sources are used; every section is cached with its own TTL and degrades to
 * the last good value (marked `stale`) instead of failing the whole page.
 *
 * Sources: open.er-api.com (rates), api.frankfurter.dev (history),
 * api.worldbank.org (Indonesia indicators), Hacker News Firebase API (tech).
 *
 * @author Wisnu Alfian Nur Ashar
 */

const TTL = { fx: 5 * 60_000, economy: 6 * 3_600_000, tech: 10 * 60_000 };

const CURRENCIES = [
  { code: 'USD', name: 'Dolar AS' },
  { code: 'EUR', name: 'Euro' },
  { code: 'SGD', name: 'Dolar Singapura' },
  { code: 'JPY', name: 'Yen Jepang', per: 100 },
  { code: 'CNY', name: 'Yuan China' },
  { code: 'MYR', name: 'Ringgit Malaysia' },
  { code: 'SAR', name: 'Riyal Saudi' },
  { code: 'AUD', name: 'Dolar Australia' },
];

const INDICATORS = [
  { code: 'NY.GDP.MKTP.KD.ZG', key: 'gdpGrowth', label: 'Pertumbuhan PDB', unit: '%' },
  { code: 'FP.CPI.TOTL.ZG', key: 'inflation', label: 'Inflasi (CPI)', unit: '%' },
  { code: 'SL.UEM.TOTL.ZS', key: 'unemployment', label: 'Pengangguran', unit: '%' },
  { code: 'NY.GDP.PCAP.CD', key: 'gdpPerCapita', label: 'PDB per kapita', unit: 'USD' },
];

const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createIntelService({ fetch: f = globalThis.fetch, now = Date.now, timeoutMs = 7000 } = {}) {
  const cache = new Map();

  async function getJson(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await f(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'wanar-ai-command-center' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  // Serve fresh cache, else fetch; on failure fall back to the last good value.
  async function cached(key, ttl, loader, { force = false } = {}) {
    const hit = cache.get(key);
    const at = now();
    if (!force && hit && at - hit.at < ttl) return { ...hit.data, cached: true };
    try {
      const data = await loader();
      cache.set(key, { at, data });
      return { ...data, cached: false };
    } catch (e) {
      if (hit) return { ...hit.data, cached: true, stale: true, error: e.message };
      return { ok: false, error: e.message };
    }
  }

  async function loadFx() {
    const j = await getJson('https://open.er-api.com/v6/latest/USD');
    if (j.result !== 'success' || !j.rates?.IDR) throw new Error('kurs tidak tersedia');
    const idrPerUsd = j.rates.IDR;
    const rates = CURRENCIES.map((c) => {
      const perUnit = c.per || 1;
      const v = c.code === 'USD' ? idrPerUsd : idrPerUsd / j.rates[c.code];
      return { code: c.code, name: c.name, per: perUnit, idr: round(v * perUnit, 2) };
    }).filter((r) => r.idr);

    let history = [];
    try {
      const to = isoDay(now());
      const from = isoDay(now() - 14 * 86_400_000);
      const h = await getJson(`https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=IDR`);
      history = Object.entries(h.rates || {}).map(([date, r]) => ({ date, idr: round(r.IDR, 2) })).sort((a, b) => a.date.localeCompare(b.date));
    } catch { /* history is optional */ }

    const last = history.at(-1)?.idr ?? null;
    const prev = history.length > 1 ? history.at(-2).idr : null;
    const first = history[0]?.idr ?? null;
    const usd = rates.find((r) => r.code === 'USD');
    const base = prev ?? first;
    const change = usd && base ? round(usd.idr - base, 2) : null;
    const changePct = usd && base ? round(((usd.idr - base) / base) * 100, 2) : null;
    return {
      ok: true,
      base: 'USD',
      updatedAt: j.time_last_update_unix ? j.time_last_update_unix * 1000 : now(),
      usdIdr: usd?.idr ?? null,
      change,
      changePct,
      trend: changePct == null ? 'flat' : changePct > 0.05 ? 'weaker' : changePct < -0.05 ? 'stronger' : 'flat',
      history,
      rangeHigh: history.length ? Math.max(...history.map((x) => x.idr)) : null,
      rangeLow: history.length ? Math.min(...history.map((x) => x.idr)) : null,
      latestDataPoint: last,
      rates,
      source: 'open.er-api.com · frankfurter.dev',
    };
  }

  async function loadEconomy() {
    const out = await Promise.all(INDICATORS.map(async (ind) => {
      try {
        const j = await getJson(`https://api.worldbank.org/v2/country/IDN/indicator/${ind.code}?format=json&mrnev=1`);
        const row = Array.isArray(j) ? j[1]?.[0] : null;
        if (!row || row.value == null) return { ...ind, value: null };
        return { key: ind.key, label: ind.label, unit: ind.unit, value: round(row.value, 2), year: Number(row.date) };
      } catch {
        return { key: ind.key, label: ind.label, unit: ind.unit, value: null };
      }
    }));
    if (!out.some((x) => x.value != null)) throw new Error('data ekonomi tidak tersedia');
    return { ok: true, country: 'Indonesia', indicators: out, source: 'World Bank (data tahunan terbaru)', updatedAt: now() };
  }

  async function loadTech() {
    const ids = await getJson('https://hacker-news.firebaseio.com/v0/topstories.json');
    const top = (Array.isArray(ids) ? ids : []).slice(0, 12);
    const items = (await Promise.all(top.map((id) => getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null))))
      .filter((x) => x && x.title && !x.dead && !x.deleted)
      .slice(0, 8)
      .map((x) => ({
        id: x.id,
        title: x.title,
        url: x.url || `https://news.ycombinator.com/item?id=${x.id}`,
        score: x.score || 0,
        comments: x.descendants || 0,
        host: x.url ? new URL(x.url).hostname.replace(/^www\./, '') : 'news.ycombinator.com',
        at: (x.time || 0) * 1000,
      }));
    if (!items.length) throw new Error('berita teknologi tidak tersedia');
    return { ok: true, items, source: 'Hacker News', updatedAt: now() };
  }

  /** Short plain-language readout, computed locally (no AI tokens). */
  function insights({ fx, economy, tech }) {
    const lines = [];
    if (fx?.ok && fx.usdIdr) {
      const rp = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(fx.usdIdr);
      const dir = fx.trend === 'weaker' ? `melemah ${Math.abs(fx.changePct)}%` : fx.trend === 'stronger' ? `menguat ${Math.abs(fx.changePct)}%` : 'relatif stabil';
      lines.push(`1 USD ≈ Rp ${rp}; rupiah ${dir} dibanding hari sebelumnya.`);
    }
    const infl = economy?.indicators?.find((i) => i.key === 'inflation');
    const gdp = economy?.indicators?.find((i) => i.key === 'gdpGrowth');
    if (gdp?.value != null) lines.push(`Ekonomi Indonesia tumbuh ${gdp.value}% (${gdp.year})${infl?.value != null ? `, inflasi ${infl.value}% (${infl.year})` : ''}.`);
    if (tech?.items?.[0]) lines.push(`Teknologi terpopuler: ${tech.items[0].title}.`);
    return lines;
  }

  const sections = {
    fx: (o) => cached('fx', TTL.fx, loadFx, o),
    economy: (o) => cached('economy', TTL.economy, loadEconomy, o),
    tech: (o) => cached('tech', TTL.tech, loadTech, o),
  };

  return {
    ...sections,
    async all(opts = {}) {
      const [fx, economy, tech] = await Promise.all([sections.fx(opts), sections.economy(opts), sections.tech(opts)]);
      return { fx, economy, tech, insights: insights({ fx, economy, tech }), at: now() };
    },
    insights,
  };
}
