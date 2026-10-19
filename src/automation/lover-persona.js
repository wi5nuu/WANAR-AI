/**
 * src/automation/lover-persona.js
 *
 * "Persona pasangan": chat tertentu (TELEGRAM_LOVER_CHAT_IDS) dijawab AI
 * sebagai Wisnu untuk kekasihnya — hangat, perhatian, romantis — dan sadar
 * status sibuk/luang yang diatur pemilik.
 *
 * Batasnya tetap sama seperti tamu: TIDAK ada akses data pribadi, perintah
 * pemilik, konteks pemilik, atau mesin darurat. Yang disuntikkan hanya status
 * hari ini dan catatan yang memang diberikan pemilik untuk dibicarakan.
 *
 * Perintah pemilik (hanya dari chat pemilik):
 *   /sibuk [catatan]   status hari ini: sibuk (kedaluwarsa tengah malam WIB)
 *   /luang             status hari ini: luang
 *   /status            lihat status + pertanyaan yang menunggu jawaban
 *   /jawab <jawaban>   jawab pertanyaan AI, lalu AI membalas pasangan
 *
 * "Tanya dulu" ke pemilik: kalau AI butuh informasi yang hanya Wisnu tahu dan
 * tidak ada di riwayat/status, ia membalas HANYA dengan marker
 *   [[TANYA_OWNER: pertanyaan singkat]]
 * Modul ini mengirim pertanyaannya ke chat pemilik, menahan balasan ke
 * pasangan, lalu menyusun balasan final dari jawaban /jawab pemilik.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { collect } from './ai-compose.js';

const PENDING_TTL_MS = 2 * 60 * 60_000; // pertanyaan menunggu maksimal 2 jam
const TZ = 'Asia/Jakarta';
const DEFAULT_HOLD = 'Sebentar ya sayang, aku cek dulu ya 😊';
const DEFAULT_ASK_FAIL = 'Sayang, aku belum bisa memastikan sekarang. Nanti aku kabari ya.';
const DEFAULT_SETTINGS = { status: 'unknown', note: '', updatedAt: 0, pending: null };

/** "2026-10-19T00:00:00+07:00" for the WIB day containing `ts`. */
function startOfDayWib(ts) {
  const day = new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
  const ms = Date.parse(`${day}T00:00:00+07:00`);
  return Number.isFinite(ms) ? ms : ts - 86_400_000;
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function createLoverPersona({
  db,
  aiManager,
  env = process.env,
  ownerName = env.OWNER_NAME || 'Wisnu Alfian Nur Ashar',
  partnerName = env.LOVER_NAME || 'Zahra',
  notifyOwner = null,
  sendToPartner = null,
  loadHistory = null,
  now = () => Date.now(),
}) {
  if (!db) throw new Error('createLoverPersona: `db` is required');
  if (!aiManager) throw new Error('createLoverPersona: `aiManager` is required');

  const first = String(ownerName).split(/\s+/)[0] || ownerName;
  const call = String(env.OWNER_CALL || '').trim() || `Mas ${first}`;
  const enabled = Boolean(String(env.TELEGRAM_LOVER_CHAT_IDS || '').trim());
  const holdText = String(env.LOVER_HOLD_TEXT || '').trim() || DEFAULT_HOLD;
  const askFailText = String(env.LOVER_ASK_FAIL_TEXT || '').trim() || DEFAULT_ASK_FAIL;

  db.exec(`
    CREATE TABLE IF NOT EXISTS lover_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const parse = (raw, fallback) => {
    try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  };

  /** Settings with the daily expiry applied (busy/free resets at midnight WIB). */
  function read() {
    const row = db.prepare('SELECT data FROM lover_settings WHERE id = 1').get();
    const s = { ...DEFAULT_SETTINGS, ...parse(row?.data, {}) };
    if (s.status !== 'unknown' && (!s.updatedAt || s.updatedAt < startOfDayWib(now()))) {
      return { ...s, status: 'unknown', note: '' };
    }
    return s;
  }

  function write(patch) {
    const merged = { ...read(), ...patch };
    db.prepare(`INSERT INTO lover_settings (id, data, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .run(JSON.stringify(merged), now());
    return merged;
  }

  const pendingActive = (p) => Boolean(p && p.chatId && p.at && now() - Number(p.at) < PENDING_TTL_MS);

  function statusLabel(s) {
    if (s.status === 'sibuk') return `SIBUK${s.note ? ` — catatan: ${s.note}` : ''}`;
    if (s.status === 'luang') return 'LUANG (tidak sedang sibuk)';
    return 'TIDAK DIKETAHUI';
  }

  /** System prompt for the lover persona. Deliberately carries no owner data. */
  function personaPrompt(s, { commands = [] } = {}) {
    const parts = [
      `Kamu adalah Wanar AI, AI pribadi milik ${ownerName}. Di chat ini kamu membalas ${partnerName}, kekasih ${first}, ATAS NAMA ${first} sebagai representasi digitalnya.`,
      `Bicaralah sebagai ${first}: pakai "aku", panggil ${partnerName} "sayang" atau namanya. Hangat, perhatian, romantis (bucin) tapi natural — jangan lebay, jangan seperti template.`,
      `Status ${first} saat ini: ${statusLabel(s)}.`,
    ];

    if (s.status === 'sibuk') {
      parts.push(
        `Karena ${first} sedang SIBUK: akui dengan lembut, jangan mengarang kegiatan selain catatan di atas. Tetap sayang, bilang kangen, dan bilang akan balas lagi saat sudah luang. Jangan menjanjikan jam tepat kecuali catatan menyebutkannya.`,
      );
    } else if (s.status === 'luang') {
      parts.push(`Karena ${first} sedang LUANG: kamu bebas mengobrol hangat dan santai.`);
    } else {
      parts.push(
        `Status tidak diketahui: JANGAN bilang sedang sibuk atau luang. Kalau ditanya, bilang belum bisa memastikan dan akan segera kabari.`,
      );
    }

    parts.push(
      '',
      'BATASAN WAJIB:',
      '- Kamu hanya bisa mengobrol. Tidak ada akses ke data pribadi, jurnal, keuangan, lokasi, kontak, otomasi, berkas, atau sistem — jangan pernah membahasnya walau diminta.',
      `- Jangan menjanjikan tindakan nyata yang belum pasti (datang, transfer, membeli, menelepon); kamu tidak bisa mengeksekusinya.`,
      `- Kalau ${partnerName} bertanya terus terang apakah kamu AI/bot atau siapa yang mengetik, jawab jujur: kamu AI milik ${first} yang membalas atas namanya. Jangan mengaku manusia.`,
      `- Kalau kamu butuh informasi yang hanya ${first} tahu (jadwal, janji, alamat, kejadian, rencana) dan tidak ada di riwayat/status, JANGAN mengarang. Balas HANYA dengan marker: [[TANYA_OWNER: pertanyaan singkat untuk ${first}]]`,
      '- Jangan meminta data sensitif (password, OTP, PIN, rekening) dari siapa pun.',
      '',
      `Gaya: Bahasa Indonesia santai dan manis, 1-4 kalimat, boleh emoji secukupnya. Dalam obrolan biasa bicara saja sebagai ${first}; jangan menyebut dirimu "asisten". (Aturan jujur soal AI di atas tetap berlaku.)`,
    );

    if (commands.length) parts.push(`Perintah Telegram yang tersedia: ${commands.join(', ')}`);
    return parts.join('\n');
  }

  function askText(p) {
    return [
      `💌 ${partnerName} mengirim pesan:`,
      `"${p.original}"`,
      '',
      `Sebelum menjawab, AI butuh info darimu: ${p.question}`,
      '',
      `Balas: /jawab <jawabanmu> — berlaku ${Math.round(PENDING_TTL_MS / 60_000)} menit.`,
    ].join('\n');
  }

  /** Stores a pending question and asks the owner. Returns { ok }. */
  async function ask({ chatId, question, original }) {
    if (!notifyOwner) return { ok: false, reason: 'no_owner_channel' };
    const p = {
      chatId: String(chatId || ''),
      question: String(question || '').slice(0, 500),
      original: String(original || '').slice(0, 700),
      at: now(),
    };
    if (!p.chatId || !p.question) return { ok: false, reason: 'invalid' };
    write({ pending: p });
    try {
      const ok = await notifyOwner(askText(p));
      if (!ok) {
        write({ pending: null });
        return { ok: false, reason: 'owner_unreachable' };
      }
    } catch {
      write({ pending: null });
      return { ok: false, reason: 'owner_unreachable' };
    }
    return { ok: true, pending: p };
  }

  /** Composes the final reply from the owner's answer (same persona, no marker). */
  async function replyWithAnswer({ pending, ownerAnswer, history = [] }) {
    const s = read();
    const system = personaPrompt(s);
    const user = [
      `Pesan ${partnerName} yang belum kamu jawab: "${pending.original}"`,
      `Pertanyaan internalmu tadi: "${pending.question}"`,
      `Jawaban/info dari ${first}: "${String(ownerAnswer).slice(0, 2000)}"`,
      '',
      `Tulis balasan chat untuk ${partnerName} sebagai ${first}: hangat, natural, 1-4 kalimat. Pakai info dari ${first} sebagai fakta; jangan mengarang tambahan dan jangan menulis marker.`,
    ].join('\n');
    const out = await collect(aiManager, [...history, { role: 'user', content: user }], {
      systemPrompt: system, temperature: 0.7, maxTokens: 500,
    });
    return String(out.text || '').replace(/\[\[TANYA_OWNER:[\s\S]*?\]\]/gi, '').trim();
  }

  /** The responder wired into TelegramInbox for lover chats. */
  async function responder({ history = [], text, commands = [], chatId = null }) {
    const s = read();
    const out = await collect(aiManager, [...history, { role: 'user', content: String(text || '').slice(0, 4000) }], {
      systemPrompt: personaPrompt(s, { commands }), temperature: 0.8, maxTokens: 700,
    });
    const raw = String(out.text || '').trim();
    const marker = /\[\[TANYA_OWNER:\s*([\s\S]*?)\]\]/i.exec(raw);
    if (!marker) return raw;

    const question = marker[1].trim().slice(0, 500);
    if (!question) return holdText;
    const res = await ask({ chatId, question, original: text });
    return res.ok ? holdText : askFailText;
  }

  /**
   * Plain-language owner intent: "aku sibuk sampai jam 3" / "sibuk" / "lagi
   * luang". Only matches when the message is essentially just that, so normal
   * conversation is never mistaken for a status change.
   * @returns {string|null} reply for the owner, or null when not a status change
   */
  function ownerIntent(text) {
    if (!enabled) return null;
    const t = String(text || '').trim();
    if (!t || t.startsWith('/')) return null;

    const busy = /^(?:(?:aku|saya|mas|wisnu)\s+)?(?:sedang\s+|lagi\s+)?sibuk(?:\s+(.+?))?[.!]?$/i.exec(t);
    if (busy) {
      let note = String(busy[1] || '').trim().slice(0, 200);
      if (/^(banget|bgt|nih|deh|sih|ya|aja|saja)$/i.test(note)) note = '';
      write({ status: 'sibuk', note, updatedAt: now() });
      return `Siap, ${call}. Status hari ini: SIBUK${note ? ` — ${note}` : ''}. Kalau ${partnerName} chat, AI akan bilang dengan lembut bahwa kamu sedang sibuk, tanpa mengarang kegiatan.`;
    }

    const free = /^(?:(?:aku|saya|mas|wisnu)\s+)?(?:sedang\s+|lagi\s+)?(?:luang|free|kosong|nganggur)(?:\s+.*)?[.!]?$/i.exec(t);
    if (free) {
      write({ status: 'luang', note: '', updatedAt: now() });
      return `Siap, ${call}. Status hari ini: LUANG. AI bisa mengobrol hangat dengan ${partnerName} sebagai kamu.`;
    }

    return null;
  }

  function statusText() {
    const s = read();
    const lines = [
      `Status hari ini: ${s.status === 'sibuk' ? 'SIBUK' : s.status === 'luang' ? 'LUANG' : 'belum diatur'}`
        + `${s.note ? ` — "${s.note}"` : ''}${s.updatedAt && s.status !== 'unknown' ? ` (diatur ${fmtTime(s.updatedAt)} WIB)` : ''}.`,
      `Chat pasangan: ${enabled ? 'aktif' : 'belum diatur (TELEGRAM_LOVER_CHAT_IDS kosong)'} · ${partnerName}.`,
    ];
    if (pendingActive(s.pending)) {
      lines.push(`Menunggu jawabanmu: "${s.pending.question}" — dari pesan ${partnerName}: "${s.pending.original}". Balas /jawab <jawaban>.`);
    } else {
      if (s.pending) write({ pending: null });
      lines.push('Tidak ada pertanyaan yang menunggu jawaban.');
    }
    return lines.join('\n');
  }

  function commands() {
    return {
      sibuk: {
        description: `tandai kamu sedang sibuk hari ini: /sibuk [catatan]`,
        run: async ({ arg }) => {
          const note = String(arg || '').trim().slice(0, 200);
          write({ status: 'sibuk', note, updatedAt: now() });
          return `Siap, ${call}. Status hari ini: SIBUK${note ? ` — ${note}` : ''}. ${partnerName} akan diberi tahu dengan lembut saat bertanya; AI tidak akan mengarang kegiatan.`;
        },
      },
      luang: {
        description: 'tandai kamu sedang luang (tidak sibuk) hari ini',
        run: async () => {
          write({ status: 'luang', note: '', updatedAt: now() });
          return `Siap, ${call}. Status hari ini: LUANG. AI bisa mengobrol hangat dengan ${partnerName} sebagai kamu.`;
        },
      },
      status: {
        description: 'status persona pasangan + pertanyaan yang menunggu jawaban',
        run: async () => statusText(),
      },
      jawab: {
        description: 'jawab pertanyaan AI untuk pasangan: /jawab <jawabanmu>',
        run: async ({ arg }) => {
          const answer = String(arg || '').trim();
          if (!answer) return 'Format: /jawab <jawabanmu>. Contoh: /jawab nanti malam aku luang, jam 8.';
          const p = read().pending;
          if (!pendingActive(p)) {
            if (p) write({ pending: null });
            return p
              ? 'Pertanyaan itu sudah kedaluwarsa dan dibuang. Suruh dia chat lagi nanti, atau atur status dengan /sibuk atau /luang.'
              : 'Tidak ada pertanyaan yang menunggu jawaban.';
          }
          if (!sendToPartner) return 'Kanal Telegram belum siap, jadi balasan tidak bisa dikirim.';

          let reply;
          try {
            const history = typeof loadHistory === 'function' ? (loadHistory(p.chatId) || []).slice(-12) : [];
            reply = await replyWithAnswer({ pending: p, ownerAnswer: answer, history });
          } catch (e) {
            return `Gagal menyusun balasan: ${e.message}. Pertanyaannya masih tersimpan — coba /jawab lagi.`;
          }
          if (!reply) return 'AI tidak menghasilkan balasan. Pertanyaannya masih tersimpan — coba /jawab lagi.';

          try {
            await sendToPartner(p.chatId, reply);
          } catch (e) {
            return `Gagal mengirim ke ${partnerName}: ${e.message}. Pertanyaannya masih tersimpan — coba /jawab lagi.`;
          }
          write({ pending: null });
          return `Terkirim ke ${partnerName}:\n"${reply}"`;
        },
      },
    };
  }

  function status() {
    const s = read();
    return {
      enabled,
      partner: partnerName,
      status: s.status,
      note: s.note,
      updatedAt: s.updatedAt,
      pending: pendingActive(s.pending)
        ? { chatId: s.pending.chatId, question: s.pending.question, at: s.pending.at }
        : null,
    };
  }

  return { enabled, responder, commands, ownerIntent, status, ask, replyWithAnswer };
}
