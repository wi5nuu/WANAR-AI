/**
 * src/email-desk/index.js
 *
 * Composition root: store + service + IMAP watcher + owner Telegram commands.
 *
 *   /email          drafts waiting + recent conversations + watcher status
 *   /kirim <no>     send draft #no      /tolak <no>   discard draft #no
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { createEmailDeskStore } from './store.js';
import { EmailDesk } from './service.js';
import { ImapWatcher } from './imap.js';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

let instance = null;

const expose = (message) => Object.assign(new Error(message), { expose: true });

export function emailTelegramCommands(desk, watcher = null) {
  const guard = (fn) => async (ctx) => {
    try { return await fn(ctx); } catch (e) { throw expose(e.message || 'Gagal'); }
  };
  return {
    email: {
      description: 'draf & percakapan email (kirim email: tulis biasa, mis. "email ke budi@x.com tanya invoice")',
      run: guard(async () => {
        const drafts = desk.pendingDrafts();
        const threads = desk.threads(8);
        const w = watcher?.describe();
        return [
          `Email: ${desk.live ? 'SMTP aktif' : 'SMTP belum diatur (simulasi)'} · Pantau balasan: ${w?.configured ? w.state : 'IMAP belum diatur'}`,
          '',
          drafts.length ? `Draf menunggu:\n${drafts.map((d) => `#${d.seq} → ${d.to_addr} — ${d.subject}`).join('\n')}` : 'Tidak ada draf menunggu.',
          '',
          threads.length ? `Percakapan:\n${threads.map((t) => `• ${t.counterpart} — ${t.subject} [${t.auto_mode}]`).join('\n')}` : 'Belum ada percakapan email.',
        ].join('\n');
      }),
    },
    kirim: {
      description: 'kirim draf email: /kirim 3',
      run: guard(async ({ arg }) => {
        const pending = desk.pendingDrafts();
        const ref = arg || (pending.length === 1 ? pending[0].seq : null);
        if (!ref) return pending.length ? 'Ada beberapa draf — sebutkan nomornya, mis. /kirim 3 (lihat /email)' : 'Tidak ada draf menunggu.';
        const r = await desk.sendDraft(ref);
        return `✓ Email #${r.draft.seq} ${r.dryRun ? 'DISIMULASIKAN (SMTP belum diatur)' : 'terkirim'} ke ${r.draft.to_addr}. Saya kabari kalau ada balasan.`;
      }),
    },
    balasotomatis: {
      description: 'atur kebiasaan membalas email: /balasotomatis auto | konfirmasi | kabari',
      run: guard(async ({ arg }) => {
        const map = { auto: 'auto', otomatis: 'auto', konfirmasi: 'approve', approve: 'approve', kabari: 'notify', notify: 'notify' };
        const mode = map[String(arg || '').trim().toLowerCase()];
        const now = desk.defaultMode;
        const label = { auto: 'balas otomatis', approve: 'AI siapkan, kamu konfirmasi', notify: 'kabari saja' };
        if (!mode) return `Kebiasaan sekarang: ${label[now]}.
Ubah: /balasotomatis auto | konfirmasi | kabari`;
        const r = await desk.applyPolicy(mode);
        return `Oke, sekarang: ${label[mode]}.${r.answered ? ` Saya juga membalas ${r.answered} email yang masih menunggu.` : ''}`;
      }),
    },
    tolak: {
      description: 'buang draf email: /tolak 3',
      run: guard(async ({ arg }) => {
        const pending = desk.pendingDrafts();
        const ref = arg || (pending.length === 1 ? pending[0].seq : null);
        if (!ref) return 'Sebutkan nomor draf, mis. /tolak 3';
        const d = desk.cancelDraft(ref);
        return `Draf #${d.seq} dibatalkan.`;
      }),
    },
  };
}

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.automation  provides mailer, telegram channel and inbox
 */
export function createEmailDesk({ db, aiManager = null, automation = null, env = process.env, now, worklog = null }) {
  const store = createEmailDeskStore(db, now ? { now } : {});
  const telegram = automation?.channels?.has?.('telegram') ? automation.channels.get('telegram') : null;
  const ownerChats = String(env.TELEGRAM_AI_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const desk = new EmailDesk({
    store,
    mailer: automation?.mailer,
    aiManager,
    env,
    now,
    defaultChatId: () => ownerChats[0] || null,
    // Shared router: understands "wa:628..." (WhatsApp) and Telegram chat ids,
    // so draft confirmations follow the channel they were created in.
    notify: automation?.notify
      ? (chatId, text) => automation.notify(chatId, text)
      : telegram
        ? async (chatId, text) => {
          if (telegram.mode !== 'live') throw new Error('Telegram belum dikonfigurasi (mode simulasi)');
          await telegram.send({ to: chatId, text });
        }
        : null,
  });

  const watcher = new ImapWatcher({
    env,
    onMail: (mail) => desk.handleInbound(mail),
    cursor: { get: () => store.meta.get('imap_last_uid'), set: (v) => store.meta.set('imap_last_uid', v) },
  });

  // Every outgoing email (typed by you or sent by the assistant) is also filed in Gmail "Terkirim".
  desk.onSent = async (m) => {
    if (!watcher.cfg.configured) return;
    const headers = {};
    if (m.auto) headers['Auto-Submitted'] = 'auto-replied';
    const raw = await new Promise((resolve, reject) => {
      new MailComposer({
        from: { name: m.fromName || '', address: m.from },
        to: m.to,
        subject: m.subject,
        text: m.text,
        date: new Date(),
        messageId: m.messageId || undefined,
        inReplyTo: m.inReplyTo || undefined,
        references: m.references || undefined,
        headers,
      }).compile().build((err, buf) => (err ? reject(err) : resolve(buf)));
    });
    await watcher.appendSent(raw);
  };

  // Meeting found in an email -> task + reminders (15 min before and on time) + a heads-up on Telegram.
  if (worklog) {
    desk.onMeeting = async (m, ctx) => {
      const hhmm = m.time;
      const place = m.place ? ` di ${m.place}` : '';
      const label = `${m.title}${place}`;
      const out = [];
      const when = new Date(m.at).toLocaleString('id-ID', {
        timeZone: process.env.WORKLOG_TZ || 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      });

      // clash check: something else within 30 minutes of the start
      const clash = worklog.listReminders(200).filter((r) => Math.abs(r.at - m.at) <= 30 * 60_000 && !r.text.includes(m.title.slice(0, 20)));

      try { worklog.addTask({ date: m.date, title: `${m.title} · ${hhmm}${place}`.slice(0, 160), done: false }); out.push('tugas'); } catch { /* duplicate or invalid */ }
      const lead = m.at - 15 * 60_000;
      if (lead > desk.now()) {
        try { worklog.addReminder({ at: lead, text: `15 menit lagi: ${label}`, chatId: ctx.chatId, source: 'email' }); out.push('pengingat 15 menit sebelumnya'); } catch { /* ignore */ }
      }
      try { worklog.addReminder({ at: m.at, text: `Sekarang: ${label}`, chatId: ctx.chatId, source: 'email' }); out.push('pengingat tepat waktu'); } catch { /* ignore */ }

      const lines = [
        `Jadwal dibuat dari email ${ctx.who}:`,
        `${m.title}`,
        `${when}${m.durationMin ? ` · sekitar ${m.durationMin} menit` : ''}${place}`,
        m.assumedDate ? '(Email tidak menyebut tanggal; saya asumsikan ' + (m.date === new Date(desk.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) ? 'hari ini' : 'besok') + '.)' : '',
        clash.length ? `Perhatian, bentrok dengan: ${clash.slice(0, 3).map((r) => r.text).join('; ')}` : '',
        out.length ? `Tersimpan: ${out.join(', ')}.` : 'Sudah ada di jadwal.',
      ].filter(Boolean);
      await desk._tell(ctx.chatId, lines.join('\n'));
    };
  }

  if (automation?.inbox?.registerCommands) automation.inbox.registerCommands(emailTelegramCommands(desk, watcher));
  return { store, desk, watcher };
}

export function initEmailDesk(deps) {
  if (!instance) instance = createEmailDesk(deps);
  return instance;
}

export function getEmailDesk() {
  return instance;
}
