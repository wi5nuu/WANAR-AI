import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createEmailDeskStore } from '../src/email-desk/store.js';
import { EmailDesk, stripQuoted } from '../src/email-desk/service.js';
import { ImapWatcher, readImapConfig } from '../src/email-desk/imap.js';
import { quickEmailReply, emailFallback } from '../src/email-desk/assistant-actions.js';
import { makeAssistantResponder } from '../src/worklog/assistant.js';

const OWNER = '1811580954';

function aiReturning(...outputs) {
  const calls = [];
  return {
    calls,
    async *chatStream(messages, opts) {
      calls.push({ messages, opts });
      const out = outputs.length > 1 ? outputs.shift() : outputs[0];
      yield { type: 'content', content: typeof out === 'string' ? out : JSON.stringify(out) };
      yield { type: 'done' };
    },
  };
}

function build({ ai = null, live = true } = {}) {
  const db = new Database(':memory:');
  const store = createEmailDeskStore(db);
  const sent = [];
  const told = [];
  let n = 0;
  const mailer = {
    mode: live ? 'live' : 'dry-run',
    cfg: { fromAddress: 'wisnu@wanar.id' },
    async send(m) { sent.push(m); n++; return { messageId: `<out${n}@wanar.id>`, dryRun: !live }; },
  };
  const desk = new EmailDesk({
    store, mailer, aiManager: ai, env: { OWNER_NAME: 'Wisnu Alfian Nur Ashar' },
    notify: async (c, t) => { told.push({ c, t }); }, defaultChatId: () => OWNER,
  });
  return { db, store, desk, sent, told };
}

const reply = (over = {}) => ({
  messageId: `<in${Math.random()}@klien.com>`, inReplyTo: '<out1@wanar.id>', references: ['<out1@wanar.id>'],
  from: { address: 'budi@klien.com', name: 'Budi' }, subject: 'Re: Status invoice', text: 'Halo, invoice sudah kami proses minggu ini.\n\nOn Mon, Wisnu wrote:\n> lama', headers: {}, ...over,
});

describe('Email Desk: drafts and sending', () => {
  it('creates a draft with a preview and sends it exactly once on "kirim"', async () => {
    const w = build();
    const d = await w.desk.draft({ to: 'Budi@Klien.com', subject: 'Status invoice', body: 'Halo Pak Budi, ...', chatId: OWNER });
    expect(w.desk.previewText(d)).toMatch(/Draf email #1[\s\S]*Ke: budi@klien.com[\s\S]*kirim/);
    expect(w.sent).toHaveLength(0);

    expect(await quickEmailReply(w.desk, 'kirim')).toMatch(/✓ Email #1 terkirim ke budi@klien.com/);
    expect(await quickEmailReply(w.desk, 'kirim')).toBeNull(); // nothing pending any more
    expect(w.sent).toHaveLength(1);
    await expect(w.desk.sendDraft(1)).rejects.toThrow(/sudah diproses/);
    const [t] = w.desk.threads();
    expect(t).toMatchObject({ counterpart: 'budi@klien.com', auto_mode: 'notify' });
  });

  it('rejects bad addresses and empty content, and "batal" discards', async () => {
    const w = build();
    await expect(w.desk.draft({ to: 'bukan-email', body: 'x' })).rejects.toThrow(/tidak valid/);
    await expect(w.desk.draft({ to: 'a@b.co' })).rejects.toThrow(/kosong/);
    await w.desk.draft({ to: 'a@b.co', subject: 's', body: 'b' });
    expect(await quickEmailReply(w.desk, 'batal')).toMatch(/dibatalkan/);
    expect(w.desk.pendingDrafts()).toHaveLength(0);
  });

  it('asks which draft when several are waiting', async () => {
    const w = build();
    await w.desk.draft({ to: 'a@b.co', subject: 's1', body: 'b' });
    await w.desk.draft({ to: 'c@d.co', subject: 's2', body: 'b' });
    expect(await quickEmailReply(w.desk, 'kirim')).toMatch(/sebutkan nomornya/);
    expect(await quickEmailReply(w.desk, 'kirim 2')).toMatch(/#2 terkirim ke c@d.co/);
    expect(w.sent.map((m) => m.to)).toEqual(['c@d.co']);
  });

  it('says clearly when SMTP is not configured (simulation)', async () => {
    const w = build({ live: false });
    const d = await w.desk.draft({ to: 'a@b.co', subject: 's', body: 'b' });
    expect(w.desk.previewText(d)).toMatch(/disimulasikan/);
    expect(await quickEmailReply(w.desk, 'ya')).toMatch(/DISIMULASIKAN/);
  });
});

describe('Email Desk: replies (realtime inbound)', () => {
  async function sentThread(w, mode = 'notify', instructions = null) {
    await w.desk.draft({ to: 'budi@klien.com', subject: 'Status invoice', body: 'Halo', chatId: OWNER, autoMode: mode, autoInstructions: instructions });
    await w.desk.sendDraft(1);
    return w.desk.threads()[0];
  }

  it('notify: matches the reply by In-Reply-To, strips quotes, tells the owner', async () => {
    const w = build();
    await sentThread(w);
    const r = await w.desk.handleInbound(reply());
    expect(r).toEqual({ matched: true, action: 'notified' });
    expect(w.told.at(-1).t).toMatch(/Balasan email dari Budi <budi@klien.com>[\s\S]*invoice sudah kami proses/);
    expect(w.told.at(-1).t).not.toMatch(/> lama/);
  });

  it('ignores unrelated mail and duplicates', async () => {
    const w = build();
    await sentThread(w);
    expect(await w.desk.handleInbound(reply({ inReplyTo: null, references: [], from: { address: 'promo@toko.com' } }))).toEqual({ matched: false });
    const m = reply();
    await w.desk.handleInbound(m);
    expect((await w.desk.handleInbound(m)).action).toBe('duplicate');
  });

  it('approve: AI drafts the reply, owner sends it with one word, threaded headers kept', async () => {
    const ai = aiReturning({ body: 'Terima kasih Pak Budi, kami tunggu konfirmasinya.\n\nSalam,\nWisnu' });
    const w = build({ ai });
    await sentThread(w, 'approve');
    const r = await w.desk.handleInbound(reply());
    expect(r.action).toBe('drafted');
    expect(w.told.at(-1).t).toMatch(/Draf email #2 \(balasan disiapkan AI\)/);
    expect(await quickEmailReply(w.desk, 'kirim')).toMatch(/terkirim/);
    const last = w.sent.at(-1);
    expect(last.subject).toBe('Re: Status invoice');
    expect(last.headers['In-Reply-To']).toMatch(/@klien.com>$/);
    expect(last.headers['Auto-Submitted']).toBeUndefined();
    // the incoming email is passed as data, inside delimiters
    expect(ai.calls[0].messages[0].content).toMatch(/<<<[\s\S]*invoice sudah kami proses[\s\S]*>>>/);
  });

  it('auto: replies by itself, marked Auto-Submitted, and reports to the owner', async () => {
    const w = build({ ai: aiReturning({ body: 'Baik, terima kasih.' }) });
    await sentThread(w, 'auto', 'jawab sopan, bilang akan dicek');
    const r = await w.desk.handleInbound(reply());
    expect(r.action).toBe('auto_replied');
    expect(w.sent.at(-1).headers['Auto-Submitted']).toBe('auto-replied');
    expect(w.told.at(-1).t).toMatch(/Sudah saya balas otomatis/);
  });

  it('auto: never answers robots, mailing lists or other auto-responders', async () => {
    for (const bad of [
      { from: { address: 'budi@klien.com' }, headers: { 'auto-submitted': 'auto-replied' } },
      { from: { address: 'budi@klien.com' }, headers: { 'list-id': '<x.list>' } },
      { from: { address: 'budi@klien.com' }, headers: { precedence: 'bulk' } },
    ]) {
      const w = build({ ai: aiReturning({ body: 'ok' }) });
      await sentThread(w, 'auto');
      const r = await w.desk.handleInbound(reply(bad));
      expect(r.action).toBe('drafted'); // falls back to asking the owner
      expect(w.sent).toHaveLength(1);
    }
  });

  it('auto: stops after the per-conversation cap', async () => {
    const w = build({ ai: aiReturning({ body: 'ok' }) });
    w.desk.limits.autoGapMs = 0;
    await sentThread(w, 'auto');
    const actions = [];
    for (let i = 0; i < 5; i++) actions.push((await w.desk.handleInbound(reply({ inReplyTo: null, references: [] }))).action);
    expect(actions).toEqual(['auto_replied', 'auto_replied', 'auto_replied', 'drafted', 'drafted']);
  });

  it('escalates sensitive or unknown questions to the owner instead of answering', async () => {
    const w = build({ ai: aiReturning({ escalate: true, reason: 'Klien minta diskon 20%' }) });
    await sentThread(w, 'auto');
    const r = await w.desk.handleInbound(reply());
    expect(r.action).toBe('escalated');
    expect(w.told.at(-1).t).toMatch(/Perlu keputusanmu: Klien minta diskon 20%/);
    expect(w.sent).toHaveLength(1);
  });
});

describe('Email Desk via the Telegram assistant', () => {
  const worklog = {
    today: () => '2026-10-13', getSettings: () => ({ workStart: '08:00', workEnd: '17:00', breakStart: '12:00', breakEnd: '13:00', workdays: [1, 2, 3, 4, 5] }),
    listReminders: () => [],
  };

  it('model plan -> draft preview; nothing is sent without confirmation', async () => {
    const w = build();
    const ai = aiReturning({ reply: 'Ini drafnya, Wisnu.', actions: [{ type: 'email', to: 'budi@klien.com', subject: 'Status invoice', body: 'Halo Pak Budi', auto_reply: 'notify' }] });
    const respond = makeAssistantResponder({ aiManager: ai, worklog, emailDesk: w.desk });
    const out = await respond({ text: 'buatkan email ke budi@klien.com tanya status invoice, kabari kalau dibalas', chatId: OWNER });
    expect(out).toMatch(/Ini drafnya[\s\S]*Draf email #1[\s\S]*budi@klien.com/);
    expect(w.sent).toHaveLength(0);
    expect(ai.calls[0].opts.systemPrompt).toMatch(/EMAIL — kamu BISA/);

    expect(await respond({ text: 'kirim', chatId: OWNER })).toMatch(/terkirim ke budi@klien.com/);
    expect(ai.calls).toHaveLength(1); // the confirmation never hit the model
  });

  it('sends immediately only when the OWNER wrote "langsung kirim"', async () => {
    const w = build();
    const plan = { reply: 'ok', actions: [{ type: 'email', to: 'a@b.co', subject: 's', body: 'b' }] };
    const respond = makeAssistantResponder({ aiManager: aiReturning(plan), worklog, emailDesk: w.desk });
    expect(await respond({ text: 'email a@b.co langsung kirim ya', chatId: OWNER })).toMatch(/✓ Email terkirim ke a@b.co/);
    expect(w.sent).toHaveLength(1);
  });

  it('falls back to drafting from the brief when the model ignores the format', async () => {
    const w = build({ ai: aiReturning('Baik, saya buatkan ya!', 'Baik!', { subject: 'Penawaran', body: 'Yth. Bapak/Ibu, ...' }) });
    const respond = makeAssistantResponder({ aiManager: w.desk.aiManager, worklog, emailDesk: w.desk });
    const out = await respond({ text: 'kirim email ke sari@toko.id tawarkan kerja sama, balas otomatis kalau dia tanya', chatId: OWNER });
    expect(out).toMatch(/Draf email #1[\s\S]*sari@toko.id[\s\S]*Saat dibalas: balas otomatis/);
  });

  it('emailFallback needs both an address and an email intent', () => {
    expect(emailFallback('halo apa kabar')).toEqual([]);
    expect(emailFallback('alamatnya budi@x.com ya')).toEqual([]);
    expect(emailFallback('tolong email budi@x.com soal rapat')[0]).toMatchObject({ type: 'email', to: 'budi@x.com', auto_reply: 'notify' });
  });
});

describe('IMAP watcher', () => {
  it('derives config from SMTP and stays off without credentials', () => {
    expect(readImapConfig({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'a@gmail.com', SMTP_PASS: 'x' })).toMatchObject({ host: 'imap.gmail.com', port: 993, secure: true, configured: true });
    expect(readImapConfig({}).configured).toBe(false);
    expect(readImapConfig({ IMAP_HOST: 'h', IMAP_USER: 'u', IMAP_PASS: 'p', EMAIL_WATCH: 'false' }).configured).toBe(false);
  });

  it('starts at the end of the inbox (never replays history) and processes only new mail', async () => {
    let uidNext = 11;
    const box = [{ uid: 10, source: 'old' }];
    const handlers = {};
    class FakeImap {
      on(ev, fn) { handlers[ev] = fn; }
      async connect() {}
      async mailboxOpen() { this.mailbox = { uidNext }; }
      async *fetch(range) {
        const from = Number(range.split(':')[0]);
        const hits = box.filter((m) => m.uid >= from);
        for (const m of (hits.length ? hits : box.slice(-1))) yield m;
      }
      async logout() {}
    }
    const simpleParser = async (src) => ({ messageId: `<${src}>`, from: { value: [{ address: 'budi@klien.com', name: 'Budi' }] }, subject: 's', text: src, headers: new Map() });
    let cur = null;
    const got = [];
    const w = new ImapWatcher({
      env: { IMAP_HOST: 'h', IMAP_USER: 'u', IMAP_PASS: 'p' },
      onMail: async (m) => got.push(m.text),
      cursor: { get: () => cur, set: (v) => { cur = Number(v); } },
      loadLibs: async () => ({ ImapFlow: FakeImap, simpleParser }),
      log: { warn() {} },
    });
    w.stopped = false;
    await w._connect();
    expect(cur).toBe(10);
    expect(got).toEqual([]); // old mail untouched

    box.push({ uid: 11, source: 'baru' });
    uidNext = 12;
    await handlers.exists(); // IDLE push
    await new Promise((r) => setTimeout(r, 0));
    await w.check();
    expect(got).toEqual(['baru']);
    expect(cur).toBe(11);
    w.stop();
  });
});

describe('stripQuoted', () => {
  it('keeps only the new text', () => {
    expect(stripQuoted('Oke siap.\n\nPada Sen, 12 Okt 2026 Wisnu menulis:\n> halo')).toBe('Oke siap.');
    expect(stripQuoted('Baik\n> kutipan\nterima kasih')).toBe('Baik\nterima kasih');
  });
});
