/**
 * src/memory/owner-context.js
 *
 * "One brain": a compact, question-aware snapshot of everything the owner does
 * across Wanar AI — web chat, automation, work journal, Telegram — so the AI
 * on any surface (today: the Telegram bot) can answer accurately about it.
 *
 *   Always:   work journal (today + 7 days), automation (jobs, recent runs,
 *             campaigns, channels), recent contacts, recent chat topics
 *   On demand: chat messages matching the question's keywords (so "kemarin
 *             saya tanya apa soal docker?" finds the actual exchange)
 *
 * Bounded (≈5k chars) and secret-redacted: credentials the owner once pasted
 * into a chat are never echoed back into a prompt.
 *
 * Only ever used for the OWNER (allow-listed Telegram chats / local web UI).
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { formatMinutes, formatRupiah, formatDateId } from '../worklog/time.js';
import { formatDistance } from '../location/geo.js';

const MAX_TOTAL = 5200;
const SNIPPET = 320;

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,                    // OpenAI-style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,               // GitHub tokens
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,              // Telegram bot tokens
  /\bAIza[0-9A-Za-z_-]{30,}/g,                   // Google API keys
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,              // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /\b(?:nvapi|EAA)[A-Za-z0-9_-]{20,}/g,          // NVIDIA / Meta tokens
  /((?:password|passwd|pass|pwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi,
];

export function redact(text) {
  let s = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m, p1) => (typeof p1 === 'string' && p1 && m.startsWith(p1) ? `${p1}[disamarkan]` : '[disamarkan]'));
  }
  return s;
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const STOP = new Set(`yang dan atau dengan untuk dari pada dalam ini itu ada apa saja saya aku kamu anda bisa akan sudah belum tidak tadi kemarin hari minggu bulan tahun tolong coba lagi mau ingin jadi juga karena kalau kapan siapa bagaimana gimana berapa kenapa mana sini situ dong sih nih kok deh yuk ya ok oke the and for with what when how`.split(/\s+/));

/** Meaningful words of a question, for searching past chats. */
export function keywordsOf(text, max = 6) {
  const words = String(text || '').toLowerCase().normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s.+#-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.+#-]+|[.+#-]+$/g, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, max);
}

const WIB = (sqlTime) => {
  if (!sqlTime) return '';
  const ms = Date.parse(String(sqlTime).includes('T') ? sqlTime : `${String(sqlTime).replace(' ', 'T')}Z`);
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
};

/**
 * @param {object} deps
 * @param {object} deps.db          better-sqlite3 handle (chat_sessions / chat_messages)
 * @param {object} [deps.automation] automation module
 * @param {object} [deps.worklog]   { service }
 * @param {object} [deps.memory]    personal memory module ({ service })
 * @param {object} [deps.location]  tracking module ({ service })
 * @param {object} [deps.vehicle]   vehicle module ({ service })
 * @param {object} [deps.emergency] emergency module ({ service })
 */
export function createOwnerContext({ db, automation = null, worklog = null, memory = null, location = null, vehicle = null, emergency = null }) {
  // ------------------------------------------------------------ sections

  function journalSection() {
    const svc = worklog?.service;
    if (!svc) return '';
    try {
      const st = svc.status();
      const d = svc.day(st.date);
      const w = svc.week(st.date).summary;
      const state = { working: 'sedang bekerja', break: 'sedang istirahat', done: 'sudah selesai bekerja', idle: 'belum mulai bekerja' }[st.state];
      const lines = [
        `JURNAL KERJA — ${formatDateId(st.date)}: ${state}.`,
        `Hari ini: kerja ${formatMinutes(d.workedMin)} dari target ${formatMinutes(d.targetMin)}, istirahat ${formatMinutes(d.breakMin)}, tugas ${d.tasks.done}/${d.tasks.total} selesai, uang +${formatRupiah(d.money.income)} / -${formatRupiah(d.money.expense)}.`,
        `Penilaian: ${d.verdict.text} Keseimbangan ${d.balance.label} (${d.balance.score}/100), produktivitas ${d.productivity}/100.`,
      ];
      if (d.comparison.workedPct != null) lines.push(`Dibanding ${d.comparison.previousDate}: ${d.comparison.workedPct >= 0 ? '+' : ''}${d.comparison.workedPct}% jam kerja.`);
      if (st.next) lines.push(`Jadwal otomatis berikutnya: ${st.next.kind} pukul ${new Date(st.next.at).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })}.`);
      if (d.taskList.length) lines.push(`Tugas hari ini: ${d.taskList.slice(0, 8).map((t) => `${t.done ? '✓' : '○'} ${clip(t.title, 60)}`).join('; ')}.`);
      if (d.reportText) lines.push(`Laporan hari ini: ${clip(redact(d.reportText), 240)}`);
      lines.push(`7 hari terakhir: kerja ${formatMinutes(w.workedMin)} (${w.activeDays} hari aktif), ${w.tasksDone} tugas, bersih ${formatRupiah(w.net)}, keseimbangan rata-rata ${w.avgBalance}/100.`);
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  function automationSection() {
    if (!automation?.store) return '';
    try {
      const { store, channels, scheduler } = automation;
      const jobs = store.jobs.list();
      const lines = ['OTOMASI:'];
      if (channels) {
        const live = channels.describeAll().filter((c) => c.mode === 'live').map((c) => c.id);
        lines.push(`Kanal aktif: ${live.length ? live.join(', ') : 'belum ada (semua simulasi)'}.`);
      }
      if (!jobs.length) lines.push('Belum ada job terjadwal.');
      for (const j of jobs.slice(0, 8)) {
        const p = scheduler?.present ? scheduler.present(j) : j;
        const next = j.next_run_at && j.status === 'active'
          ? `, berikutnya ${new Date(j.next_run_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
        lines.push(`- Job "${clip(j.name, 50)}" (${j.type}, ${p.scheduleDescription || j.schedule}) status ${j.status}${next}, dijalankan ${j.run_count}x, terakhir ${j.last_status || '-'}.`);
      }
      const runs = store.runs.recent(5);
      if (runs.length) {
        lines.push(`Eksekusi terakhir: ${runs.map((r) => `${clip(r.job_name || r.job_id, 30)} ${r.status} (${new Date(r.started_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})`).join('; ')}.`);
      }
      const camps = store.campaigns.list(6);
      for (const c of camps) {
        lines.push(`- Kampanye "${clip(c.name, 50)}" via ${c.channel || 'email'}: ${c.status}, terkirim ${c.stats.sent}/${c.stats.total}${c.stats.failed ? `, gagal ${c.stats.failed}` : ''}${c.mode === 'dry-run' ? ' (simulasi)' : ''}.`);
      }
      const subs = store.subscribers?.counts?.('telegram');
      if (subs?.total) lines.push(`Pelanggan Telegram: ${subs.active} aktif dari ${subs.total}.`);
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  function peopleSection() {
    const store = automation?.store;
    if (!store?.people) return '';
    try {
      const rows = store.people.list({ limit: 8 });
      if (!rows.length) return '';
      const total = store.people.count();
      const label = { whatsapp: 'WA', telegram: 'Telegram' };
      const when = (ms) => (Number.isFinite(Number(ms))
        ? new Date(Number(ms)).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : '');
      const lines = rows.map((r) => {
        const who = clip(r.name || 'tanpa nama', 40);
        const tail = `…${String(r.address || '').slice(-4)}`;
        const preview = r.last_message ? ` — pesan terakhir: "${clip(redact(r.last_message), 120)}"` : '';
        return `- ${who} (${label[r.channel] || r.channel} ${tail}, ${r.seen_count} pesan, terakhir ${when(r.last_seen_at)})${preview}`;
      });
      return [
        'KONTAK — ORANG LAIN YANG PERNAH MENGHUBUNGI (jawab pertanyaan seperti "siapa yang chat tadi" dari daftar ini; ini bukan pemilik):',
        ...lines,
        total > rows.length ? `(${total - rows.length} kontak lain tidak ditampilkan.)` : '',
      ].filter(Boolean).join('\n');
    } catch {
      return '';
    }
  }

  function recentChatsSection() {
    try {
      const rows = db.prepare(`
        SELECT s.id, s.title, s.updated_at,
               (SELECT content FROM chat_messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id DESC LIMIT 1) AS last_user
        FROM chat_sessions s
        WHERE EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id)
        ORDER BY s.updated_at DESC LIMIT 8
      `).all();
      if (!rows.length) return '';
      return ['PERCAKAPAN TERAKHIR (web & Telegram):',
        ...rows.map((r) => `- ${WIB(r.updated_at)} "${clip(redact(r.title), 60)}"${r.last_user && r.last_user !== r.title ? ` — terakhir: ${clip(redact(r.last_user), 90)}` : ''}`)].join('\n');
    } catch {
      return '';
    }
  }

  function relevantChatsSection(question, excludeSessionId) {
    const words = keywordsOf(question);
    if (!words.length) return '';
    try {
      const like = words.map(() => 'LOWER(m.content) LIKE ?').join(' OR ');
      const rows = db.prepare(`
        SELECT m.id, m.session_id, m.role, m.content, m.created_at, s.title
        FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
        WHERE (${like}) ${excludeSessionId ? 'AND m.session_id <> ?' : ''}
        ORDER BY m.id DESC LIMIT 200
      `).all(...words.map((w) => `%${w}%`), ...(excludeSessionId ? [excludeSessionId] : []));
      if (!rows.length) return '';

      const scored = rows.map((r) => {
        const t = r.content.toLowerCase();
        return { ...r, score: words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0) };
      }).sort((a, b) => b.score - a.score || (b.role === 'user') - (a.role === 'user') || b.id - a.id).slice(0, 6);

      // Pair each hit with its neighbour, so a question comes with its answer.
      const pick = db.prepare('SELECT id, role, content FROM chat_messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT 1');
      const out = ['PERCAKAPAN LAMA YANG RELEVAN DENGAN PERTANYAAN INI:'];
      const used = new Set();
      for (const r of scored) {
        if (used.has(r.id)) continue; // already shown as the answer to a question above
        used.add(r.id);
        const who = r.role === 'user' ? 'Wisnu' : 'AI';
        let line = `- [${WIB(r.created_at)} · "${clip(r.title, 40)}"] ${who}: ${clip(redact(r.content), SNIPPET)}`;
        if (r.role === 'user') {
          const next = pick.get(r.session_id, r.id);
          if (next?.role === 'assistant') {
            line += `\n  AI menjawab: ${clip(redact(next.content), SNIPPET)}`;
            used.add(next.id);
          }
        }
        out.push(line);
      }
      return out.join('\n');
    } catch {
      return '';
    }
  }

  function personalSection(question) {
    if (!memory?.service) return '';
    try {
      const block = memory.service.buildPromptBlock({ text: question || '' });
      return block.text || '';
    } catch {
      return '';
    }
  }

  function trackingSection() {
    if (!location?.service) return '';
    try {
      const st = location.service.currentStatus();
      const lines = ['LOKASI & MOTOR (angka nyata dari modul pelacakan; jangan menghitung sendiri):'];
      if (!st.position) {
        lines.push('- Posisi: belum ada data lokasi (pelacakan mati atau HP belum mengirim).');
      } else {
        lines.push(`- ${st.position.fresh ? 'Posisi terkini' : `Lokasi terakhir yang diketahui (${Math.round(st.position.ageMs / 60000)} menit lalu)`}: ${st.position.lat.toFixed(5)}, ${st.position.lon.toFixed(5)} (±${st.position.accuracy != null ? `${Math.round(st.position.accuracy)} m` : '?'})${st.place ? `, di area "${st.place.label}"` : ''}.`);
        const near = Array.isArray(st.places) ? st.places.slice(0, 5) : [];
        if (near.length) {
          lines.push(`- Jarak dari titik terakhir (garis lurus): ${near.map((p) => `${p.name} ${formatDistance(p.distanceM)}${p.inside ? ' (di dalam area)' : ''}`).join('; ')}.`);
        }
        lines.push(`- Hari ini: ${(st.today.distanceM / 1000).toFixed(1)} km lintasan GPS, ${st.today.trips} perjalanan, ${st.today.stops} kunjungan (jarak GPS ≠ odometer).`);
      }
      try {
        const places = (location.service.store?.places?.list?.() || []).slice(0, 8);
        if (places.length) {
          lines.push(`- Tempat tersimpan: ${places.map((p) => `${p.name} (${Number(p.lat).toFixed(5)}, ${Number(p.lon).toFixed(5)}${p.radius_m ? ` ±${p.radius_m} m` : ''})`).join('; ')}.`);
        }
      } catch { /* places are optional */ }
      if (vehicle?.service) {
        try { lines.push(`- ${vehicle.service.summaryLine()}`); } catch { /* vehicle optional */ }
      }
      if (emergency?.service) {
        try { lines.push(`- ${emergency.service.summaryLine()}`); } catch { /* emergency optional */ }
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------- build

  /**
   * @param {{text?: string, excludeSessionId?: string}} [q]
   * @returns {string}
   */
  return function buildContext({ text = '', excludeSessionId = null } = {}) {
    const parts = [
      'DATA SISTEM WANAR AI MILIK PENGGUNA (gunakan untuk menjawab; jangan mengarang di luar data ini):',
      journalSection(),
      automationSection(),
      peopleSection(),
      trackingSection(),
      personalSection(text),
      relevantChatsSection(text, excludeSessionId),
      recentChatsSection(),
    ].filter(Boolean);
    let out = parts.join('\n\n');
    if (out.length > MAX_TOTAL) out = `${out.slice(0, MAX_TOTAL - 1)}…`;
    return out;
  };
}

// --------------------------------------- chat channels -> chat history

/**
 * Persists AI conversations from a messaging channel as regular chat sessions
 * (one per chat per day), so they show up in the web sidebar and in the shared
 * memory above.
 */
function createChannelTranscript({ db, tz = 'Asia/Jakarta', prefix, label, provider, model }) {
  const ensure = db.prepare('INSERT OR IGNORE INTO chat_sessions (id, title, provider, model) VALUES (?, ?, ?, ?)');
  const add = db.prepare('INSERT INTO chat_messages (session_id, role, content, tokens, provider, model) VALUES (?, ?, ?, 0, ?, ?)');
  const touch = db.prepare("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?");

  const sessionId = (chatId, at = Date.now()) => {
    const date = new Date(at).toLocaleDateString('en-CA', { timeZone: tz });
    return `${prefix}-${String(chatId).replace(/[^0-9-]/g, '')}-${date}`;
  };

  const recent = db.prepare('SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?');

  return {
    sessionId,
    /** Today's saved exchange for a chat, oldest first (restores bot memory after restart). */
    history(chatId, limit = 12) {
      return recent.all(sessionId(chatId), limit).reverse().map((r) => ({ role: r.role, content: r.content }));
    },
    /** Assistant-initiated message (no user turn before it). */
    recordOutgoing({ chatId, assistant, at = Date.now() }) {
      const id = sessionId(chatId, at);
      const when = new Date(at).toLocaleDateString('id-ID', { timeZone: tz, day: 'numeric', month: 'short' });
      db.transaction(() => {
        ensure.run(id, `${label} · ${when}`, provider, model);
        add.run(id, 'assistant', String(assistant).slice(0, 8000), provider, model);
        touch.run(id);
      })();
      return id;
    },
    record({ chatId, user, assistant, at = Date.now() }) {
      const id = sessionId(chatId, at);
      const when = new Date(at).toLocaleDateString('id-ID', { timeZone: tz, day: 'numeric', month: 'short' });
      db.transaction(() => {
        ensure.run(id, `${label} · ${when}`, provider, model);
        add.run(id, 'user', String(user).slice(0, 8000), provider, model);
        add.run(id, 'assistant', String(assistant).slice(0, 8000), provider, model);
        touch.run(id);
      })();
      return id;
    },
  };
}

/** Telegram AI conversations ("tg-<chat>-<date>"). */
export function createTelegramTranscript({ db, tz = 'Asia/Jakarta' }) {
  return createChannelTranscript({ db, tz, prefix: 'tg', label: 'Telegram', provider: 'telegram', model: 'telegram-bot' });
}

/** WhatsApp AI conversations ("wa-<phone>-<date>"). */
export function createWhatsAppTranscript({ db, tz = 'Asia/Jakarta' }) {
  return createChannelTranscript({ db, tz, prefix: 'wa', label: 'WhatsApp', provider: 'whatsapp', model: 'whatsapp-bot' });
}
