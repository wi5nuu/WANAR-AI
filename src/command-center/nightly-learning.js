/**
 * src/command-center/nightly-learning.js
 *
 * Nightly self-review. Every day at 00:00 (Asia/Jakarta by default) the agent
 * studies the previous 24 hours of its own traffic and distils short "lessons"
 * that are injected into its system prompt afterwards:
 *
 *   reliability  providers/models that failed often → prefer the steadier one
 *   speed        slow models → keep answers short / pick faster models
 *   correction   user messages that said "wrong / not that / I meant…"
 *   topic        what people actually asked about most → answer those sharper
 *
 * This is prompt-level learning (no model weights are changed, no raw chat is
 * stored beyond short redacted snippets). Runs are de-duplicated per day in
 * wl_meta, survive restarts and can be triggered manually.
 *
 * @author Wisnu Alfian Nur Ashar
 */

const KEEP_RUNS = 14;
const MAX_PROMPT_CHARS = 1100;
const KEY_RUNS = 'learning_runs';
const TZ_DEFAULT = process.env.AUTOMATION_TZ || 'Asia/Jakarta';

const STOP = new Set(('yang dan di ke dari untuk dengan ini itu atau pada adalah saya aku kamu anda kita kami mereka bisa ' +
  'apa bagaimana kenapa mengapa tidak ada akan sudah juga lebih karena jadi kalau agar sebuah the and for with that this ' +
  'you are what how why can does not have from your please tolong mohon buat bikin jelaskan cara').split(/\s+/));

const CORRECTION_RE = /^(salah|bukan|keliru|tidak benar|nggak benar|gak benar|maksud saya|maksudku|yang benar|koreksi|wrong|that'?s not|no,|incorrect)/i;

function redact(s) {
  return String(s || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?:sk|pk|ghp|xox[bap]|AIza)[\w-]{12,}\b/g, '[secret]')
    .replace(/\b\d{7,}\b/g, '[nomor]')
    .replace(/\s+/g, ' ')
    .trim();
}

function localDate(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function localHourMin(ms, tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  return { h: Number(p.find((x) => x.type === 'hour').value) % 24, m: Number(p.find((x) => x.type === 'minute').value) };
}
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export function createNightlyLearning({ db, meta, now = Date.now, tz = TZ_DEFAULT, hour = 0, graceHours = 6, enabled = true, notify = null } = {}) {
  let timer = null;
  let running = false;

  const readRuns = () => {
    try { return JSON.parse(meta.get(KEY_RUNS) || '[]'); } catch { return []; }
  };

  function analyse(sinceMs, untilMs) {
    const since = sqlTime(sinceMs);
    const until = sqlTime(untilMs);
    const lessons = [];

    // Reliability + speed from request logs
    let providers = [];
    try {
      providers = db.prepare(`
        SELECT provider, model, COUNT(*) AS total,
               SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
               AVG(NULLIF(response_time_ms, 0)) AS avg_ms
        FROM request_logs WHERE created_at >= ? AND created_at < ?
        GROUP BY provider, model HAVING total >= 3`).all(since, until);
    } catch { /* table may not exist in minimal setups */ }
    for (const p of providers) {
      const rate = p.errors / p.total;
      if (rate >= 0.2) lessons.push({ kind: 'reliability', weight: 3 + rate * 4, text: `${p.provider}/${p.model} gagal ${p.errors} dari ${p.total} permintaan — utamakan penyedia yang lebih stabil.` });
      else if (p.avg_ms > 15_000) lessons.push({ kind: 'speed', weight: 2, text: `${p.provider}/${p.model} lambat (rata-rata ${(p.avg_ms / 1000).toFixed(1)} dtk) — jawab ringkas bila memakai model ini.` });
    }

    // Corrections + topics from user messages
    let msgs = [];
    try {
      msgs = db.prepare(`SELECT content FROM chat_messages WHERE role = 'user' AND created_at >= ? AND created_at < ? ORDER BY id DESC LIMIT 800`).all(since, until);
    } catch { /* ignore */ }
    const corrections = msgs.map((m) => redact(m.content)).filter((t) => t.length > 6 && CORRECTION_RE.test(t));
    for (const t of corrections.slice(0, 3)) lessons.push({ kind: 'correction', weight: 5, text: `Pengguna mengoreksi: "${t.slice(0, 140)}" — periksa ulang fakta sebelum menjawab hal serupa.` });

    const freq = new Map();
    for (const m of msgs) {
      const words = new Set(redact(m.content).toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w)));
      for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
    }
    const topics = [...freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (topics.length) lessons.push({ kind: 'topic', weight: 1, text: `Topik paling sering ditanyakan: ${topics.map(([w, n]) => `${w} (${n}×)`).join(', ')} — siapkan jawaban yang tajam & terkini.` });

    return {
      stats: {
        requests: providers.reduce((a, p) => a + p.total, 0),
        errors: providers.reduce((a, p) => a + p.errors, 0),
        userMessages: msgs.length,
        corrections: corrections.length,
      },
      lessons: lessons.sort((a, b) => b.weight - a.weight).slice(0, 8),
    };
  }

  async function run({ manual = false } = {}) {
    if (running) return null;
    running = true;
    try {
      const at = now();
      const date = localDate(at, tz);
      const { stats, lessons } = analyse(at - 24 * 3_600_000, at);
      const entry = { date, at, manual, stats, lessons };
      const runs = [entry, ...readRuns().filter((r) => !(r.date === date && !manual && r.manual === false))].slice(0, KEEP_RUNS);
      meta.set(KEY_RUNS, JSON.stringify(runs));
      if (notify) {
        try { await notify(`🌙 Pembelajaran malam selesai (${date}): ${lessons.length} pelajaran dari ${stats.userMessages} pesan & ${stats.requests} permintaan.`); } catch { /* optional */ }
      }
      return entry;
    } finally {
      running = false;
    }
  }

  async function tick() {
    if (!enabled) return false;
    const at = now();
    const { h, m } = localHourMin(at, tz);
    const minutesSinceTarget = ((h - hour + 24) % 24) * 60 + m;
    if (minutesSinceTarget > graceHours * 60) return false; // only at/just after the target hour (covers a short outage)
    const key = `learning_run:${localDate(at, tz)}`;
    if (meta.get(key)) return false;
    meta.set(key, String(at)); // mark first: never twice
    await run();
    return true;
  }

  /** Compact block for the system prompt; empty string when nothing was learned. */
  function promptBlock() {
    const runs = readRuns();
    if (!runs.length) return '';
    const seen = new Set();
    const picked = [];
    for (const r of runs.slice(0, 5)) {
      for (const l of r.lessons || []) {
        const k = l.text.slice(0, 60);
        if (seen.has(k)) continue;
        seen.add(k);
        picked.push(l);
      }
    }
    picked.sort((a, b) => b.weight - a.weight);
    let out = '\n\nPelajaran dari interaksi sebelumnya (pembelajaran otomatis tiap tengah malam):';
    for (const l of picked) {
      const line = `\n- ${l.text}`;
      if (out.length + line.length > MAX_PROMPT_CHARS) break;
      out += line;
    }
    return out.length > 90 ? out : '';
  }

  return {
    run,
    tick,
    promptBlock,
    status() {
      const runs = readRuns();
      const at = now();
      return {
        enabled,
        timezone: tz,
        schedule: `${String(hour).padStart(2, '0')}:00`,
        last: runs[0] || null,
        history: runs.slice(0, 7).map((r) => ({ date: r.date, at: r.at, manual: !!r.manual, lessons: r.lessons.length, stats: r.stats })),
        today: localDate(at, tz),
      };
    },
    start() {
      if (timer || !enabled) return false;
      timer = setInterval(() => { tick().catch(() => {}); }, 60_000);
      timer.unref?.();
      tick().catch(() => {});
      return true;
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
