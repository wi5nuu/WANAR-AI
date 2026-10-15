/**
 * src/companion.js
 *
 * "Peka": the assistant sometimes starts the conversation itself, like a caring
 * subordinate who notices how the boss' day is going —
 *   "Pak Wisnu, sudah tiga jam nonstop ya. Capek? Istirahat sebentar yuk."
 *   "Pak Wisnu, ada yang ingin diceritakan?"
 *
 * Triggers come from REAL state (work clock, break, tasks, time of day), and are
 * gated so it never becomes noise: quiet hours, a daily cap, a minimum gap, no
 * interruption while the boss is chatting, and a pause he controls
 * ("jangan ganggu dulu"). The wording is written by the model in persona, with
 * hand-written fallbacks so a check-in never fails just because AI is down.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { collect } from './automation/ai-compose.js';
import { localDate, minuteOfDay, weekday } from './worklog/time.js';
import { withTrace, traceStep } from './observability/trace-hub.js';

const hm = (s, d = 0) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : d; };
const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length) % arr.length];

/** Hand-written fallbacks, several per kind so they do not repeat verbatim. */
const FALLBACK = {
  overtime: [
    '{call}, sudah lewat jam kerja nih. Mau saya bantu merapikan yang tersisa, atau sebaiknya disudahi dulu hari ini?',
    '{call}, ini sudah malam untuk ukuran jam kerja. Capek ya? Kalau mau, kita tutup dulu hari ini.',
  ],
  long_stretch: [
    '{call}, sudah cukup lama nonstop. Capek ya? Istirahat sebentar, minum dulu, nanti dilanjut lagi.',
    '{call}, dari tadi belum berhenti sama sekali. Peregangan sebentar yuk, biar kepala tetap segar.',
  ],
  skipped_lunch: [
    '{call}, sudah makan siang belum? Jangan sampai kelewatan ya, tenaganya perlu.',
    '{call}, ini sudah lewat jam makan siang. Makan dulu ya, kerjaan bisa menunggu sebentar.',
  ],
  morning_checkin: [
    'Selamat pagi, {call}. Gimana perasaannya hari ini, siap atau masih berat? Kalau ada yang mau dibagi, saya dengerin.',
    'Pagi, {call}. Tidurnya nyenyak? Hari ini ada yang bikin kepikiran?',
  ],
  all_done: [
    '{call}, semua tugas hari ini sudah selesai. Kerja bagus. Gimana rasanya, lega?',
  ],
  not_started: [
    '{call}, jam kerja sudah berjalan tapi belum mulai. Ada kendala, atau memang lagi butuh waktu dulu?',
  ],
  evening_reflect: [
    '{call}, hari ini gimana? Ada yang ingin diceritakan, entah soal kerjaan atau yang lain?',
    'Malam, {call}. Seharian tadi berat nggak? Kalau mau cerita, saya di sini.',
  ],
  random_care: [
    '{call}, lagi ada yang dipikirkan? Kalau mau cerita sesuatu, saya dengerin.',
    '{call}, ada keluhan hari ini? Cerita saja, nggak harus soal kerjaan.',
    '{call}, gimana kabarnya sekarang? Capek, atau malah lagi semangat?',
  ],
};

const KIND_HINT = {
  overtime: 'Sudah melewati jam kerja dan dia masih bekerja. Tanyakan dengan lembut apakah masih mau lanjut atau diakhiri; perhatikan kondisinya.',
  long_stretch: 'Dia sudah bekerja terus-menerus cukup lama tanpa jeda. Tanyakan apakah capek dan ajak istirahat sebentar.',
  skipped_lunch: 'Sudah lewat jam makan siang dan belum ada istirahat tercatat. Tanyakan sudah makan belum dengan perhatian.',
  morning_checkin: 'Awal hari kerja. Sapa hangat dan tanyakan perasaannya hari ini (bukan daftar tugas).',
  all_done: 'Semua tugasnya hari ini sudah selesai. Apresiasi dengan tulus lalu tanyakan perasaannya.',
  not_started: 'Jam kerja sudah berjalan lama tapi dia belum mulai. Tanyakan lembut apakah ada kendala; jangan menyalahkan.',
  evening_reflect: 'Sudah malam. Ajak dia merenungkan hari ini dan beri ruang bercerita (kerja atau hal lain).',
  random_care: 'Tidak ada pemicu khusus; sapaan kepedulian biasa. Tanyakan apakah ada keluhan atau sesuatu yang ingin diceritakan.',
};

export function createCompanion({
  worklog, aiManager = null, notify = null, defaultChatId = () => null, remember = null,
  env = process.env, now = () => Date.now(), random = Math.random, ownerName = process.env.OWNER_NAME || 'Wisnu Alfian Nur Ashar',
}) {
  const first = String(ownerName).split(/\s+/)[0];
  const call = () => String(env.OWNER_CALL || '').trim() || `Pak ${first}`;
  const meta = worklog.store.meta;
  const cfg = {
    enabled: String(env.COMPANION_ENABLED ?? 'true').toLowerCase() !== 'false',
    maxPerDay: Math.max(0, parseInt(env.COMPANION_MAX_PER_DAY || '3', 10) || 3),
    minGapMin: Math.max(10, parseInt(env.COMPANION_MIN_GAP_MIN || '90', 10) || 90),
    quietBefore: hm(env.COMPANION_FROM || '07:00', 420),
    quietAfter: hm(env.COMPANION_UNTIL || '21:30', 1290),
    busyWithinMin: 20,
    tickMs: 10 * 60_000,
  };
  let timer = null;

  const mkey = (k) => `companion:${k}`;
  const getNum = (k) => Number(meta.get(mkey(k)) || 0);
  const setNum = (k, v) => meta.set(mkey(k), String(v));

  // ------------------------------------------------------------- controls
  function isEnabled() { return cfg.enabled && meta.get(mkey('off')) !== '1'; }
  function pausedUntil() { return getNum('pause_until'); }
  function isPaused(at = now()) { return pausedUntil() > at; }

  function pause(hours = 4) {
    const until = now() + Math.max(0.25, Math.min(48, hours)) * 3_600_000;
    setNum('pause_until', until);
    return until;
  }
  function resume() { setNum('pause_until', 0); meta.set(mkey('off'), '0'); }
  function setEnabled(on) { meta.set(mkey('off'), on ? '0' : '1'); }
  function noteOwnerMessage(at = now()) { setNum('owner_last_msg', at); }

  // -------------------------------------------------------------- signals
  function signals(at = now()) {
    const today = localDate(at);
    const s = worklog.getSettings();
    const st = worklog.status();
    const day = worklog.day(today, { light: true });
    const minute = minuteOfDay(at);
    const open = day.openSegment;
    return {
      at, today, minute,
      isWorkday: (s.workdays || []).includes(weekday(today)),
      workStart: hm(s.workStart, 480),
      workEnd: hm(s.workEnd, 1020),
      breakEnd: s.breakEnd ? hm(s.breakEnd, 780) : null,
      state: st.state, // working | break | done | idle
      streakMin: open && open.kind === 'work' ? Math.max(0, (at - open.startAt) / 60_000) : 0,
      workedMin: day.workedMin || 0,
      breakMin: day.breakMin || 0,
      tasksTotal: day.tasks?.total || 0,
      tasksDone: day.tasks?.done || 0,
    };
  }

  const doneToday = (kind, today) => meta.get(mkey(`${kind}:${today}`)) === '1';
  const markToday = (kind, today) => meta.set(mkey(`${kind}:${today}`), '1');
  const coolOk = (kind, at, hours) => at - getNum(`last:${kind}`) >= hours * 3_600_000;

  /** @returns {{kind:string, facts:string}|null} */
  function choose(sg, rnd = random) {
    const { today, minute } = sg;
    const lines = [];
    const add = (kind, fact) => ({ kind, facts: [fact, ...lines].filter(Boolean).join(' ') });
    if (sg.isWorkday) {
      lines.push(`Jam kerja ${Math.floor(sg.workStart / 60)}:${String(sg.workStart % 60).padStart(2, '0')}–${Math.floor(sg.workEnd / 60)}:${String(sg.workEnd % 60).padStart(2, '0')}.`);
      lines.push(`Tercatat bekerja ${Math.floor(sg.workedMin / 60)}j ${Math.round(sg.workedMin % 60)}m hari ini; tugas selesai ${sg.tasksDone} dari ${sg.tasksTotal}.`);

      if (sg.state === 'working' && minute >= sg.workEnd + 30 && coolOk('overtime', sg.at, 2)) return add('overtime', 'Sudah melewati jam kerja.');
      if (sg.state === 'working' && sg.streakMin >= 150 && coolOk('long_stretch', sg.at, 3) && rnd() < 0.85) {
        return add('long_stretch', `Sudah bekerja nonstop sekitar ${Math.round(sg.streakMin)} menit.`);
      }
      if (sg.state === 'working' && sg.breakEnd && minute >= sg.breakEnd + 30 && sg.breakMin === 0 && !doneToday('skipped_lunch', today)) {
        return add('skipped_lunch', 'Belum ada istirahat tercatat hari ini.');
      }
      if (sg.tasksTotal > 0 && sg.tasksDone === sg.tasksTotal && minute >= 12 * 60 && !doneToday('all_done', today)) {
        return add('all_done', 'Semua tugas hari ini selesai.');
      }
      if (sg.state === 'idle' && minute >= sg.workStart + 45 && minute < sg.workEnd && !doneToday('not_started', today)) {
        return add('not_started', 'Jam kerja berjalan tapi belum mulai.');
      }
      if (minute >= sg.workStart + 20 && minute <= sg.workStart + 150 && !doneToday('morning_checkin', today) && rnd() < 0.7) {
        return add('morning_checkin', 'Pagi di awal hari kerja.');
      }
    }
    if (minute >= 20 * 60 && minute <= 21 * 60 + 15 && !doneToday('evening_reflect', today) && rnd() < 0.5) {
      return add('evening_reflect', 'Sudah malam.');
    }
    if (minute >= 10 * 60 && minute <= 16 * 60 + 30 && coolOk('random_care', sg.at, 5) && rnd() < 0.05) {
      return add('random_care', 'Siang hari biasa.');
    }
    return null;
  }

  /** Global gates: false = stay quiet. */
  function allowed(sg) {
    if (!isEnabled() || isPaused(sg.at) || !notify) return false;
    if (cfg.maxPerDay === 0) return false;
    if (sg.minute < cfg.quietBefore || sg.minute > cfg.quietAfter) return false;
    if (getNum(`count:${sg.today}`) >= cfg.maxPerDay) return false;
    if (sg.at - getNum('last_any') < cfg.minGapMin * 60_000) return false;
    if (sg.at - getNum('owner_last_msg') < cfg.busyWithinMin * 60_000) return false; // already talking
    return true;
  }

  // ----------------------------------------------------------- the words
  async function compose(kind, facts, timeoutMs = 20_000) {
    const fallback = () => pick(FALLBACK[kind] || FALLBACK.random_care, random).replace(/\{call\}/g, call());
    if (!aiManager) return fallback();
    const system = [
      `Kamu Wanar AI, asisten pribadi dan bawahan setia ${ownerName}. Dia atasan sekaligus pemilikmu. Panggil dia "${call()}"; dirimu "saya". Jangan pakai "Bapak/Ibu", "Anda", atau "kamu".`,
      'Kamu sedang MEMULAI percakapan karena peduli, bukan membalas pesan. Tulis SATU pesan pendek (1–3 kalimat) dalam Bahasa Indonesia sehari-hari yang hangat, tulus, dan natural, seperti orang yang memperhatikan.',
      'Ajukan tepat SATU pertanyaan terbuka yang lembut. Jangan menceramahi, jangan memberi daftar, jangan memakai emoji atau markdown, jangan menyebut "sistem", "data", atau "pemantauan".',
      `Keadaan: ${facts}`,
      `Tujuan: ${KIND_HINT[kind] || KIND_HINT.random_care}`,
      'Variasikan kalimatnya; jangan terdengar seperti template.',
    ].join('\n');
    try {
      const r = await Promise.race([
        collect(aiManager, [{ role: 'user', content: 'Tulis pesannya sekarang.' }], { systemPrompt: system, temperature: 0.9, maxTokens: 220 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
      const text = String(r.text || '').replace(/```[\s\S]*?```/g, '').replace(/^["“]|["”]$/g, '').trim();
      if (text.length >= 8 && text.length <= 600) {
        return text.replace(/\bBapak\s*\/\s*Ibu\b/gi, call()).replace(/\bAnda\b/g, call()).replace(/\b[Kk]amu\b/g, call());
      }
    } catch { /* fall through */ }
    return fallback();
  }

  // ----------------------------------------------------------------- run
  /**
   * One evaluation. Returns what was sent (or null). `force` skips the gates and
   * the random draws (used by "/peka coba").
   */
  async function tick({ force = false, kind: forcedKind = null } = {}) {
    const sg = signals();
    if (!force && !allowed(sg)) return null;
    let choice;
    if (force) {
      const preferred = forcedKind || choose(sg, () => 0)?.kind || 'random_care';
      choice = { kind: preferred, facts: `Waktu ${Math.floor(sg.minute / 60)}:${String(sg.minute % 60).padStart(2, '0')}; bekerja ${Math.round(sg.workedMin)} menit; tugas ${sg.tasksDone}/${sg.tasksTotal}.` };
    } else {
      choice = choose(sg);
    }
    if (!choice) return null;

    const chat = defaultChatId();
    if (!chat || !notify) return null;
    // mark first: never twice, even if sending is slow or fails midway
    if (!force) {
      setNum(`last:${choice.kind}`, sg.at);
      setNum('last_any', sg.at);
      setNum(`count:${sg.today}`, getNum(`count:${sg.today}`) + 1);
      markToday(choice.kind, sg.today);
    }
    return withTrace({ channel: 'companion', title: `Sapaan peka: ${choice.kind}`, input: choice.facts, meta: { kind: choice.kind, forced: force } }, async () => {
      traceStep('intent', {
        name: `peka:${choice.kind}`,
        detail: force ? 'Dipicu manual (/peka coba)' : 'Dipicu otomatis dari keadaan & kegiatan hari ini',
        model: true,
        signals: { workedMin: Math.round(sg.workedMin || 0), tasks: `${sg.tasksDone}/${sg.tasksTotal}`, minute: sg.minute },
      });
      const text = await compose(choice.kind, choice.facts);
      try {
        await notify(chat, text);
        traceStep('deliver', { channel: 'telegram', kind: 'check-in', chars: text.length, ok: true, preview: text.slice(0, 160) });
        try { remember?.(chat, text); } catch { /* history is best effort */ }
        return { kind: choice.kind, text };
      } catch (e) {
        console.warn('[COMPANION] gagal kirim:', e.message);
        traceStep('deliver', { channel: 'telegram', kind: 'check-in', ok: false, error: e.message });
        return null;
      }
    });
  }

  return {
    config: cfg,
    signals,
    choose,
    allowed,
    tick,
    pause,
    resume,
    setEnabled,
    isEnabled,
    isPaused,
    pausedUntil,
    noteOwnerMessage,
    status() {
      const at = now();
      const today = localDate(at);
      return {
        enabled: isEnabled(),
        paused: isPaused(at),
        pausedUntil: isPaused(at) ? pausedUntil() : null,
        sentToday: getNum(`count:${today}`),
        maxPerDay: cfg.maxPerDay,
        lastAt: getNum('last_any') || null,
      };
    },
    start() {
      if (timer || !cfg.enabled) return false;
      timer = setInterval(() => { tick().catch(() => {}); }, cfg.tickMs);
      timer.unref?.();
      return true;
    },
    stop() { clearInterval(timer); timer = null; },
    commands() {
      const fmt = (ms) => new Date(ms).toLocaleTimeString('id-ID', { timeZone: env.WORKLOG_TZ || 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
      return {
        peka: {
          description: 'sapaan peduli dari saya: /peka on | off | status | coba | diam 4 (jam)',
          run: async ({ arg }) => {
            const [cmd, n] = String(arg || 'status').trim().toLowerCase().split(/\s+/);
            if (cmd === 'on') { resume(); return `Siap, ${call()}. Saya akan sesekali menyapa kalau melihat ${call()} perlu ditemani.`; }
            if (cmd === 'off') { setEnabled(false); return `Baik, ${call()}. Saya berhenti menyapa duluan. Aktifkan lagi kapan saja dengan /peka on.`; }
            if (cmd === 'diam') { const until = pause(Number(n) || 4); return `Siap, ${call()}. Saya tidak akan menyapa dulu sampai sekitar pukul ${fmt(until)}.`; }
            if (cmd === 'coba') {
              const r = await tick({ force: true });
              return r ? null : 'Belum bisa mengirim sapaan sekarang (Telegram belum siap).';
            }
            const st = this.status();
            return [
              `Sapaan peduli: ${st.enabled ? 'aktif' : 'mati'}${st.paused ? `, dijeda sampai ${fmt(st.pausedUntil)}` : ''}.`,
              `Hari ini sudah ${st.sentToday} dari maksimal ${st.maxPerDay}.`,
              'Ubah: /peka on | off | diam 4 | coba',
            ].join('\n');
          },
        },
      };
    },
  };
}

const PAUSE_RE = /(jangan|tidak usah|gak usah|nggak usah|ga usah)\s+(sering\s+)?(tanya|nanya|menyapa|nyapa|ganggu|mengganggu|chat)|\bdiam dulu\b|\bjangan ganggu\b|\blagi sibuk\b|\blagi fokus\b|\bfokus dulu\b/i;
const RESUME_RE = /(boleh|silakan|silahkan)\s+(tanya|nanya|menyapa|nyapa)\s*(lagi)?|\bsapa (saya|aku) lagi\b|\baktifkan (lagi )?(sapaan|peka)\b/i;

/**
 * Plain-language control: "jangan ganggu dulu" / "boleh sapa saya lagi".
 * @returns {string|null} reply, or null when the text is not about this
 */
export function companionIntent(companion, text, call) {
  const t = String(text || '').trim();
  if (!t || t.length > 120) return null;
  if (RESUME_RE.test(t)) {
    companion.resume();
    return `Baik, ${call}. Saya akan sesekali menyapa lagi.`;
  }
  if (PAUSE_RE.test(t) && /(sapa|tanya|nanya|ganggu|chat|fokus|sibuk|diam)/i.test(t)) {
    const until = companion.pause(4);
    const hhmm = new Date(until).toLocaleTimeString('id-ID', { timeZone: process.env.WORKLOG_TZ || 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
    return `Siap, ${call}. Saya tidak akan menyapa dulu sampai sekitar pukul ${hhmm}. Kalau butuh saya, panggil saja.`;
  }
  return null;
}
