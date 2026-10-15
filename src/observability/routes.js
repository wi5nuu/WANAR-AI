/**
 * src/observability/routes.js
 *
 * "Peta Sistem Live" API — the data behind the 3D map of the agent:
 *
 *   GET  /overview        channels → router → providers → models, tools, health,
 *                         token usage today and remaining quota (each with its source)
 *   GET  /traces          recent requests from every channel (summaries)
 *   GET  /traces/:id      one request, every step (input, route, attempts, tools, output)
 *   GET  /events          SSE: live trace events as they happen
 *   POST /quota/refresh   re-ask the providers that publish quota (cached 5 min otherwise)
 *
 * Guarded like the other operator APIs (localhost, or AUTOMATION_TOKEN; streams
 * use short-lived tickets). Message contents are personal: they never leave this
 * guarded API and are kept in memory only.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import express from 'express';
import { createAccessGuard } from '../automation/routes.js';
import { traceHub as defaultHub, CHANNELS, summary, redactionCount } from './trace-hub.js';
import { securityMonitor as defaultMonitor, securityPosture } from './security-monitor.js';
import { runtimeSnapshot } from './runtime.js';
import { headerQuotaFor, providerApiQuota } from './quota.js';
import { PROVIDER_TIER } from '../ai-failover.js';

const PROVIDER_LABEL = {
  openagentic: 'OpenAgentic', anthropic: 'Anthropic', nvidia: 'NVIDIA NIM', vector: 'Vector', puter: 'Puter.js',
  openai: 'OpenAI', gemini: 'Google Gemini', groq: 'Groq', openrouter: 'OpenRouter', azure: 'Azure OpenAI',
  cerebras: 'Cerebras', together: 'Together AI', clouvia: 'Clouvia Router', fireworks: 'Fireworks', opencode: 'OpenCode',
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Pure: builds the provider part of the map. Exported for tests. */
export async function describeProviders({ aiManager, db = null, refresh = false, wait = false, fetcher } = {}) {
  const fo = aiManager.failover;
  let usage = { total: 0, providers: {}, models: {} };
  try { if (db) usage = db.getDailyUsage(today()); } catch { /* db optional */ }

  const seenInst = new Set();
  const out = [];
  for (const [name, inst] of Object.entries(aiManager.providers || {})) {
    if (!inst || seenInst.has(inst)) continue; // aliases (azure / azure-openai)
    seenInst.add(inst);
    let configured = false;
    try { configured = typeof inst.isAvailable === 'function' ? Boolean(inst.isAvailable()) : true; } catch { configured = false; }

    let models = [];
    try { models = fo?._modelsFor ? fo._modelsFor(name) : []; } catch { models = []; }
    const state = fo?.providerState ? fo.providerState(name) : { tier: PROVIDER_TIER[name] ?? 5, models: {} };
    const baseUrl = inst.baseUrl || inst.baseURL || null;

    const modelUsage = {};
    for (const [k, v] of Object.entries(usage.models || {})) {
      if (k.startsWith(`${name}:`)) modelUsage[k.slice(name.length + 1)] = v;
    }

    const row = {
      id: name,
      label: PROVIDER_LABEL[name] || inst.name || name,
      configured,
      isDefault: name === aiManager.currentProvider,
      tier: state.tier,
      defaultModel: inst.defaultModel || models[0] || null,
      modelCount: models.length,
      models: models.slice(0, 40).map((id) => ({
        id,
        tokensToday: modelUsage[id] || 0,
        ...(state.models?.[id] || {}),
        skip: fo?.skipReason ? fo.skipReason(name, id) : null,
      })),
      health: {
        down: state.down || false,
        downUntil: state.downUntil || null,
        circuitOpen: state.circuitOpen || false,
        consecutiveFails: state.consecutiveFails || 0,
      },
      usageToday: usage.providers?.[name] || 0,
      host: (() => { try { return baseUrl ? new URL(baseUrl).host : null; } catch { return null; } })(),
      quota: { headers: null, api: null },
    };
    if (configured) {
      row.quota.headers = baseUrl ? headerQuotaFor(baseUrl) : null;
      row.quota.api = await providerApiQuota(name, inst, { refresh, wait: refresh || wait, ...(fetcher ? { fetcher } : {}) });
    }
    out.push(row);
  }
  // Configured first, then by tier: the order the router itself prefers.
  out.sort((a, b) => (b.configured - a.configured) || (b.isDefault - a.isDefault) || (a.tier - b.tier) || a.id.localeCompare(b.id));
  return { providers: out, usage };
}

function channelStats(hub) {
  const since = Date.now() - 24 * 3600 * 1000;
  const counts = {};
  for (const t of hub.traces.values()) {
    if (t.startedAt < since) continue;
    const c = (counts[t.channel] ||= { requests: 0, errors: 0, lastAt: 0 });
    c.requests++;
    if (t.status === 'error') c.errors++;
    c.lastAt = Math.max(c.lastAt, t.startedAt);
  }
  return counts;
}

export function createSystemMapRouter({
  aiManager, db = null, config = {}, automation = null, emailDesk = null, companion = null, briefing = null,
  tools = [], hub = defaultHub, monitor = defaultMonitor, envFile = null, env = process.env, rateLimiters = {},
}) {
  const router = express.Router();
  router.use(createAccessGuard(env));
  if (rateLimiters.api) router.use(rateLimiters.api);
  router.use(express.json({ limit: '8kb' }));

  const wrap = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, ...(await fn(req)) });
    } catch (e) {
      res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Terjadi kesalahan' });
    }
  };

  const channels = () => {
    const stats = channelStats(hub);
    const tg = (() => { try { return automation?.inbox?.status?.() || null; } catch { return null; } })();
    const watcher = (() => { try { return emailDesk?.watcher?.describe?.() || null; } catch { return null; } })();
    const comp = (() => { try { return companion?.status?.() || null; } catch { return null; } })();
    const base = (id, extra) => ({ id, label: CHANNELS[id].label, icon: CHANNELS[id].icon, stats: stats[id] || { requests: 0, errors: 0, lastAt: 0 }, ...extra });
    return [
      base('web', { active: true, detail: 'Chat di aplikasi web (streaming SSE)' }),
      base('telegram', {
        active: Boolean(tg?.running),
        detail: tg ? (tg.running ? `Bot aktif · polling Telegram · ${tg.aiChat?.chats || 0} chat dijawab AI` : 'Bot tidak berjalan (polling mati)') : 'Telegram belum diatur',
        status: tg,
      }),
      base('email', {
        active: Boolean(emailDesk),
        detail: emailDesk
          ? `${emailDesk.desk?.live ? 'Kirim email aktif' : 'Kirim email simulasi'} · pantau balasan: ${watcher?.configured ? watcher.state : 'IMAP belum diatur'}`
          : 'Email Desk tidak aktif',
        status: watcher ? { state: watcher.state, processed: watcher.processed, lastMailAt: watcher.lastMailAt || null, lastError: watcher.lastError || null } : null,
      }),
      base('companion', {
        active: Boolean(comp?.enabled) && !comp?.paused,
        detail: comp ? `${comp.enabled ? (comp.paused ? 'Sedang diam' : 'Aktif') : 'Mati'} · ${comp.sentToday}/${comp.maxPerDay} sapaan hari ini` : 'Tidak aktif',
        status: comp,
      }),
      base('briefing', { active: Boolean(briefing), detail: briefing ? 'Briefing pagi otomatis di hari kerja' : 'Tidak aktif' }),
      base('automation', { active: Boolean(automation), detail: automation ? 'Penjadwal & kampanye' : 'Tidak aktif' }),
      base('system', { active: true, detail: 'Panggilan AI internal (CLI, prompt lab, tugas lain)' }),
    ];
  };

  const securityBlock = () => ({
    level: monitor.level(),
    window: monitor.window(60),
    totals: monitor.totals,
    series: monitor.series(30),
    sources: monitor.topSources(6),
    redactions: redactionCount(),
    posture: securityPosture({ env, monitor, envFile, config }),
    recent: monitor.recent(25),
  });

  router.get('/security', wrap(async () => ({ security: securityBlock() })));

  router.get('/overview', wrap(async (req) => {
    const { providers, usage } = await describeProviders({ aiManager, db, refresh: req.query.refresh === '1' });
    const limit = Number(config.tokens?.dailyLimit) || null;
    const toolList = (typeof tools === 'function' ? tools() : tools) || [];
    const groups = {};
    for (const t of toolList) {
      const name = t.function?.name || t.name;
      if (!name) continue;
      const g = name.split('_')[0];
      (groups[g] ||= []).push(name);
    }
    return {
      now: Date.now(),
      channels: channels(),
      router: {
        defaultProvider: aiManager.currentProvider,
        strategy: 'Model yang diminta → model lain di provider yang sama → provider lain menurut tier (1 = utama) dan kesehatan. Model yang kuotanya habis, kuncinya ditolak, atau sedang sering gagal dilewati otomatis sampai pulih.',
        recentFailovers: (aiManager.failover?.history || []).slice(-15).reverse(),
      },
      providers,
      tools: { count: toolList.length, groups },
      latency: hub.latency(),
      runtime: runtimeSnapshot({ sseClients: hub.listenerCount('trace') }),
      security: securityBlock(),
      usage: {
        date: today(),
        total: usage.total || 0,
        cost: usage.cost || 0,
        limit,
        remaining: limit ? Math.max(0, limit - (usage.total || 0)) : null,
        source: 'Hitungan lokal Wanar (token_usage)',
      },
      traces: hub.list({ limit: 40 }),
    };
  }));

  router.get('/traces', wrap(async (req) => {
    const limit = Math.min(150, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const channel = CHANNELS[req.query.channel] ? req.query.channel : null;
    return { traces: hub.list({ limit, channel }) };
  }));

  router.get('/traces/:id', wrap(async (req) => {
    const t = hub.get(String(req.params.id));
    if (!t) { const e = new Error('Jejak tidak ditemukan (mungkin sudah tergeser yang lebih baru)'); e.status = 404; throw e; }
    return { trace: { ...t, summary: summary(t) } };
  }));

  router.post('/quota/refresh', wrap(async () => {
    const { providers } = await describeProviders({ aiManager, db, refresh: true });
    return { providers };
  }));

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    const onTrace = (e) => {
      try { res.write(`event: trace\ndata: ${JSON.stringify(e)}\n\n`); } catch { /* closed */ }
    };
    const onSecurity = (ev) => {
      try { res.write(`event: security\ndata: ${JSON.stringify(ev)}\n\n`); } catch { /* closed */ }
    };
    hub.on('trace', onTrace);
    monitor.on('event', onSecurity);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
    req.on('close', () => { clearInterval(hb); hub.off('trace', onTrace); monitor.off('event', onSecurity); });
  });

  return router;
}
