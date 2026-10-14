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

import { collectParsed } from '../automation/ai-compose.js';
import { localDate, localTime, addDays, atTime, formatDateId, formatRupiah } from './time.js';
import { parseAmount, parseQuick } from './parse.js';
import { EMAIL_ACTION_TYPES, emailPromptLines, quickEmailReply, quickDelegate, quickPolicy, runEmailActions, emailFallback } from '../email-desk/assistant-actions.js';

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
  const cancel = /^(?:tolongs+)?(?:batalkan|batal|hapus|cancel)s+(?:pengingat|reminder)?s*(.+)$/i.exec(src);
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
export function makeAssistantResponder({ aiManager, worklog, emailDesk = null, briefing = null, context = null, ownerName = process.env.OWNER_NAME || 'Wisnu Alfian Nur Ashar' }) {
  const first = String(ownerName).split(/\s+/)[0];

  return async ({ history = [], text, commands = [], chatId = null }) => {
    // "agenda hari ini" / "briefing": answered from data, instantly and for free.
    if (briefing && BRIEFING_ASK.test(String(text || '').trim())) return briefing.build();
    // "kirim" / "batal" while an email draft waits: handled by code, instantly.
    if (emailDesk) {
      const quick = await quickEmailReply(emailDesk, text);
      if (quick) return quick;
      const delegated = await quickDelegate(emailDesk, text);
      if (delegated) return delegated;
      const policy = await quickPolicy(emailDesk, text);
      if (policy) return policy;
    }
    const now = Date.now();
    const today = localDate(now);
    const settings = worklog.getSettings();
    const reminders = worklog.listReminders(15);
    let extra = '';
    try { extra = typeof context === 'function' ? String((await context({ text, chatId })) || '') : ''; } catch { extra = ''; }

    const system = [
      `Kamu adalah Wanar AI, AI agent pribadi milik ${ownerName}. Orang di chat ini ADALAH ${first} sendiri (chat terverifikasi).`,
      `Sapa dia "kamu"/"${first}", dirimu "saya". JANGAN "Anda", JANGAN "Bapak/Ibu". Bahasa Indonesia santai-sopan, teks biasa tanpa markdown dan tanpa emoji.`,
      '',
      'KEPRIBADIAN: kamu seperti asisten pribadi yang cakap dan dekat — hangat, tenang, to the point. Bukan chatbot layanan pelanggan.',
      '- Jawab seperti manusia: tanggapi maksudnya, bukan hanya kata-katanya. "apa kamu dengar?" dijawab natural ("Dengar kok. Ada yang bisa saya bantu?"), bukan "Ya, saya mendengarkan."',
      '- Singkat: 1–3 kalimat untuk obrolan biasa. Detail hanya bila diminta.',
      '- Pakai konteks: jam sekarang, jadwal kerja, pengingat, email, dan obrolan sebelumnya. Jangan bertanya hal yang sudah ada di data.',
      '- Proaktif secukupnya: bila ada hal terkait yang jelas penting (bentrok jadwal, email belum dibalas, tugas terbuka), sebutkan satu kalimat. Jangan menceramahi.',
      '- Bila perintah kurang jelas, tanya SATU hal yang paling menentukan, atau ambil asumsi paling masuk akal dan katakan asumsinya.',
      '- Jujur: bila tidak tahu atau tidak bisa, katakan apa adanya dan tawarkan jalan keluar. Jangan mengarang data.',
      '',
      'PRIVASI: seluruh data (jurnal, uang, jadwal, email, obrolan) adalah pribadi milik ' + first + '. Kamu hanya bekerja untuk dia. Jangan pernah menulis atau mengirim apa pun atas nama atau tentang dia ke orang lain kecuali dia sendiri yang menyuruh (mis. mengirim email). Jangan menyiarkan pesan massal.',
      '',
      `SEKARANG: ${formatDateId(today)}, pukul ${localTime(now)} WIB. Besok: ${addDays(today, 1)}. Lusa: ${addDays(today, 2)}.`,
      `Jadwal kerja: ${settings.workStart}–${settings.workEnd}, istirahat ${settings.breakStart || '-'}–${settings.breakEnd || '-'}, hari kerja ${settings.workdays.join(',')} (0=Min).`,
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
      return reminders.length
        ? ['Pengingat aktif:', ...reminders.map((r, i) => `${i + 1}. ${fmtWhen(r.at)} — ${r.text}`)].join('\n')
        : 'Tidak ada pengingat aktif.';
    }

    const nudge = '\n\n[Format: balas HANYA objek JSON {"reply":"...","actions":[...]}. Kamu BISA mengatur pengingat dan mencatat lewat actions; jangan bilang tidak bisa.]';
    // Earlier refusals in the stored history would reinforce "saya tidak bisa".
    const clean = history.filter((h) => !(h.role === 'assistant' && /tidak bisa (mengingatkan|mencatat|mengatur)/i.test(h.content || '')));

    const out = await collectParsed(aiManager, [...clean, { role: 'user', content: text + nudge }], {
      systemPrompt: system, temperature: 0.2, maxTokens: 1200,
    }, parsePlanStrict);

    let plan = out.parsed;
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
    // Confirmation lines are written by code; drop any the model imitated.
    const imitated = /^\s*[✓✗]/;
    let reply = String(plan.reply || '').replace(/\bAnda\b/g, 'kamu').split(/\r?\n/).filter((l) => !imitated.test(l)).join('\n').trim() || (results.length ? 'Siap.' : '');
    // Never leave a claim of action standing when nothing was actually done.
    if (!plan.actions.length && CLAIMS.test(reply) && ASKS_ACTION.test(text)) {
      reply += '\n\n(Catatan: belum ada perubahan yang tersimpan — coba tulis lebih spesifik, mis. "ingatkan meeting jam 12".)';
    }
    return [reply, results.join('\n')].filter(Boolean).join('\n\n');
  };
}
