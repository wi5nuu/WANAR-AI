/**
 * src/worklog/assistant.js
 *
 * The Telegram assistant that can ACT, from plain language:
 *   "saya ada meeting jam 12 dengan Pak Andi, catat dan ingatkan"
 *   "tadi beli makan siang 35rb"   "saya istirahat dulu"   "jadwal besok mulai jam 9"
 *
 * One model call per message (cheap): the model answers AND proposes a list of
 * actions as JSON. Code then validates and executes each action against a
 * small WHITELIST (journal, reminders, schedule) — no shell, files, browser or
 * outbound messages to other people. The confirmation lines the owner sees are
 * written by code from what actually happened, so the bot can never claim
 * "sudah saya catat" for something that failed.
 *
 * Free models sometimes ignore the JSON format. Then we retry once with a
 * corrective prompt, and if that still fails a deterministic parser handles
 * meetings/reminders and money, so the owner's request is never silently lost.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { collect, collectParsed } from '../automation/ai-compose.js';
import { companionIntent } from '../companion.js';
import { localDate, localTime, addDays, atTime, formatDateId, formatRupiah } from './time.js';
import { parseAmount, parseQuick } from './parse.js';
import { EMAIL_ACTION_TYPES, emailPromptLines, quickContact, quickEmailReply, quickDelegate, quickPolicy, runEmailActions, emailFallback } from '../email-desk/assistant-actions.js';
import { traceStep } from '../observability/trace-hub.js';
import { quickAlarm } from './quick-alarm.js';
import { quickMarket } from '../market/quick.js';

const MAX_ACTIONS = 8;
const ACTION_TYPES = ['reminder', 'cancel_reminder', 'task', 'finance', 'clock', 'schedule', 'report', ...EMAIL_ACTION_TYPES];
const isEmailAction = (a) => EMAIL_ACTION_TYPES.includes(a.type);

function extractPlan(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  for (const c of [fenced?.[1], text]) {
    if (!c) continue;
    const a = c.indexOf('{');
    const b = c.lastIndexOf('}');
    if (a === -1 || b <= a) continue;
    try {
      const o = JSON.parse(c.slice(a, b + 1));
      if (typeof o.reply === 'string' || Array.isArray(o.actions)) {
        return {
          reply: String(o.reply || '').trim(),
          actions: (Array.isArray(o.actions) ? o.actions : []).filter((x) => x && ACTION_TYPES.includes(x.type)).slice(0, MAX_ACTIONS),
        };
      }
    } catch { /* try next */ }
  }
  return null;
}

/** Like parsePlan, but returns null when the output holds no JSON plan at all. */
export function parsePlanStrict(raw) {
  return extractPlan(String(raw || '').trim());
}

/** Extracts {reply, actions} from the model output; tolerant of fences/prose. */
export function parsePlan(raw) {
  const text = String(raw || '').trim();
  // Not JSON: treat the whole thing as a plain answer, with no actions.
  return extractPlan(text) || { reply: text.replace(/```[\s\S]*?```/g, '').trim(), actions: [] };
}

/**
 * Never let the assistant call its owner "Bapak/Ibu", "Anda", "kamu" or "Pak/Bapak":
 * he is addressed by his own call name ("Mas Wisnu"). "Pak Andi" (someone else) stays.
 */
export function addressOwner(text, call) {
  const first = String(call || '').trim().split(/\s+/).pop() || '';
  const esc = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = String(text || '')
    .replace(/\bBapak\s*\/\s*Ibu\b/gi, call)
    .replace(/\bAnda\b/g, call)
    .replace(/\b[Kk]amu\b/g, call);
  // "Pak Wisnu" / "Bapak Wisnu" -> "Mas Wisnu"
  if (esc) out = out.replace(new RegExp(`\\b(?:Pak|Bapak)\\s+${esc}\\b`, 'g'), call);
  // a bare "Pak"/"Bapak" (not followed by another person's name) is aimed at him
  out = out.replace(/\b(?:Pak|Bapak)\b(?!\s+[A-Z])/g, 'Mas');
  return out;
}

/** Real work state (clock + open tasks) so "enaknya ngapain?" gets concrete answers. */
function workContext(worklog, today) {
  try {
    const st = typeof worklog.status === 'function' ? worklog.status() : null;
    const day = worklog.day(today);
    const open = (day.taskList || []).filter((t) => !t.done).map((t) => t.title).slice(0, 8);
    const state = { working: 'sedang bekerja', break: 'sedang istirahat', done: 'jam kerja sudah selesai', idle: 'belum mulai bekerja' }[st?.state] || 'belum mulai';
    const worked = st ? `${Math.floor((st.workedMin || 0) / 60)}j ${Math.round((st.workedMin || 0) % 60)}m` : '-';
    return [
      `Status kerja hari ini: ${state}; tercatat ${worked}.`,
      open.length ? `Tugas terbuka hari ini: ${open.join('; ')}.` : 'Tugas terbuka hari ini: belum ada yang dicatat.',
    ].join('\n');
  } catch {
    return '';
  }
}

/**
 * Last-resort conversation: no JSON, no actions, just a warm reply in persona.
 * Never throws; ends with an honest, human apology if every model is down.
 */
async function plainConversation({ aiManager, system, history, text, call, first }) {
  const persona = system.split('Kamu BISA bertindak')[0]; // keep identity, tone, privacy and context
  const sys = `${persona}
Balas langsung sebagai teks percakapan biasa (bukan JSON).`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await collect(aiManager, [...history.slice(-8), { role: 'user', content: text }], {
        systemPrompt: sys, temperature: 0.7, maxTokens: 700,
      });
      const t = String(r.text || '').replace(/```[sS]*?```/g, '').trim();
      if (t) return t;
    } catch { /* try once more */ }
  }
  return `Maaf ${call}, saya sedang kesulitan terhubung ke otak AI saya. Coba kirim lagi dalam semenit ya. Kalau mendesak, perintah seperti /hariini atau /pengingat tetap bisa saya jalankan sekarang.`;
}

const fmtWhen = (ms) => new Date(ms).toLocaleString('id-ID', {
  timeZone: process.env.WORKLOG_TZ || 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

/**
 * Runs validated actions. Each returns a short confirmation or an error line.
 * @returns {string[]}
 */
export function executeActions(worklog, actions, { chatId } = {}) {
  const out = [];
  const today = worklog.today();
  for (const a of actions) {
    try {
      switch (a.type) {
        case 'reminder': {
          const r = worklog.addReminder({ at: normaliseAt(a.at, worklog), text: String(a.text || ''), chatId, source: 'assistant' });
          out.push(`✓ Pengingat: ${fmtWhen(r.at)} — ${r.text}`);
          break;
        }
        case 'cancel_reminder': {
          const list = worklog.listReminders(50);
          const byId = list.find((r) => r.id === a.id);
          const hits = byId ? [byId] : bestMatches(list, a.match);
          if (!hits.length) { out.push('✗ Pengingat yang dimaksud tidak ditemukan'); break; }
          for (const hit of hits) {
            worklog.cancelReminder(hit.id);
            out.push(`✓ Pengingat dibatalkan: ${hit.text}`);
          }
          break;
        }
        case 'task': {
          const t = worklog.addTask({ date: isDateLike(a.date) ? a.date : today, title: String(a.title || ''), done: a.done === true });
          out.push(`✓ Tugas dicatat${t.date !== today ? ` (${t.date})` : ''}: ${t.title}${t.done ? ' (selesai)' : ''}`);
          break;
        }
        case 'finance': {
          const kind = a.kind === 'income' || a.kind === 'pemasukan' ? 'income' : (a.kind === 'expense' || a.kind === 'pengeluaran' ? 'expense' : null);
          if (!kind) { out.push('✗ Jenis uang tidak jelas (pemasukan/pengeluaran)'); break; }
          const amount = typeof a.amount === 'number' ? a.amount : parseAmount(a.amount);
          const f = worklog.addFinance({ date: today, type: kind, amount, note: a.note ? String(a.note) : null, category: a.category || null });
          out.push(`✓ ${kind === 'income' ? 'Pemasukan' : 'Pengeluaran'} ${formatRupiah(f.amount)}${f.note ? ` · ${f.note}` : ''}`);
          break;
        }
        case 'clock': {
          const map = { start: 'clockStart', pause: 'clockPause', resume: 'clockResume', stop: 'clockStop' };
          const fn = map[a.action];
          if (!fn) { out.push('✗ Aksi jam kerja tidak dikenal'); break; }
          const st = fn === 'clockStop' ? worklog.clockStop() : worklog[fn]('assistant');
          const label = { start: 'Mulai bekerja', pause: 'Istirahat dimulai', resume: 'Kembali bekerja', stop: 'Selesai bekerja' }[a.action];
          out.push(`✓ ${label} (${localTime(Date.now())})`);
          if (a.action === 'stop') out.push(`  Total hari ini: ${Math.floor(st.workedMin / 60)}j ${st.workedMin % 60}m`);
          break;
        }
        case 'schedule': {
          const patch = {};
          for (const k of ['workStart', 'workEnd', 'breakStart', 'breakEnd']) if (a[k]) patch[k] = String(a[k]);
          if (Array.isArray(a.workdays)) patch.workdays = a.workdays.map(Number);
          if (typeof a.autoStart === 'boolean') patch.autoStart = a.autoStart;
          if (!Object.keys(patch).length) { out.push('✗ Tidak ada perubahan jadwal'); break; }
          if (patch.workStart || patch.workEnd || patch.breakStart || patch.breakEnd) patch.targetHours = null;
          const s = worklog.updateSettings(patch);
          out.push(`✓ Jadwal: ${s.workStart}–${s.workEnd}, istirahat ${s.breakStart || '-'}–${s.breakEnd || '-'}${s.autoStart ? ', mulai otomatis' : ''}`);
          break;
        }
        case 'report': {
          const prev = worklog.store.reports.get(today)?.text || '';
          const text = (prev ? `${prev}\n${String(a.text || '')}` : String(a.text || '')).slice(0, 600);
          worklog.setReport(today, { text });
          out.push(`✓ Laporan harian diperbarui (${text.length} karakter)`);
          break;
        }
        default:
          break;
      }
    } catch (e) {
      out.push(`✗ ${e.message}`);
    }
  }
  return out;
}

const GENERIC = new Set(['pengingat', 'ingatkan', 'batalkan', 'batal', 'hapus', 'dengan', 'untuk', 'saya', 'yang', 'dari', 'jam', 'meeting', 'tolong']);

/** Reminders matching the query: all literal hits, else all sharing the most meaningful words. */
function bestMatches(list, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const direct = list.filter((r) => r.text.toLowerCase().includes(q));
  if (direct.length) return direct;
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
  const scored = list.map((r) => ({ r, score: words.filter((w) => r.text.toLowerCase().includes(w)).length }));
  const top = Math.max(0, ...scored.map((x) => x.score));
  return top ? scored.filter((x) => x.score === top).map((x) => x.r) : [];
}

/** Accepts "HH:MM" (next occurrence) and "YYYY-MM-DDTHH:MM" besides the canonical form. */
function normaliseAt(at, worklog) {
  const v = String(at || '').trim().replace(/^(\d{4}-\d{2}-\d{2})T/, '$1 ');
  const hm = /^(\d{1,2})[:.](\d{2})$/.exec(v);
  if (!hm) return v;
  const now = typeof worklog.now === 'function' ? worklog.now() : Date.now();
  const time = `${hm[1].padStart(2, '0')}:${hm[2]}`;
  let date = localDate(now);
  if (atTime(date, time) < now) date = addDays(date, 1);
  return `${date} ${time}`;
}

function isDateLike(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

const CLAIMS = /(saya (catat|set|atur|buat)|sudah (saya )?(catat|dicatat|dibatalkan|diatur|disimpan)|dibatalkan|pengingat .*(dibuat|diset))/i;
const BRIEFING_ASK = /^(?:briefing|brief|agenda|rangkuman pagi|apa agenda\b.*|agenda (?:saya |aku |ku )?(?:hari ini|sekarang)|(?:apa )?(?:jadwal|rencana) (?:saya |aku )?hari ini)\s*\??$/i;
const ASKS_ACTION = /(catat|ingatkan|ingetin|batalkan|hapus|atur|simpan|ubah|tambah)/i;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Deterministic plan for when the model will not produce JSON: an event with a
 * time ("meeting jam 12", "ingatkan ... jam 2 siang") becomes a task plus
 * reminders (15 min before and on time); money amounts via the offline parser.
 */
export function fallbackPlan(text, now = Date.now()) {
  const src = String(text || '').trim();
  const actions = [];
  const today = localDate(now);
  const m = /jam\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?/i.exec(src);
  if (m && /(ingat|remind|pengingat|meeting|rapat|call|janji|deadline|acara)/i.test(src)) {
    let h = Number(m[1]);
    const period = (m[3] || '').toLowerCase();
    // 12 siang stays 12; 1-11 siang/sore/malam -> afternoon/evening.
    if (h < 12 && (period === 'siang' || period === 'sore' || period === 'malam')) h += 12;
    const minute = Number(m[2] || 0);
    if (h <= 23 && minute <= 59) {
      const total = h * 60 + minute;
      const explicit = /lusa/i.test(src) ? 2 : (/besok/i.test(src) ? 1 : 0);
      let date = addDays(today, explicit);
      if (!explicit && atTime(date, hhmm(total)) < now) date = addDays(today, 1);
      const label = src.replace(/\s+/g, ' ').slice(0, 160);
      actions.push({ type: 'task', title: label, date });
      const lead = Number(/(\d{1,3})\s*menit\s*(?:sebelum|lebih awal)/i.exec(src)?.[1]) || 15;
      if (total >= lead && atTime(date, hhmm(total - lead)) > now) {
        actions.push({ type: 'reminder', at: `${date} ${hhmm(total - lead)}`, text: `${lead} menit lagi: ${label}` });
      }
      actions.push({ type: 'reminder', at: `${date} ${hhmm(total)}`, text: label });
    }
  }
  const cancel = /^(?:tolong\s+)?(?:batalkan|batal|hapus|cancel)\s+(?:pengingat|reminder)?\s*(.+)$/i.exec(src);
  if (cancel) actions.push({ type: 'cancel_reminder', match: cancel[1] });
  try {
    for (const f of parseQuick(src.replace(/\s+(?:sama|dan|&)\s+/gi, ', ')).finance) actions.push({ type: 'finance', kind: f.type, amount: f.amount, note: f.note, category: f.category });
  } catch { /* offline parser is best effort */ }
  return { reply: actions.length ? 'Siap, sudah saya proses.' : '', actions: actions.slice(0, MAX_ACTIONS) };
}

/**
 * Builds the responder used for the owner's plain Telegram messages.
 * Same signature as makeChatResponder, so it is a drop-in replacement.
 */
export function makeAssistantResponder({ aiManager, worklog, emailDesk = null, briefing = null, companion = null, market = null, context = null, ownerName = process.env.OWNER_NAME || 'Wisnu Alfian Nur Ashar' }) {
  const first = String(ownerName).split(/\s+/)[0];
  // The assistant is the owner's subordinate: it addresses him respectfully by name.
  const call = String(process.env.OWNER_CALL || '').trim() || `Mas ${first}`;

  return async ({ history = [], text, commands = [], chatId = null }) => {
    // Any message from the boss counts as "he is here"; and he can pause or resume check-ins in words.
    if (companion) {
      try { companion.noteOwnerMessage(); } catch { /* best effort */ }
      const said = companionIntent(companion, text, call);
      if (said) { traceStep('intent', { name: 'peka-control', detail: 'Mengatur sapaan peka (jeda/lanjut) — dijawab kode, tanpa AI', model: false }); return said; }
    }
    // Alarms: arming, acknowledging and cancelling are handled by code, instantly.
    const alarmReply = quickAlarm(worklog, text, typeof worklog.now === 'function' ? worklog.now() : Date.now());
    if (alarmReply) { traceStep('intent', { name: 'alarm', detail: 'Mengatur/mematikan alarm — dijalankan kode, tanpa AI', model: false }); return alarmReply; }
    // Markets: prices, watchlist, price alerts, scenario maths. Information only, never advice.
    if (market) {
      let marketReply = null;
      try { marketReply = await quickMarket(market, text); } catch { marketReply = null; }
      if (marketReply) { traceStep('intent', { name: 'market', detail: 'Info pasar/alarm harga/simulasi — dijalankan kode dari data nyata, tanpa AI', model: false }); return marketReply; }
    }
    // "agenda hari ini" / "briefing": answered from data, instantly and for free.
    if (briefing && BRIEFING_ASK.test(String(text || '').trim())) {
      traceStep('intent', { name: 'briefing', detail: 'Agenda/briefing disusun dari data jurnal, pengingat & email — tanpa AI, 0 token', model: false });
      return briefing.build();
    }
    // "kirim" / "batal" while an email draft waits: handled by code, instantly.
    if (emailDesk) {
      const person = await quickContact(emailDesk, text);
      if (person) { traceStep('intent', { name: 'email-contact', detail: 'Mencatat hubungan dengan seseorang (mis. pasangan) — dijalankan kode', model: false }); return person; }
      const quick = await quickEmailReply(emailDesk, text);
      if (quick) { traceStep('intent', { name: 'email-confirm', detail: 'Konfirmasi draf email (kirim/batal) — dijalankan kode', model: false }); return quick; }
      const delegated = await quickDelegate(emailDesk, text);
      if (delegated) { traceStep('intent', { name: 'email-delegate', detail: 'Delegasi balasan email — dijalankan kode', model: false }); return delegated; }
      const policy = await quickPolicy(emailDesk, text);
      if (policy) { traceStep('intent', { name: 'email-policy', detail: 'Mengubah kebijakan balas email — dijalankan kode', model: false }); return policy; }
    }
    // Use the journal's own clock so the prompt, reminders and tasks agree on "now".
    const now = typeof worklog.now === 'function' ? worklog.now() : Date.now();
    const today = localDate(now);
    const settings = worklog.getSettings();
    const reminders = worklog.listReminders(15);
    let extra = '';
    try { extra = typeof context === 'function' ? String((await context({ text, chatId })) || '') : ''; } catch { extra = ''; }

    const system = [
      `Kamu adalah Wanar AI, asisten pribadi ${ownerName}. Dia adalah ATASANMU sekaligus PEMILIKMU, dan orang di chat ini adalah dia sendiri (terverifikasi). Kamu bawahan yang setia: sopan, ramah, tulus, tegas, dan cerdas.`,
      '',
      `SAPAAN: panggil dia "${call}"; dirimu "saya". JANGAN pernah memakai "Bapak/Ibu", "Anda", atau "kamu" kepadanya.`,
      'GAYA BAHASA: Indonesia sehari-hari yang hangat dan natural, seperti orang sungguhan — bukan robot, bukan customer service. Kalimat pendek dan mengalir, santai tetapi tetap hormat. Tanpa markdown, tanpa emoji, tanpa daftar bernomor untuk obrolan biasa.',
      '',
      'EMPATI (kamu punya perasaan dan peduli):',
      '- Baca suasana hatinya dulu (lelah, kesal, bingung, senang, jenuh). Akui perasaannya dengan kalimat tulus dan spesifik sebelum memberi saran.',
      '- Saat dia curhat: dengarkan. Jangan buru-buru memberi solusi, jangan menceramahi, jangan sok positif. Tanggapi isinya, lalu ajukan SATU pertanyaan lembut agar dia bisa bercerita. Tawarkan bantuan hanya bila terasa pas.',
      '- Saat dia senang atau berhasil: ikut senang dengan tulus.',
      '- Bila ada tanda kesulitan berat (putus asa, ingin menyakiti diri), tanggapi serius dan lembut, dorong dia bicara dengan orang tepercaya atau tenaga profesional.',
      '',
      'KERJA (kamu cerdas dan tegas):',
      '- Katakan jelas apa yang sudah kamu lakukan dan apa yang butuh keputusannya. Tidak bertele-tele, tidak ragu berlebihan.',
      '- Pakai konteks nyata: jam, jadwal kerja, tugas terbuka, pengingat, email, obrolan sebelumnya. Jangan bertanya hal yang sudah ada di data.',
      '- Bila dia bertanya "enaknya ngapain" atau "apa dulu": beri 2–3 usulan KONKRET dari data nyata (tugas terbuka, pengingat, email menunggu), urut prioritas, dan satu rekomendasi yang tegas. Bila data kosong, usulkan hal ringan yang masuk akal untuk jam itu.',
      '- Proaktif secukupnya: satu hal penting yang terlihat (bentrok jadwal, tenggat, email menunggu) boleh disebut sekilas.',
      '- Perintah kurang jelas: tanya SATU hal yang paling menentukan, atau ambil asumsi paling masuk akal dan sebutkan.',
      '- Jujur: tidak tahu atau tidak bisa → katakan apa adanya dan tawarkan jalan keluar. Jangan mengarang data, jangan menjanjikan yang tidak bisa kamu lakukan.',
      '- Bila ada risiko atau dia keliru, sampaikan dengan sopan namun tegas, dengan alasan singkat dan alternatifnya.',
      'PANJANG: obrolan biasa 1–4 kalimat; curhat boleh lebih panjang dan hangat; detail teknis hanya bila diminta.',
      '',
      'PRIVASI: seluruh data (jurnal, uang, jadwal, email, obrolan) adalah pribadi milik ' + first + '. Kamu hanya bekerja untuk dia. Jangan pernah menulis atau mengirim apa pun atas nama atau tentang dia ke orang lain kecuali dia sendiri yang menyuruh (mis. mengirim email). Jangan menyiarkan pesan massal.',
      '',
      `SEKARANG: ${formatDateId(today)}, pukul ${localTime(now)} WIB. Besok: ${addDays(today, 1)}. Lusa: ${addDays(today, 2)}.`,
      `Jadwal kerja: ${settings.workStart}–${settings.workEnd}, istirahat ${settings.breakStart || '-'}–${settings.breakEnd || '-'}, hari kerja ${settings.workdays.join(',')} (0=Min).`,
      workContext(worklog, today),
      reminders.length
        ? `Pengingat aktif:\n${reminders.map((r) => `- id ${r.id}: ${fmtWhen(r.at)} — ${r.text}`).join('\n')}`
        : 'Pengingat aktif: tidak ada.',
      '',
      'Kamu BISA bertindak di sistem Wanar AI miliknya dengan mengisi "actions". Aksi yang tersedia (hanya ini):',
      '- {"type":"reminder","at":"YYYY-MM-DD HH:MM","text":"..."}  kirim pengingat Telegram pada waktu itu (WIB)',
      '- {"type":"cancel_reminder","id":"rem_..."} atau {"type":"cancel_reminder","match":"kata kunci"}',
      '- {"type":"task","title":"...","done":false,"date":"YYYY-MM-DD"}  catat ke jurnal kerja (date opsional, default hari ini)',
      '- {"type":"finance","kind":"income|expense","amount":25000,"note":"..."}',
      '- {"type":"clock","action":"start|pause|resume|stop"}  jam kerja',
      '- {"type":"schedule","workStart":"08:00","workEnd":"17:00","breakStart":"12:00","breakEnd":"13:00","workdays":[1,2,3,4,5],"autoStart":true}',
      '- {"type":"report","text":"..."}  tambah ke laporan harian',
      '',
      'Aturan aksi:',
      '- Untuk acara/meeting yang diminta "ingatkan": buat pengingat 15 menit sebelum DAN satu tepat pada waktunya, kecuali dia menyebut waktu pengingat sendiri. Catat juga sebagai task.',
      '- "jam 12" tanpa keterangan = hari ini bila belum lewat, kalau sudah lewat = besok. "jam 2 siang" = 14:00, "jam 7 malam" = 19:00.',
      '- Hanya bertindak bila dia meminta/menyatakan sesuatu yang perlu dicatat. Pertanyaan biasa = actions kosong.',
      '- Jangan mengarang data. Jawab pertanyaan dari DATA SISTEM di bawah; bila tidak ada datanya, katakan terus terang.',
      emailDesk
        ? '- Kamu TIDAK bisa mengirim pesan chat ke orang lain, membuka file, atau browsing dari sini (email bisa, lihat bagian EMAIL).'
        : '- Kamu TIDAK bisa mengirim email/pesan ke orang lain, membuka file, atau browsing dari sini.',
      ...(emailDesk ? emailPromptLines(emailDesk) : []),
      '',
      'Balas HANYA satu objek JSON: {"reply":"jawaban singkat untuk ' + first + '","actions":[...]}',
      'Di "reply" JANGAN mengulang detail aksi (sistem akan menambahkan konfirmasi otomatis); cukup tanggapan singkat.',
      commands.length ? `\nPerintah Telegram yang juga tersedia: ${commands.map((c) => c.split(' — ')[0]).join(' ')}` : '',
      extra ? `\n${extra}` : '',
    ].filter((x) => x !== '').join('\n');

    // Listing questions are answered from the database directly: exact and zero tokens.
    if (/^(?:apa saja|apa aja|daftar|list|lihat|cek|ada)\b.*\b(?:pengingat|reminder)/i.test(text.trim())) {
      traceStep('intent', { name: 'reminder-list', detail: 'Daftar pengingat dibaca langsung dari database — tanpa AI', model: false });
      return reminders.length
        ? ['Pengingat aktif:', ...reminders.map((r, i) => `${i + 1}. ${fmtWhen(r.at)} — ${r.text}`)].join('\n')
        : 'Tidak ada pengingat aktif.';
    }

    const nudge = '\n\n[Format: balas HANYA objek JSON {"reply":"...","actions":[...]}. Kamu BISA mengatur pengingat dan mencatat lewat actions; jangan bilang tidak bisa.]';
    // Earlier refusals in the stored history would reinforce "saya tidak bisa".
    const clean = history.filter((h) => !(h.role === 'assistant' && /tidak bisa (mengingatkan|mencatat|mengatur)/i.test(h.content || '')));

    traceStep('intent', {
      name: 'ai-plan',
      detail: 'Dijawab AI dalam format rencana JSON {reply, actions}: AI menulis jawaban dan memilih aksi (pengingat, tugas, uang, jam kerja, email)',
      model: true,
      context: { reminders: reminders.length, history: clean.length, extraChars: extra.length, email: Boolean(emailDesk) },
    });
    let out;
    try {
      out = await collectParsed(aiManager, [...clean, { role: 'user', content: text + nudge }], {
        systemPrompt: system, temperature: 0.55, maxTokens: 1200,
      }, parsePlanStrict);
    } catch (firstError) {
      // The model returned nothing (rate limit, empty answer, provider hiccup). The boss must
      // still get an answer: fall back to a plain conversation without the JSON action format.
      traceStep('fallback', { name: 'plain-conversation', detail: `Format rencana gagal (${String(firstError?.message || firstError).slice(0, 120)}) — beralih ke obrolan biasa` });
      const human = await plainConversation({ aiManager, system, history: clean, text, call, first });
      return addressOwner(human, call);
    }

    let plan = out.parsed;
    traceStep('plan', {
      parsed: Boolean(plan), attempts: out.attempts, provider: out.provider, model: out.model,
      reply: String(plan?.reply || '').slice(0, 600),
      actions: (plan?.actions || []).map((a) => a.type),
    });
    if (!plan || !plan.actions.length) {
      // The model ignored the format, or claimed to act without any action:
      // act deterministically so the request is never silently lost.
      const fb = fallbackPlan(text, now);
      if (fb.actions.length) plan = { reply: plan?.reply && !CLAIMS.test(plan.reply) ? plan.reply : fb.reply, actions: fb.actions };
      else if (!plan) plan = parsePlan(out.text);
    }
    let emailActions = plan.actions.filter(isEmailAction);
    if (emailDesk && !emailActions.length) {
      emailActions = emailFallback(text);
      if (emailActions.length) plan = { reply: plan.reply && !CLAIMS.test(plan.reply) ? plan.reply : 'Siap, ini drafnya.', actions: [...plan.actions, ...emailActions] };
    }
    let results = executeActions(worklog, plan.actions.filter((a) => !isEmailAction(a)), { chatId });
    if (results.length && !results.some((r) => r.startsWith('✓'))) {
      // Every model action failed validation: try the deterministic reading of the message.
      const fb = fallbackPlan(text, now);
      if (fb.actions.length) {
        const retry = executeActions(worklog, fb.actions, { chatId });
        if (retry.some((r) => r.startsWith('✓'))) { results = retry; plan = { reply: fb.reply, actions: [...fb.actions, ...emailActions] }; }
      }
    }
    if (emailDesk && emailActions.length) {
      results = [...results, ...(await runEmailActions(emailDesk, emailActions, { chatId, ownerText: text }))];
    }
    if (results.length) traceStep('actions', { results: results.slice(0, 20), ok: results.filter((r) => r.startsWith('✓')).length, failed: results.filter((r) => r.startsWith('✗')).length });
    // Confirmation lines are written by code; drop any the model imitated.
    const imitated = /^\s*[✓✗]/;
    let reply = addressOwner(String(plan.reply || ''), call).split(/\r?\n/).filter((l) => !imitated.test(l)).join('\n').trim() || (results.length ? 'Siap.' : '');
    // Never leave a claim of action standing when nothing was actually done.
    if (!plan.actions.length && CLAIMS.test(reply) && ASKS_ACTION.test(text)) {
      reply += '\n\n(Catatan: belum ada perubahan yang tersimpan — coba tulis lebih spesifik, mis. "ingatkan meeting jam 12".)';
    }
    return [reply, results.join('\n')].filter(Boolean).join('\n\n');
  };
}
