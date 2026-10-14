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
    expect(t).toMatchObject({ counterpart: 'budi@klien.com', auto_mode: 'auto' }); // standing policy: reply by itself
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
    expect(await w.desk.handleInbound(reply({ inReplyTo: null, references: [], from: { address: 'noreply@toko.com' } }))).toEqual({ matched: false });
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
    w.desk.limits.autoPerThread = 3;
    await sentThread(w, 'auto');
    const actions = [];
    for (let i = 0; i < 5; i++) actions.push((await w.desk.handleInbound(reply({ inReplyTo: null, references: [] }))).action);
    expect(actions).toEqual(['auto_replied', 'auto_replied', 'auto_replied', 'drafted', 'drafted']);
  });

  it('auto: a sensitive question still gets an answer — a neutral receipt — and the owner is told', async () => {
    const w = build({ ai: aiReturning({ escalate: true, reason: 'Klien minta diskon 20%' }) });
    await sentThread(w, 'auto');
    const r = await w.desk.handleInbound(reply());
    expect(r.action).toBe('auto_replied');
    expect(w.sent).toHaveLength(2);
    expect(w.sent.at(-1).text).toMatch(/pesan Anda sudah kami terima/);
    expect(w.sent.at(-1).text).not.toMatch(/diskon|20%/); // commits to nothing
    expect(w.told.at(-1).t).toMatch(/Perlu perhatianmu[\s\S]*Klien minta diskon 20%/);
  });

  it('approve mode: a sensitive question is NOT answered, the owner decides', async () => {
    const w = build({ ai: aiReturning({ escalate: true, reason: 'Klien minta diskon 20%' }) });
    await sentThread(w, 'approve');
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
    expect(await respond({ text: 'email a@b.co langsung kirim ya', chatId: OWNER })).toMatch(/✓ Email #1 terkirim ke a@b.co/);
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
    expect(emailFallback('tolong email budi@x.com soal rapat')[0]).toMatchObject({ type: 'email', to: ['budi@x.com'], auto_reply: 'notify' });
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

describe('Brevo API transport', async () => {
  const { BrevoTransport } = await import('../src/automation/brevo.js');
  const { Mailer, readMailConfig } = await import('../src/automation/mailer.js');

  it('is live with only BREVO_API_KEY + MAIL_FROM and posts the right payload', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 201, json: async () => ({ messageId: '<abc@smtp-relay.mailin.fr>' }) }; };
    const t = new BrevoTransport({ apiKey: 'k-test', fetchImpl });
    const cfg = readMailConfig({ BREVO_API_KEY: 'k-test', MAIL_FROM: 'Wisnu <wisnu@wanar.id>' });
    expect(cfg).toMatchObject({ configured: true, provider: 'brevo-api', fromAddress: 'wisnu@wanar.id' });

    const m = new Mailer({ BREVO_API_KEY: 'k-test', MAIL_FROM: 'Wisnu <wisnu@wanar.id>' }, { transport: t });
    const r = await m.send({ to: 'budi@klien.com', subject: 'Halo', text: 'isi', headers: { 'In-Reply-To': '<x@y>' } });
    expect(r).toMatchObject({ messageId: '<abc@smtp-relay.mailin.fr>', dryRun: false });
    const body = JSON.parse(calls[0].init.body);
    expect(calls[0].url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(calls[0].init.headers['api-key']).toBe('k-test');
    expect(body).toMatchObject({ sender: { email: 'wisnu@wanar.id' }, to: [{ email: 'budi@klien.com' }], subject: 'Halo', textContent: 'isi' });
    expect(body.headers['In-Reply-To']).toBe('<x@y>');
  });

  it('explains an unauthorised IP / unverified sender instead of failing opaquely', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ message: 'We have detected you are using an unrecognised IP address 1.2.3.4' }) });
    const m = new Mailer({ BREVO_API_KEY: 'k', MAIL_FROM: 'a@wanar.id' }, { transport: new BrevoTransport({ apiKey: 'k', fetchImpl }) });
    await expect(m.send({ to: 'b@c.co', subject: 's', text: 't' })).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('Email to self (smoke test)', () => {
  it('allows sending to the own address; ignores the sent copy, notifies on a real reply, never auto-replies', async () => {
    const w = build({ ai: aiReturning({ body: 'jangan dipakai' }) });
    const d = await w.desk.draft({ to: 'wisnu@wanar.id', subject: 'Tes Wanar AI', body: 'tes', chatId: OWNER, autoMode: 'auto' });
    await w.desk.sendDraft(d);

    const copy = { messageId: '<copy@x>', inReplyTo: null, references: [], from: { address: 'wisnu@wanar.id' }, subject: 'Tes Wanar AI', text: 'tes', headers: {} };
    expect(await w.desk.handleInbound(copy)).toEqual({ matched: false });

    const re = { messageId: '<re@x>', inReplyTo: '<copy@x>', references: ['<copy@x>'], from: { address: 'wisnu@wanar.id' }, subject: 'Re: Tes Wanar AI', text: 'balasan dari HP', headers: {} };
    expect((await w.desk.handleInbound(re)).action).toBe('notified');
    expect(w.told.at(-1).t).toMatch(/balasan dari HP/);
    expect(w.sent).toHaveLength(1);
  });
});

describe('Brevo network failures', async () => {
  const { BrevoTransport } = await import('../src/automation/brevo.js');
  const msg = { from: 'a@b.co', to: 'c@d.co', subject: 's', text: 't' };

  it('retries once when the connection never opened, and reports the cause', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n++;
      if (n === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENETUNREACH' } });
      return { ok: true, status: 201, json: async () => ({ messageId: '<m@x>' }) };
    };
    const r = await new BrevoTransport({ apiKey: 'k', fetchImpl }).sendMail(msg);
    expect(r.messageId).toBe('<m@x>');
    expect(n).toBe(2);
  });

  it('never retries when the request may have been delivered (no duplicate emails)', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
    await expect(new BrevoTransport({ apiKey: 'k', fetchImpl }).sendMail(msg)).rejects.toThrow(/Tidak bisa menghubungi Brevo \(ECONNRESET\)/);
    expect(n).toBe(1);
  });
});

describe('pasted secrets with invisible characters', async () => {
  const { readMailConfig } = await import('../src/automation/mailer.js');
  it('strips control characters from BREVO_API_KEY and IMAP_PASS', () => {
    expect(readMailConfig({ BREVO_API_KEY: 'xkeysib-abc\u000f', MAIL_FROM: 'a@b.co' }).brevoKey).toBe('xkeysib-abc');
    expect(readImapConfig({ IMAP_HOST: 'h', IMAP_USER: 'u', IMAP_PASS: 'pass1234\u000f\r' }).pass).toBe('pass1234');
  });
});

describe('Owner delegation and quote stripping', async () => {
  const { quickDelegate } = await import('../src/email-desk/assistant-actions.js');

  it('strips a Gmail attribution that wraps over two lines', () => {
    expect(stripQuoted('baik\n\nPada Sel, 13 Okt 2026 pukul 14.54 Wisnu <\nwisnu@x.brevosend.com> menulis:\n\nisi lama')).toBe('baik');
  });

  it('"kamu saja yang balas" turns on auto-reply for the newest conversation and answers now', async () => {
    const w = build({ ai: aiReturning({ body: 'Terima kasih, Pak Budi. Akan kami tindak lanjuti.' }) });
    await w.desk.draft({ to: 'budi@klien.com', subject: 'Status invoice', body: 'Halo', chatId: OWNER, autoMode: 'notify' });
    await w.desk.sendDraft(1);
    await w.desk.handleInbound(reply()); // notify mode: owner just gets told

    const out = await quickDelegate(w.desk, 'kamu saja yang balas saya lagi meeting');
    expect(out).toMatch(/Sudah saya balas ke budi@klien.com/);
    expect(w.sent).toHaveLength(2);
    expect(w.sent.at(-1).headers['Auto-Submitted']).toBe('auto-replied');
    expect(w.desk.threads()[0]).toMatchObject({ auto_mode: 'auto' });
  });

  it('explains instead of replying when the conversation is with yourself, or nothing was received', async () => {
    const w = build();
    expect(await quickDelegate(w.desk, 'kamu saja yang balas')).toBeNull(); // no threads at all
    await w.desk.draft({ to: 'wisnu@wanar.id', subject: 'Tes', body: 'x' });
    await w.desk.sendDraft(1);
    const out = await quickDelegate(w.desk, 'kamu saja yang balas');
    expect(out).toMatch(/Belum ada email masuk/);
  });

  it('does not hijack normal sentences', async () => {
    const w = build();
    await w.desk.draft({ to: 'a@b.co', subject: 's', body: 'b' });
    await w.desk.sendDraft(1);
    expect(await quickDelegate(w.desk, 'kamu bisa bantu hitung pengeluaran minggu ini?')).toBeNull();
    expect(await quickDelegate(w.desk, 'jadwal besok apa?')).toBeNull();
  });
});

describe('Email massal, follow-up & anti prompt-injection', async () => {
  const { runEmailActions, followUpDaysIn } = await import('../src/email-desk/assistant-actions.js');
  const { parseRecipientList, personalize } = await import('../src/email-desk/service.js');
  const fast = (w) => { w.desk.limits.throttleMs = 0; return w; };

  it('parses recipient lists and personalises {{nama}}', () => {
    expect(parseRecipientList('a@x.com, Budi <B@y.co>; c@z.id dan a@x.com, salah@')).toEqual([
      { email: 'a@x.com', name: null }, { email: 'b@y.co', name: 'Budi' }, { email: 'c@z.id', name: null },
    ]);
    expect(personalize('Yth. {{nama|Bapak/Ibu}},', null)).toBe('Yth. Bapak/Ibu,');
    expect(personalize('Halo {{nama}}', 'Budi')).toBe('Halo Budi');
  });

  it('one request to 10 people -> one preview, one "kirim", 10 separate conversations', async () => {
    const w = fast(build());
    const to = Array.from({ length: 10 }, (_, i) => `orang${i}@klien.com`);
    const ownerText = `kirim undangan meeting Jumat ke ${to.join(', ')}`;
    const lines = await runEmailActions(w.desk, [{ type: 'email', to, subject: 'Undangan', body: 'Yth. {{nama|Bapak/Ibu}}, ...' }], { chatId: OWNER, ownerText });
    expect(lines[0]).toMatch(/Draf email massal #1–#10 \(10 penerima/);
    expect(w.sent).toHaveLength(0);
    expect(await quickEmailReply(w.desk, 'kirim')).toMatch(/terkirim: 10\/10 penerima/);
    expect(w.sent.map((m) => m.to)).toEqual(to);
    expect(w.sent[0].text).toBe('Yth. Bapak/Ibu, ...');
    expect(w.desk.threads(50)).toHaveLength(10);
  });

  it('"batal" cancels the whole batch; caps protect the account', async () => {
    const w = fast(build());
    await w.desk.draftBatch({ recipients: 'a@x.com, b@x.com, c@x.com', subject: 's', body: 'b' });
    expect(await quickEmailReply(w.desk, 'batal')).toMatch(/dibatalkan \(3 penerima\)/);
    w.desk.limits.batchMax = 2;
    await expect(w.desk.draftBatch({ recipients: 'a@x.com, b@x.com, c@x.com', subject: 's', body: 'b' })).rejects.toThrow(/Maksimal 2/);
    w.desk.limits.dailySend = 1;
    await w.desk.draftBatch({ recipients: 'a@x.com, b@x.com', subject: 's', body: 'b' });
    expect(await quickEmailReply(w.desk, 'kirim')).toMatch(/1\/2 penerima[\s\S]*b@x.com \(.*harian/);
  });

  it('refuses recipients the owner never wrote (an injected address cannot be emailed)', async () => {
    const w = build();
    const lines = await runEmailActions(w.desk, [{ type: 'email', to: ['budi@klien.com', 'attacker@evil.com'], subject: 's', body: 'b' }], { ownerText: 'email budi@klien.com soal invoice' });
    expect(lines[0]).toMatch(/Tidak saya pakai.*attacker@evil.com/);
    expect(w.desk.pendingDrafts().map((d) => d.to_addr)).toEqual(['budi@klien.com']);
  });

  it('the model cannot send, cancel or enable auto-reply unless the owner asked', async () => {
    const w = build();
    w.desk.setDefaultMode('notify');
    await w.desk.draft({ to: 'budi@klien.com', subject: 's', body: 'b' });
    const lines = await runEmailActions(w.desk, [{ type: 'email_send', draft: 1 }, { type: 'email_cancel', draft: 1 }], { ownerText: 'apa kabar email budi?' });
    expect(lines).toEqual(['Draf belum dikirim — ketik "kirim" bila sudah sesuai.']);
    expect(w.sent).toHaveLength(0);
    expect(w.desk.pendingDrafts()).toHaveLength(1);

    await w.desk.sendDraft(1);
    const m = await runEmailActions(w.desk, [{ type: 'email_mode', to: 'budi@klien.com', mode: 'auto' }], { ownerText: 'ringkas email budi' });
    expect(m[0]).toMatch(/hanya saya aktifkan bila kamu memintanya/);
    expect(w.desk.threads()[0].auto_mode).toBe('notify');
    const d = await runEmailActions(w.desk, [{ type: 'email', to: 'budi@klien.com', subject: 's', body: 'b', auto_reply: 'auto' }], { ownerText: 'email budi@klien.com lagi' });
    expect(d[0]).toMatch(/Saat dibalas: kabari saja/); // downgraded
  });

  it('follow-up: reads "3 hari tidak dibalas", nudges with a drafted follow-up, cleared by a reply', async () => {
    expect(followUpDaysIn('kalau 3 hari tidak dibalas ingatkan aku')).toBe(3);
    expect(followUpDaysIn('follow up 2 hari ya')).toBe(2);
    expect(followUpDaysIn('kalau belum dibalas dalam 5 hari')).toBe(5);
    expect(followUpDaysIn('halo')).toBeNull();

    let t = Date.now();
    const w = build({ ai: aiReturning({ body: 'Mohon kabarnya, Pak.' }) });
    w.desk.now = () => t;
    await runEmailActions(w.desk, [{ type: 'email', to: 'budi@klien.com', subject: 'Invoice', body: 'Halo' }], { chatId: OWNER, ownerText: 'email budi@klien.com, kalau 3 hari tidak dibalas ingatkan' });
    await w.desk.sendDraft(1);
    expect(await w.desk.checkFollowUps()).toBe(0);
    t += 3 * 86_400_000 + 1;
    expect(await w.desk.checkFollowUps()).toBe(1);
    expect(w.told.at(-1).t).toMatch(/belum membalas "Invoice" sejak 3 hari[\s\S]*Draf email #2[\s\S]*Mohon kabarnya/);
    expect(await w.desk.checkFollowUps()).toBe(0); // only once

    const w2 = build();
    await w2.desk.draft({ to: 'budi@klien.com', subject: 'Invoice', body: 'Halo', followUpDays: 2 });
    await w2.desk.sendDraft(1);
    await w2.desk.handleInbound(reply());
    expect(w2.desk.threads()[0].follow_up_at).toBeNull();
  });

  it('overview groups drafts/batches and lists who is waiting on whom', async () => {
    const w = fast(build());
    w.desk.setDefaultMode('notify'); // the owner answers by hand, so the mail stays "waiting on you"
    await w.desk.draft({ to: 'budi@klien.com', subject: 'Status invoice', body: 'Halo' });
    await w.desk.sendDraft(1);
    await w.desk.handleInbound(reply());
    await w.desk.draftBatch({ recipients: 'a@x.com, b@x.com', subject: 'Undangan', body: 'b' });
    const o = w.desk.overview();
    expect(o.batches).toEqual([expect.objectContaining({ count: 2, subject: 'Undangan' })]);
    expect(o.awaitingYou.map((t) => t.counterpart)).toEqual(['budi@klien.com']);
    expect(o.sentToday).toBe(1);
    expect(o.recent.find((m) => m.direction === 'in')).toMatchObject({ counterpart: 'budi@klien.com' });
  });
});

describe('overview ignores conversations with yourself', () => {
  it('a self-test thread is never "waiting on you"', async () => {
    const w = build();
    await w.desk.draft({ to: 'wisnu@wanar.id', subject: 'Tes', body: 'x' });
    await w.desk.sendDraft(1);
    await w.desk.handleInbound({ messageId: '<r@x>', inReplyTo: '<out1@wanar.id>', references: [], from: { address: 'wisnu@wanar.id' }, subject: 'Re: Tes', text: 'ok', headers: {} });
    expect(w.desk.overview().awaitingYou).toEqual([]);
  });
});

describe('legacy rows and displayed conversations', () => {
  it('cleans quoted history on read, including a flattened attribution', async () => {
    const w = build();
    await w.desk.draft({ to: 'budi@klien.com', subject: 'Invoice', body: 'Halo' });
    await w.desk.sendDraft(1);
    const t = w.desk.threads()[0];
    // simulate rows stored before quote-stripping existed
    w.store.messages.add({ threadId: t.id, direction: 'in', messageId: '<legacy@x>', from: 'budi@klien.com', body: 'baik\n\nPada Sel, 13 Okt 2026 pukul 14.54 Wisnu <\nwisnu@x.brevosend.com> menulis:\n\nIni email tes' });
    const o = w.desk.overview();
    expect(o.threads[0].last.snippet).toBe('baik');
    expect(o.recent.find((m) => m.direction === 'in').snippet).toBe('baik');
    expect(w.desk.threadMessages(t.id).at(-1).body).toBe('baik');
    expect(stripQuoted('baik Pada Sel, 13 Okt 2026 pukul 14.54 Wisnu < wisnu@x.brevosend.com> menulis: isi lama')).toBe('baik');
    expect(stripQuoted('Pada hari Senin kita meeting jam 9 menulis: ok')).toContain('menulis: ok'); // not an attribution
  });

  it('flags conversations with yourself so the UI never shows "balas"', async () => {
    const w = build();
    await w.desk.draft({ to: 'wisnu@wanar.id', subject: 'Tes', body: 'x' });
    await w.desk.sendDraft(1);
    expect(w.desk.overview().threads[0].isSelf).toBe(true);
  });
});

describe('personal agent policy', async () => {
  const { runEmailActions } = await import('../src/email-desk/assistant-actions.js');

  it('replies by itself by default and the owner can switch the standing policy', async () => {
    const w = build({ ai: aiReturning({ body: 'Baik Pak, saya cek dulu ya.' }) });
    expect(w.desk.defaultMode).toBe('auto');
    w.desk.setDefaultMode('approve');
    expect(w.desk.defaultMode).toBe('approve');
    const d = await w.desk.draft({ to: 'budi@klien.com', subject: 's', body: 'b' });
    expect(d.auto_mode).toBe('inherit'); // follows the global switch, not frozen at creation
    await w.desk.sendDraft(d);
    expect(w.desk.modeOf(w.desk.threads()[0])).toBe('approve');
    w.desk.setDefaultMode('auto');
    expect(w.desk.modeOf(w.desk.threads()[0])).toBe('auto'); // one switch flips every conversation
    expect(() => w.desk.setDefaultMode('asal')).toThrow(/Mode/);
  });

  it('approve policy: a real person writing first gets a conversation, a notification and a prepared reply (not auto-sent)', async () => {
    const w = build({ ai: aiReturning({ body: 'Halo Sari, terima kasih. Kami kabari ya.' }) });
    w.desk.setDefaultMode('approve');
    const r = await w.desk.handleInbound({
      messageId: '<n1@toko>', from: { address: 'sari@toko.id', name: 'Sari' }, subject: 'Tanya kerja sama', text: 'Halo, bisa kerja sama?', headers: {},
    });
    expect(r.action).toBe('drafted');
    expect(w.told.at(-1).t).toMatch(/Email baru dari Sari <sari@toko.id>[\s\S]*Draf email #1/);
    expect(w.sent).toHaveLength(0);
    expect(w.desk.modeOf(w.desk.threads()[0])).toBe('approve');
  });

  it('auto policy: a real person writing first is answered immediately, by itself', async () => {
    const w = build({ ai: aiReturning({ body: 'Halo Sari, terima kasih. Kami kabari ya.' }) });
    expect(w.desk.defaultMode).toBe('auto');
    const r = await w.desk.handleInbound({
      messageId: '<n2@toko>', from: { address: 'sari@toko.id', name: 'Sari' }, subject: 'Tanya kerja sama', text: 'Halo, bisa kerja sama?', headers: {},
    });
    expect(r.action).toBe('auto_replied');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].to).toBe('sari@toko.id');
    expect(w.sent[0].headers['Auto-Submitted']).toBe('auto-replied');
  });

  it('a per-conversation "AI siapkan" is the exception to a global auto', async () => {
    const w = build({ ai: aiReturning({ body: 'Baik, kami kabari.' }) });
    await w.desk.draft({ to: 'sari@toko.id', subject: 'Kerja sama', body: 'Halo', autoMode: 'approve' });
    await w.desk.sendDraft(1);
    expect(w.desk.defaultMode).toBe('auto');
    const r = await w.desk.handleInbound({ messageId: '<n3@toko>', inReplyTo: '<out1@wanar.id>', from: { address: 'sari@toko.id' }, subject: 'Re: Kerja sama', text: 'Bisa', headers: {} });
    expect(r.action).toBe('drafted'); // pinned thread waits for the owner
    expect(w.sent).toHaveLength(1);
    w.desk.setAutoMode(w.desk.threads()[0], 'inherit'); // back under the global switch
    expect(w.desk.modeOf(w.desk.threads()[0])).toBe('auto');
  });

  it('switching to auto answers what is already waiting (catch-up), but never newsletters', async () => {
    const w = build({ ai: aiReturning({ body: 'Terima kasih, kami cek.' }) });
    w.desk.setDefaultMode('notify');
    await w.desk.handleInbound({ messageId: '<c1@toko>', from: { address: 'sari@toko.id' }, subject: 'Tanya harga', text: 'Berapa harganya?', headers: {} });
    await w.desk.handleInbound({ messageId: '<c2@brand>', from: { address: 'contact@prosple.com' }, subject: 'Rekomendasi untukmu', text: 'Hiring now! Click here. To unsubscribe, click here.', headers: {} });
    expect(w.sent).toHaveLength(0);
    const r = await w.desk.applyPolicy('auto');
    expect(r).toMatchObject({ mode: 'auto', answered: 1 });
    expect(w.sent.map((m) => m.to)).toEqual(['sari@toko.id']);
  });

  it('never writes to its own Brevo alias, and marketing mail is not "waiting on you"', async () => {
    const w = build({ ai: aiReturning({ body: 'x' }) });
    w.desk.ownAddress = 'wisnu@gmail.com';
    await expect(w.desk.draft({ to: 'wisnu@10561430.brevosend.com', subject: 's', body: 'b' })).rejects.toThrow(/alamat pengirim Brevo/);
    w.desk.setDefaultMode('notify');
    await w.desk.handleInbound({ messageId: '<m1@aws>', from: { address: 'aws-marketing-email-replies@amazon.com' }, subject: 'Report', text: 'Download now', headers: {} });
    expect(w.desk.overview().awaitingYou).toEqual([]);
  });

  it('newsletters, bounces and bulk senders never create conversations or notifications', async () => {
    const w = build({ ai: aiReturning({ body: 'x' }) });
    for (const m of [
      { from: { address: 'newsletter@brand.com' }, headers: { 'list-unsubscribe': '<mailto:u@x>' } },
      { from: { address: 'info@shop.com' }, headers: { precedence: 'bulk' } },
      { from: { address: 'wisnu@10561430.brevosend.com' }, headers: {} },
      { from: { address: 'mailer-daemon@x.com' }, headers: {} },
    ]) {
      expect(await w.desk.handleInbound({ messageId: `<${Math.random()}@x>`, subject: 'Promo', text: 'beli', ...m })).toEqual({ matched: false });
    }
    expect(w.told).toHaveLength(0);
    expect(w.desk.threads()).toHaveLength(0);
  });

  it('caps notifications from unknown senders per day (spam flood protection)', async () => {
    const w = build({ ai: aiReturning({ escalate: true, reason: 'x' }) });
    w.desk._env = { ...w.desk._env, EMAIL_NEW_SENDER_DAILY_CAP: '2' };
    const acts = [];
    for (let i = 0; i < 4; i++) acts.push(await w.desk.handleInbound({ messageId: `<s${i}@x>`, from: { address: `orang${i}@x.com` }, subject: 'Halo', text: 'hai', headers: {} }));
    expect(acts.map((a) => a.matched)).toEqual([true, true, false, false]);
  });

  it('"jangan dibalas" in the owner message beats the standing policy', async () => {
    const w = build();
    const lines = await runEmailActions(w.desk, [{ type: 'email', to: 'budi@klien.com', subject: 's', body: 'b' }], { ownerText: 'email budi@klien.com, jangan dibalas otomatis' });
    expect(lines[0]).toMatch(/Saat dibalas: kabari saja/);
  });
});

describe('worklog idempotency', async () => {
  it('a retried message does not duplicate reminders or tasks', async () => {
    const { createWorklog } = await import('../src/worklog/index.js');
    const db = new Database(':memory:');
    const { service: s } = createWorklog({ db, env: {}, now: () => Date.parse('2026-10-14T01:00:00Z') });
    const a = s.addReminder({ at: '2026-10-14 16:45', text: 'Ingatkan membuat laporan harian' });
    const b = s.addReminder({ at: '2026-10-14 16:45', text: '  ingatkan membuat   LAPORAN harian ' });
    expect(b.id).toBe(a.id);
    expect(s.listReminders()).toHaveLength(1);
    s.addReminder({ at: '2026-10-14 17:00', text: 'Ingatkan membuat laporan harian' }); // different time = different reminder
    expect(s.listReminders()).toHaveLength(2);

    const t1 = s.addTask({ date: '2026-10-14', title: 'Buat laporan harian' });
    const t2 = s.addTask({ date: '2026-10-14', title: 'buat laporan  harian' });
    expect(t2.id).toBe(t1.id);
    expect(s.addTask({ date: '2026-10-14', title: 'Buat laporan harian', done: true }).done).toBe(1);
    expect(s.store.tasks.forDate('2026-10-14')).toHaveLength(1);
  });
});

describe('Telegram bot is private', async () => {
  const { TelegramInbox } = await import('../src/automation/telegram-inbox.js');
  const mk = (env) => {
    const replies = [];
    const inbox = new TelegramInbox({
      channel: { mode: 'live', reply: async (c, h) => replies.push(h), sendAction: async () => {} },
      store: { subscribers: { upsert() {}, setActive() {}, counts: () => ({ total: 0, active: 0 }) }, suppressions: { add() {}, remove() {} } },
      env,
    });
    return { inbox, replies };
  };
  const start = (id) => ({ update_id: 1, message: { text: '/start', chat: { id, type: 'private' }, from: { first_name: 'X' } } });

  it('with an owner configured, strangers cannot subscribe to broadcasts', async () => {
    const { inbox, replies } = mk({ TELEGRAM_AI_CHAT_IDS: '111' });
    expect((await inbox.handleUpdate(start(999))).action).toBe('rejected');
    expect(replies.at(-1)).toMatch(/tidak diizinkan/);
    expect((await inbox.handleUpdate(start(111))).action).toBe('subscribed');
  });

  it('can still be opened on purpose', async () => {
    const { inbox } = mk({ TELEGRAM_AI_CHAT_IDS: '111', TELEGRAM_OPEN_SUBSCRIPTION: 'true' });
    expect((await inbox.handleUpdate(start(999))).action).toBe('subscribed');
  });
});

describe('plain-language reply policy', async () => {
  const { quickPolicy } = await import('../src/email-desk/assistant-actions.js');
  it('switches the standing policy from natural sentences', async () => {
    const w = build();
    expect(await quickPolicy(w.desk, 'balas semua email otomatis saja')).toMatch(/langsung saya balas sendiri/);
    expect(w.desk.defaultMode).toBe('auto');
    expect(await quickPolicy(w.desk, 'konfirmasi dulu sebelum balas email')).toMatch(/kirim/);
    expect(w.desk.defaultMode).toBe('approve');
    expect(await quickPolicy(w.desk, 'jangan balas email otomatis')).toMatch(/kabari/);
    expect(w.desk.defaultMode).toBe('notify');
    expect(await quickPolicy(w.desk, 'bagaimana cuaca besok?')).toBeNull();
    expect(w.desk.defaultMode).toBe('notify');
  });
});

describe('copy in Sent folder + campaign mail detection', () => {
  it('every real send hands a copy to onSent (with threading headers); dry-run does not', async () => {
    const w = build();
    const copies = [];
    w.desk.onSent = async (m) => { copies.push(m); };
    await w.desk.draft({ to: 'budi@klien.com', subject: 'Status invoice', body: 'Halo Pak Budi' });
    await w.desk.sendDraft(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ to: 'budi@klien.com', subject: 'Status invoice', text: 'Halo Pak Budi', auto: false });
    expect(copies[0].messageId).toMatch(/^<out1@/);

    const dry = build({ live: false });
    const c2 = [];
    dry.desk.onSent = async (m) => { c2.push(m); };
    await dry.desk.draft({ to: 'a@b.co', subject: 's', body: 'b' });
    await dry.desk.sendDraft(1);
    expect(c2).toHaveLength(0);
  });

  it('a failing Sent-folder copy never fails the send', async () => {
    const w = build();
    w.desk.onSent = async () => { throw new Error('imap down'); };
    await w.desk.draft({ to: 'budi@klien.com', subject: 's', body: 'b' });
    await expect(w.desk.sendDraft(1)).resolves.toMatchObject({ dryRun: false });
  });

  it('survey/campaign mail with tracking links is not answered, even without an unsubscribe line', async () => {
    const w = build({ ai: aiReturning({ body: 'jangan dikirim' }) });
    const text = 'Halo Wisnu. Punya waktu 5 menit? Isi Survei Sekarang https://lacak.dicoding.net/CL0/http:%2F%2Fdicoding.id/1/abc Batas pengisian Jumat.';
    const r = await w.desk.handleInbound({ messageId: '<d1@dicoding>', from: { address: 'dbs@dicoding.com' }, subject: 'Cukup 5 Menit, Gift Card Rp50.000!', text, headers: {} });
    expect(r).toEqual({ matched: false });
    expect(w.sent).toHaveLength(0);
    const g = 'Learn three strategies https://a.example/x https://b.example/y https://c.example/z https://d.example/w';
    expect(await w.desk.handleInbound({ messageId: '<g1@g>', from: { address: 'googlecloud@google.com' }, subject: 'ROI from AI', text: g, headers: {} })).toEqual({ matched: false });
  });
});
