/**
 * src/career/sources.js
 *
 * Remote-job sources that publish an official API or RSS feed. Nothing here scrapes a page
 * that forbids it, and nothing logs in anywhere. Every fetcher turns its provider's shape into
 * ONE normalised job so the rest of the engine never cares where a posting came from.
 *
 * Normalised job:
 *   { source, extId, url, title, company, location, remote, tags[], seniority, employmentType,
 *     salaryMin, salaryMax, salaryCurrency, salaryText, postedAt (ms), description (plain text),
 *     regions[], timezones[] }
 *
 * Etiquette: a descriptive User-Agent, one request per source per scan, and every posting keeps
 * its source URL (RemoteOK and Remotive require a link back to their own page).
 *
 * @author Wisnu Alfian Nur Ashar
 */

const UA = 'WanarAI/1.0 (personal job radar; +https://wanarai.ashargrosirparfum.com)';
const MAX_DESC = 6000;

// ----------------------------------------------------------------- helpers

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', hellip: '...' };

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** HTML (possibly entity-escaped) -> readable plain text, capped. */
export function stripHtml(html, max = MAX_DESC) {
  let s = String(html || '');
  if (/&lt;\/?[a-z]/i.test(s) && !/<[a-z]/i.test(s)) s = decodeEntities(s); // RSS double-escaping
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** seconds | ms | ISO string | RFC-2822 -> epoch ms (0 when unknown). */
export function toMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : (v ? [String(v)] : []));
const cut = (s, n) => String(s || '').trim().slice(0, n);

function base(source, extId, url) {
  return {
    source, extId: String(extId), url: String(url || ''), title: '', company: '', location: '', remote: true,
    tags: [], seniority: null, employmentType: null, salaryMin: null, salaryMax: null, salaryCurrency: null,
    salaryText: '', postedAt: 0, description: '', regions: [], timezones: [],
  };
}

// ----------------------------------------------------------------- normalisers (pure)

export function normRemotive(j) {
  const o = base('remotive', j.id, j.url);
  o.title = cut(j.title, 200); o.company = cut(j.company_name, 120);
  o.location = cut(j.candidate_required_location, 160);
  o.tags = arr(j.tags).slice(0, 25); o.employmentType = j.job_type || null;
  o.salaryText = cut(j.salary, 80); o.postedAt = toMs(j.publication_date);
  o.description = stripHtml(j.description);
  return o;
}

export function normRemoteOk(j) {
  const o = base('remoteok', j.id || j.slug, j.url || j.apply_url);
  o.title = cut(j.position, 200); o.company = cut(j.company, 120); o.location = cut(j.location, 160);
  o.tags = arr(j.tags).slice(0, 25); o.postedAt = toMs(j.epoch || j.date);
  o.salaryMin = num(j.salary_min); o.salaryMax = num(j.salary_max); o.salaryCurrency = o.salaryMin ? 'USD' : null;
  o.description = stripHtml(j.description);
  return o;
}

export function normArbeitnow(j) {
  const o = base('arbeitnow', j.slug, j.url);
  o.title = cut(j.title, 200); o.company = cut(j.company_name, 120);
  o.location = cut(j.location, 160); o.remote = j.remote === true;
  o.tags = arr(j.tags).slice(0, 25); o.employmentType = arr(j.job_types).join(', ') || null;
  o.postedAt = toMs(j.created_at); o.description = stripHtml(j.description);
  return o;
}

export function normHimalayas(j) {
  const o = base('himalayas', j.guid || j.applicationLink, j.applicationLink || j.guid);
  o.title = cut(j.title, 200); o.company = cut(j.companyName, 120);
  o.regions = arr(j.locationRestrictions); o.timezones = (j.timezoneRestrictions || []).map(Number).filter(Number.isFinite);
  o.location = o.regions.length ? o.regions.join(', ') : 'Worldwide';
  o.tags = arr(j.categories).slice(0, 25); o.seniority = arr(j.seniority).join(', ') || null;
  o.employmentType = j.employmentType || null;
  o.salaryMin = num(j.minSalary); o.salaryMax = num(j.maxSalary); o.salaryCurrency = j.currency || null;
  o.postedAt = toMs(j.pubDate); o.description = stripHtml(j.description || j.excerpt);
  return o;
}

export function normJobicy(j) {
  const o = base('jobicy', j.id, j.url);
  o.title = cut(j.jobTitle, 200); o.company = cut(j.companyName, 120); o.location = cut(j.jobGeo, 160);
  o.tags = arr(j.jobIndustry).slice(0, 10); o.seniority = j.jobLevel || null; o.employmentType = arr(j.jobType).join(', ') || null;
  o.salaryMin = num(j.salaryMin); o.salaryMax = num(j.salaryMax); o.salaryCurrency = j.salaryCurrency || null;
  o.postedAt = toMs(j.pubDate); o.description = stripHtml(j.jobDescription || j.jobExcerpt);
  return o;
}

export function normGreenhouse(board, j) {
  const o = base(`greenhouse:${board}`, j.id, j.absolute_url);
  o.title = cut(j.title, 200); o.company = cut(j.company_name || board, 120);
  o.location = cut(j.location?.name, 160); o.remote = /remote/i.test(o.location) || null;
  o.postedAt = toMs(j.first_published || j.updated_at);
  o.description = stripHtml(j.content || '');
  return o;
}

/** Minimal RSS item reader (We Work Remotely): title is "Company: Role". */
export function parseRssItems(xml) {
  const items = [];
  for (const m of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (n) => {
      const r = new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`, 'i').exec(m[1]);
      return r ? r[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim() : '';
    };
    items.push({ title: decodeEntities(tag('title')), region: decodeEntities(tag('region')), category: tag('category'),
      description: tag('description'), pubDate: tag('pubDate'), link: tag('link'), guid: tag('guid') });
  }
  return items;
}

export function normWwr(it) {
  const o = base('weworkremotely', it.guid || it.link, it.link);
  const split = it.title.indexOf(':');
  o.company = cut(split > 0 ? it.title.slice(0, split) : '', 120);
  o.title = cut(split > 0 ? it.title.slice(split + 1) : it.title, 200);
  o.location = cut(it.region, 160); o.tags = it.category ? [it.category] : [];
  o.postedAt = toMs(it.pubDate); o.description = stripHtml(it.description);
  return o;
}

// ----------------------------------------------------------------- network

async function getJson(fetchImpl, url, timeoutMs = 30_000) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getText(fetchImpl, url, timeoutMs = 30_000) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const DEFAULT_GREENHOUSE_BOARDS = ['gitlab', 'elastic', 'mozilla', 'netlify', 'vercel', 'grafanalabs', 'automatticcareers'];

/** id, label and a fetcher that resolves to normalised jobs. */
export function buildSources(env = process.env) {
  const boards = String(env.CAREER_GREENHOUSE_BOARDS || DEFAULT_GREENHOUSE_BOARDS.join(','))
    .split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9-]{2,40}$/.test(s));
  return [
    { id: 'remotive', label: 'Remotive', fetch: async (f) => (await getJson(f, 'https://remotive.com/api/remote-jobs?category=software-dev')).jobs.map(normRemotive) },
    { id: 'remoteok', label: 'RemoteOK', fetch: async (f) => (await getJson(f, 'https://remoteok.com/api')).filter((j) => j && j.id && j.position).map(normRemoteOk) },
    { id: 'arbeitnow', label: 'Arbeitnow', fetch: async (f) => (await getJson(f, 'https://www.arbeitnow.com/api/job-board-api')).data.filter((j) => j.remote).map(normArbeitnow) },
    { id: 'himalayas', label: 'Himalayas', fetch: async (f) => (await getJson(f, 'https://himalayas.app/jobs/api?limit=100')).jobs.map(normHimalayas) },
    { id: 'jobicy', label: 'Jobicy', fetch: async (f) => (await getJson(f, 'https://jobicy.com/api/v2/remote-jobs?count=50&tag=developer')).jobs.map(normJobicy) },
    ...['remote-programming-jobs', 'remote-full-stack-programming-jobs', 'remote-back-end-programming-jobs'].map((feed) => ({
      id: `wwr:${feed}`, label: 'We Work Remotely',
      fetch: async (f) => parseRssItems(await getText(f, `https://weworkremotely.com/categories/${feed}.rss`)).map(normWwr),
    })),
    ...boards.map((b) => ({
      id: `greenhouse:${b}`, label: `Greenhouse (${b})`,
      fetch: async (f) => (await getJson(f, `https://boards-api.greenhouse.io/v1/boards/${b}/jobs`)).jobs.map((j) => normGreenhouse(b, j)),
    })),
  ];
}

/**
 * Greenhouse's list has no description; fetch it for one posting (used only for shortlisted
 * candidates so a scan stays a few requests, not hundreds).
 */
export async function enrichGreenhouse(fetchImpl, job) {
  const m = /^greenhouse:(.+)$/.exec(job.source);
  if (!m || job.description) return job;
  try {
    const j = await getJson(fetchImpl, `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${job.extId}`, 20_000);
    return { ...job, description: stripHtml(j.content || ''), location: job.location || cut(j.location?.name, 160) };
  } catch {
    return job;
  }
}

/**
 * Runs every source (one failing source never stops the others) and returns the de-duplicated
 * jobs plus a per-source report for the monitoring screen.
 */
export async function fetchAll({ fetchImpl = globalThis.fetch, env = process.env, only = null, sources = null } = {}) {
  const list = (sources || buildSources(env)).filter((s) => !only || only.includes(s.id) || only.includes(s.id.split(':')[0]));
  const report = [];
  const jobs = [];
  const seen = new Set();
  const results = await Promise.all(list.map(async (s) => {
    const t0 = Date.now();
    try {
      const got = await s.fetch(fetchImpl);
      return { s, got, ms: Date.now() - t0 };
    } catch (e) {
      return { s, error: String(e?.message || e).slice(0, 160), ms: Date.now() - t0 };
    }
  }));
  for (const r of results) {
    if (r.error) { report.push({ source: r.s.id, label: r.s.label, ok: false, count: 0, ms: r.ms, error: r.error }); continue; }
    let n = 0;
    for (const j of r.got) {
      if (!j.title || !j.url) continue;
      const key = `${j.source}|${j.extId}`;
      if (seen.has(key)) continue;
      seen.add(key); jobs.push(j); n += 1;
    }
    report.push({ source: r.s.id, label: r.s.label, ok: true, count: n, ms: r.ms, error: null });
  }
  return { jobs, report };
}
