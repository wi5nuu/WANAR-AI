/**
 * Test Suite: src/automation/channels/* + telegram-inbox + multi-channel engine
 *
 * Every provider is exercised through an injected fake `fetch`: no network, no
 * real messages, no credentials. What is asserted is the wire format we send and
 * how each provider's failures are classified for the campaign engine.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { createAutomation } from '../src/automation/index.js';
import { chunkText } from '../src/automation/channels/base.js';
import { createTelegramChannel, classifyTelegram } from '../src/automation/channels/telegram.js';
import { createWhatsAppChannel, classifyWhatsApp, sanitizeTemplateParam } from '../src/automation/channels/whatsapp.js';
import { createWebhookChannel } from '../src/automation/channels/webhooks.js';
import { ErrorKind } from '../src/automation/mailer.js';
import { CampaignStatus } from '../src/automation/store.js';
import { parseRecipients, normalizePhone, extractSubscribersToken } from '../src/automation/recipients.js';
import { TelegramInbox } from '../src/automation/telegram-inbox.js';

// ------------------------------------------------------------------ helpers

const TG_TOKEN = '123456789:AAFakeTokenFakeTokenFakeToken_abcdef';

function fakeFetch(handler = () => ({})) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method,
      headers: init.headers || {},
      body: init.body,
      json: typeof init.body === 'string' ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null,
    };
    calls.push(call);
    const r = (await handler(call, calls.length)) || {};
    const status = r.status ?? 200;
    const body = r.body === undefined
      ? JSON.stringify({ ok: true, result: { message_id: 1000 + calls.length }, messages: [{ id: `wamid.${calls.length}` }] })
      : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    return new Response(status === 204 ? null : body, { status, headers: r.headers });
  });
  fn.calls = calls;
  return fn;
}

function makeAuto({ env = {}, fetchImpl, ai, emailTransport } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const sendMail = emailTransport || vi.fn(async (m) => ({ messageId: `<${m.to}>`, accepted: [m.to] }));
  const aiManager = ai || {
    async *chatStream() {
      yield { type: 'content', content: '{"subject":"Ringkasan Harian","body":"Halo {{nama}}, ini ringkasan hari ini."}' };
      yield { type: 'done' };
    },
  };
  const a = createAutomation({
    db,
    aiManager,
    env: {
      MAIL_FROM: 'Wanar <bot@kantor.co.id>', EMAIL_THROTTLE_MS: '0',
      TELEGRAM_THROTTLE_MS: '0', WHATSAPP_THROTTLE_MS: '0',
      SLACK_THROTTLE_MS: '0', DISCORD_THROTTLE_MS: '0', TEAMS_THROTTLE_MS: '0', WEBHOOK_THROTTLE_MS: '0',
      ...env,
    },
    transport: { sendMail },
    fetchImpl,
    engineOptions: { backoffBaseMs: 1 },
    attachmentsDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wanar-ch-')),
  });
  return { ...a, sendMail, db };
}

const TG = { TELEGRAM_BOT_TOKEN: TG_TOKEN };
const WA = { WHATSAPP_TOKEN: 'EAAtesttoken', WHATSAPP_PHONE_NUMBER_ID: '1234567890' };

// ------------------------------------------------------------------- basics

describe('chunkText', () => {
  it('returns short text untouched', () => {
    expect(chunkText('halo', 100)).toEqual(['halo']);
  });

  it('splits on paragraph boundaries and never exceeds the limit', () => {
    const para = 'Kalimat contoh yang cukup panjang untuk diuji. '.repeat(10).trim();
    const text = [para, para, para].join('\n\n');
    const parts = chunkText(text, 600);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(600);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toContain(para.slice(0, 40));
  });

  it('hard-splits text with no natural boundary', () => {
    const parts = chunkText('x'.repeat(1000), 300);
    expect(parts.every((p) => p.length <= 300)).toBe(true);
    expect(parts.join('').length).toBe(1000);
  });
});

describe('recipient kinds', () => {
  it('normalises Indonesian phone numbers to international digits', () => {
    expect(normalizePhone('0812-3456-7890')).toBe('6281234567890');
    expect(normalizePhone('+62 813 9488 2490')).toBe('6281394882490');
    expect(normalizePhone('(021) 555 0100')).toBe('62215550100');
    expect(normalizePhone('6281234567890')).toBe('6281234567890');
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
  });

  it('de-duplicates equivalent phone formats', () => {
    const r = parseRecipients('0812-3456-7890\n+6281234567890\n6281234567890', { kind: 'phone' });
    expect(r.recipients).toHaveLength(1);
    expect(r.duplicates).toHaveLength(2);
  });

  it('parses Telegram chat ids (users, groups, channels)', () => {
    const r = parseRecipients('nama,chat_id\nAni,123456789\nGrup,-1001234567890\nKanal,@Kanal_Kantor\nsalah,abc', { kind: 'chat_id' });
    expect(r.recipients.map((x) => x.email)).toEqual(['123456789', '-1001234567890', '@kanal_kantor']);
    expect(r.invalid).toHaveLength(1);
  });

  it('extracts the @subscribers shortcut', () => {
    expect(extractSubscribersToken('@subscribers\n123456789')).toEqual({ input: '123456789', useSubscribers: true });
    expect(extractSubscribersToken('123456789').useSubscribers).toBe(false);
    expect(extractSubscribersToken(['@subscribers', '1']).useSubscribers).toBe(true);
  });
});

// ----------------------------------------------------------------- telegram

describe('Telegram channel', () => {
  it('simulates (no network) when no token is configured', async () => {
    const f = fakeFetch();
    const ch = createTelegramChannel({}, { fetchImpl: f });
    expect(ch.mode).toBe('dry-run');
    const r = await ch.send({ to: '123456789', text: 'Halo' });
    expect(r.dryRun).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('sends HTML-escaped text with a bold subject', async () => {
    const f = fakeFetch();
    const ch = createTelegramChannel(TG, { fetchImpl: f });
    expect(ch.mode).toBe('live');
    await ch.send({ to: '123456789', subject: 'Info <penting>', text: 'Harga < 10 & stok > 5 <script>x</script>' });

    const call = f.calls[0];
    expect(call.url).toBe(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
    expect(call.json.chat_id).toBe('123456789');
    expect(call.json.parse_mode).toBe('HTML');
    expect(call.json.text.startsWith('<b>Info &lt;penting&gt;</b>')).toBe(true);
    expect(call.json.text).toContain('Harga &lt; 10 &amp; stok &gt; 5 &lt;script&gt;');
    expect(call.json.text).not.toContain('<script>');
  });

  it('splits very long messages into several sends under the 4096 limit', async () => {
    const f = fakeFetch();
    const ch = createTelegramChannel(TG, { fetchImpl: f });
    const text = Array.from({ length: 40 }, (_, i) => `Paragraf ${i}: ${'isi '.repeat(60)}`).join('\n\n');
    const r = await ch.send({ to: '123456789', text });
    expect(f.calls.length).toBeGreaterThan(1);
    expect(r.parts).toBe(f.calls.length);
    for (const c of f.calls) expect(c.json.text.length).toBeLessThanOrEqual(4096);
  });

  it('sends attachments as documents (multipart)', async () => {
    const f = fakeFetch();
    const ch = createTelegramChannel(TG, { fetchImpl: f });
    const file = nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'tg-')), 'laporan.pdf');
    nodeFs.writeFileSync(file, '%PDF-1.4 isi');
    await ch.send({ to: '123456789', text: 'Terlampir', attachments: [{ filename: 'laporan.pdf', path: file, contentType: 'application/pdf' }] });

    expect(f.calls[0].url).toContain('/sendMessage');
    expect(f.calls[1].url).toContain('/sendDocument');
    expect(f.calls[1].body).toBeInstanceOf(FormData);
    expect(f.calls[1].body.get('chat_id')).toBe('123456789');
  });

  it('rejects malformed chat ids and empty messages before any request', async () => {
    const f = fakeFetch();
    const ch = createTelegramChannel(TG, { fetchImpl: f });
    await expect(ch.send({ to: 'bukan-id', text: 'x' })).rejects.toMatchObject({ kind: ErrorKind.INVALID });
    await expect(ch.send({ to: '123456789', text: '  ' })).rejects.toMatchObject({ kind: ErrorKind.INVALID });
    expect(f).not.toHaveBeenCalled();
  });

  it('classifies Telegram failures', () => {
    expect(classifyTelegram(401, { error_code: 401, description: 'Unauthorized' }).kind).toBe(ErrorKind.AUTH);

    const blocked = classifyTelegram(403, { error_code: 403, description: 'Forbidden: bot was blocked by the user' });
    expect(blocked).toMatchObject({ kind: ErrorKind.PERMANENT, hardBounce: true });

    const gone = classifyTelegram(400, { error_code: 400, description: 'Bad Request: chat not found' });
    expect(gone).toMatchObject({ kind: ErrorKind.PERMANENT, hardBounce: true });

    const flood = classifyTelegram(429, { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } });
    expect(flood).toMatchObject({ kind: ErrorKind.TRANSIENT, retryAfterMs: 7000 });

    const longBan = classifyTelegram(429, { error_code: 429, parameters: { retry_after: 900 } });
    expect(longBan.kind).toBe(ErrorKind.QUOTA);

    expect(classifyTelegram(502, null).kind).toBe(ErrorKind.TRANSIENT);
  });

  it('verify() reports the bot username', async () => {
    const f = fakeFetch(() => ({ body: { ok: true, result: { username: 'wanar_bot' } } }));
    const ch = createTelegramChannel(TG, { fetchImpl: f });
    expect(await ch.verify()).toMatchObject({ ok: true, detail: '@wanar_bot' });
  });

  it('never exposes the token in describe()', () => {
    const ch = createTelegramChannel(TG, { fetchImpl: fakeFetch() });
    expect(JSON.stringify(ch.describe())).not.toContain('AAFakeToken');
  });
});

// ----------------------------------------------------------------- whatsapp

describe('WhatsApp channel (Cloud API)', () => {
  it('simulates without credentials', async () => {
    const f = fakeFetch();
    const ch = createWhatsAppChannel({}, { fetchImpl: f });
    expect(ch.mode).toBe('dry-run');
    expect(ch.describe().missing).toEqual(['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']);
    expect((await ch.send({ to: '0812 3456 7890', text: 'Halo' })).dryRun).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it('sanitises template parameters (no newlines/tabs/long space runs)', () => {
    // a tab becomes one space, so "b<tab> c" is two spaces (allowed); 4+ collapse to 3
    expect(sanitizeTemplateParam('a\nb\t c      d')).toBe('a b  c   d');
    expect(sanitizeTemplateParam('x'.repeat(2000))).toHaveLength(1024);
  });

  it('sends a template message with the rendered text as the single variable', async () => {
    const f = fakeFetch();
    const ch = createWhatsAppChannel({ ...WA, WHATSAPP_TEMPLATE_NAME: 'pengumuman', WHATSAPP_TEMPLATE_LANG: 'id' }, { fetchImpl: f });
    const r = await ch.send({ to: '0812-3456-7890', subject: 'Rapat', text: 'Besok jam 10.\nRuang 3.' });

    const c = f.calls[0];
    expect(c.url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(c.headers.Authorization).toBe('Bearer EAAtesttoken');
    expect(c.json.to).toBe('6281234567890');
    expect(c.json.type).toBe('template');
    expect(c.json.template.name).toBe('pengumuman');
    expect(c.json.template.language.code).toBe('id');
    expect(c.json.template.components[0].parameters[0].text).toBe('Rapat - Besok jam 10. Ruang 3.');
    expect(r.mode).toBe('template');
  });

  it('sends free text in text mode with a bold subject', async () => {
    const f = fakeFetch();
    const ch = createWhatsAppChannel(WA, { fetchImpl: f });
    await ch.send({ to: '6281234567890', subject: 'Info', text: 'Halo dunia' });
    expect(f.calls[0].json.type).toBe('text');
    expect(f.calls[0].json.text.body).toBe('*Info*\n\nHalo dunia');
    expect(f.calls[0].json.text.preview_url).toBe(false);
  });

  it('reads the id from a Kirimdev-style { data: { id } } envelope', async () => {
    const f = fakeFetch(() => ({ body: { data: { id: 'msg_KIRIM1', object: 'message', to: '+6281234567890' }, request_id: 'req_1' } }));
    const ch = createWhatsAppChannel({
      WHATSAPP_TOKEN: 'kdv_live_testkey',
      WHATSAPP_PHONE_NUMBER_ID: '106540352242922',
      WHATSAPP_API_BASE: 'https://api.kirimdev.com',
      WHATSAPP_API_VERSION: 'v1',
    }, { fetchImpl: f });
    expect(ch.mode).toBe('live');
    const r = await ch.send({ to: '6281234567890', text: 'Darurat!' });
    expect(f.calls[0].url).toBe('https://api.kirimdev.com/v1/106540352242922/messages');
    expect(r).toMatchObject({ dryRun: false, mode: 'text', messageId: 'msg_KIRIM1' });
  });

  it('refuses attachments in template mode and advertises it', async () => {
    const ch = createWhatsAppChannel({ ...WA, WHATSAPP_TEMPLATE_NAME: 't' }, { fetchImpl: fakeFetch() });
    expect(ch.capabilities.attachments).toBe(false);
    await expect(ch.send({ to: '6281234567890', text: 'x', attachments: [{ filename: 'a.pdf', path: 'x' }] }))
      .rejects.toMatchObject({ kind: ErrorKind.INVALID });
  });

  it('classifies WhatsApp error codes', () => {
    const e = (code, status = 400, extra = {}) => classifyWhatsApp(status, { error: { code, message: 'm', ...extra } });
    expect(e(190, 401).kind).toBe(ErrorKind.AUTH);
    expect(e(131047)).toMatchObject({ kind: ErrorKind.PERMANENT });
    expect(e(131047).message).toMatch(/template/i);
    expect(e(131026)).toMatchObject({ kind: ErrorKind.PERMANENT, hardBounce: true });
    expect(e(131030).kind).toBe(ErrorKind.PERMANENT);
    expect(e(131056)).toMatchObject({ kind: ErrorKind.TRANSIENT, retryAfterMs: 30000 });
    expect(e(131048).kind).toBe(ErrorKind.QUOTA);
    expect(e(132001).kind).toBe(ErrorKind.CONFIG);
    expect(e(1, 503).kind).toBe(ErrorKind.TRANSIENT);
  });

  it('uploads each attachment once and reuses the media id', async () => {
    const f = fakeFetch((call) => (call.url.endsWith('/media') ? { body: { id: 'MEDIA-1' } } : {}));
    const ch = createWhatsAppChannel(WA, { fetchImpl: f });
    const file = nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wa-')), 'tarif.pdf');
    nodeFs.writeFileSync(file, '%PDF-1.4 tarif');
    const att = [{ filename: 'tarif.pdf', path: file, contentType: 'application/pdf' }];

    await ch.send({ to: '6281234567890', text: 'a', attachments: att });
    await ch.send({ to: '6289876543210', text: 'a', attachments: att });

    const uploads = f.calls.filter((c) => c.url.endsWith('/media'));
    const docs = f.calls.filter((c) => c.json?.type === 'document');
    expect(uploads).toHaveLength(1);
    expect(docs).toHaveLength(2);
    expect(docs[0].json.document.id).toBe('MEDIA-1');
  });
});

// ----------------------------------------------------------------- webhooks

describe('Webhook channels', () => {
  const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';

  it('only accepts https for Slack/Discord/Teams but allows http for the generic webhook', () => {
    expect(createWebhookChannel('slack', { SLACK_WEBHOOK_URL: 'http://hooks.slack.com/x' }).configured).toBe(false);
    expect(createWebhookChannel('slack', { SLACK_WEBHOOK_URL: SLACK }).configured).toBe(true);
    expect(createWebhookChannel('webhook', { WEBHOOK_URL: 'http://192.168.1.10:5678/hook' }).configured).toBe(true);
  });

  it('does not leak the secret path of the URL in describe()', () => {
    const d = createWebhookChannel('slack', { SLACK_WEBHOOK_URL: SLACK }).describe();
    expect(JSON.stringify(d)).not.toContain('XXXX');
    expect(d.destination).toBe('https://hooks.slack.com/…');
  });

  it('Slack: escapes control characters and bolds the subject', async () => {
    const f = fakeFetch(() => ({ body: 'ok' }));
    const ch = createWebhookChannel('slack', { SLACK_WEBHOOK_URL: SLACK }, { fetchImpl: f });
    await ch.send({ to: 'default', subject: 'Alert <!channel>', text: 'a & b <@U123>' });
    expect(f.calls[0].json.text).toBe('*Alert &lt;!channel&gt;*\na &amp; b &lt;@U123&gt;');
  });

  it('Discord: disables all mentions and waits for the message', async () => {
    const f = fakeFetch(() => ({ body: { id: '999' } }));
    const ch = createWebhookChannel('discord', { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }, { fetchImpl: f });
    const r = await ch.send({ to: 'default', subject: 'Info', text: '@everyone halo' });
    expect(f.calls[0].json.allowed_mentions).toEqual({ parse: [] });
    expect(f.calls[0].url).toContain('?wait=true');
    expect(r.messageId).toBe('999');
  });

  it('Discord: chunks messages above 2000 characters', async () => {
    const f = fakeFetch(() => ({ body: { id: '1' } }));
    const ch = createWebhookChannel('discord', { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }, { fetchImpl: f });
    await ch.send({ to: 'default', text: 'kata '.repeat(900) });
    expect(f.calls.length).toBeGreaterThan(1);
    for (const c of f.calls) expect(c.json.content.length).toBeLessThanOrEqual(2000);
  });

  it('Teams: posts an Adaptive Card', async () => {
    const f = fakeFetch(() => ({ status: 202, body: '' }));
    const ch = createWebhookChannel('teams', { TEAMS_WEBHOOK_URL: 'https://prod.westus.logic.azure.com/workflows/x' }, { fetchImpl: f });
    await ch.send({ to: 'default', subject: 'Judul', text: 'Isi pesan' });
    const att = f.calls[0].json.attachments[0];
    expect(att.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(att.content.body[0]).toMatchObject({ text: 'Judul', weight: 'Bolder' });
    expect(att.content.body[1].text).toBe('Isi pesan');
  });

  it('generic webhook: signs the exact body with HMAC-SHA256', async () => {
    const f = fakeFetch(() => ({ body: { ok: true } }));
    const ch = createWebhookChannel('webhook', {
      WEBHOOK_URL: 'https://n8n.example.com/webhook/abc', WEBHOOK_SECRET: 's3cret', WEBHOOK_BEARER_TOKEN: 'tok',
    }, { fetchImpl: f });
    await ch.send({ to: 'default', subject: 'S', text: 'T', recipient: { name: 'Budi' }, campaign: { id: 'cmp_1', name: 'Uji' } });

    const c = f.calls[0];
    const expected = `sha256=${crypto.createHmac('sha256', 's3cret').update(c.body).digest('hex')}`;
    expect(c.headers['X-Wanar-Signature']).toBe(expected);
    expect(c.headers.Authorization).toBe('Bearer tok');
    expect(c.json).toMatchObject({ event: 'wanar.message', subject: 'S', text: 'T', recipient: { name: 'Budi' }, campaign: { id: 'cmp_1' } });
  });

  it('classifies webhook failures: 410 -> config, 429 -> retry, 5xx -> transient', async () => {
    const run = (status, body = {}, headers) => createWebhookChannel('slack', { SLACK_WEBHOOK_URL: SLACK }, {
      fetchImpl: fakeFetch(() => ({ status, body, headers })),
    }).send({ to: 'default', text: 'x' });

    await expect(run(410)).rejects.toMatchObject({ kind: ErrorKind.CONFIG });
    await expect(run(404)).rejects.toMatchObject({ kind: ErrorKind.CONFIG });
    await expect(run(429, {}, { 'retry-after': '3' })).rejects.toMatchObject({ kind: ErrorKind.TRANSIENT, retryAfterMs: 3000 });
    await expect(run(503)).rejects.toMatchObject({ kind: ErrorKind.TRANSIENT });
  });

  it('rejects unknown destinations', async () => {
    const ch = createWebhookChannel('slack', { SLACK_WEBHOOK_URL: SLACK }, { fetchImpl: fakeFetch() });
    await expect(ch.send({ to: 'orang-lain', text: 'x' })).rejects.toMatchObject({ kind: ErrorKind.INVALID });
  });

  it('network failures surface as transient errors', async () => {
    const ch = createWebhookChannel('slack', { SLACK_WEBHOOK_URL: SLACK }, {
      fetchImpl: vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }),
    });
    await expect(ch.send({ to: 'default', text: 'x' })).rejects.toMatchObject({ kind: ErrorKind.TRANSIENT, code: 'ECONNREFUSED' });
  });
});

// ------------------------------------------------- engine over real channels

describe('multi-channel campaign engine', () => {
  it('sends a Telegram campaign; a blocked user is failed, suppressed and unsubscribed', async () => {
    const f = fakeFetch((c) => (c.json?.chat_id === '22222'
      ? { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }
      : {}));
    const a = makeAuto({ env: TG, fetchImpl: f });
    a.store.subscribers.upsert({ channel: 'telegram', address: '22222', name: 'Blocked' });

    const { campaign, report } = a.engine.create({
      channel: 'telegram', bodyText: 'Halo {{nama|Teman}}!', recipients: 'nama,chat_id\nAni,11111\nBudi,22222\nCitra,33333',
    });
    expect(report.channel).toBe('telegram');
    expect(campaign.channel).toBe('telegram');
    a.engine.start(campaign.id);
    await a.engine.idle(campaign.id);

    expect(a.store.campaigns.get(campaign.id).stats).toMatchObject({ sent: 2, failed: 1 });
    expect(a.store.suppressions.has('telegram:22222')).toBe(true);
    expect(a.store.subscribers.get('telegram', '22222').active).toBe(0);
  });

  it('a chat channel needs no subject, but email still does', () => {
    const a = makeAuto({ env: TG, fetchImpl: fakeFetch() });
    expect(() => a.engine.create({ channel: 'telegram', bodyText: 'Halo', recipients: '123456789' })).not.toThrow();
    expect(() => a.engine.create({ channel: 'email', bodyText: 'Halo', recipients: 'a@x.com' })).toThrow(/Subjek wajib/);
  });

  it('WhatsApp: normalises and de-duplicates numbers, sends digits-only', async () => {
    const f = fakeFetch();
    const a = makeAuto({ env: WA, fetchImpl: f });
    const { campaign, report } = a.engine.create({
      channel: 'whatsapp', bodyText: 'Halo', recipients: '0812-3456-7890\n+6281234567890\n0813 9488 2490',
    });
    expect(report.valid).toBe(2);
    expect(report.duplicates).toHaveLength(1);
    a.engine.start(campaign.id);
    await a.engine.idle(campaign.id);
    expect(f.calls.map((c) => c.json.to).sort()).toEqual(['6281234567890', '6281394882490']);
  });

  it('daily caps are isolated per channel', async () => {
    const f = fakeFetch();
    const a = makeAuto({
      env: { ...WA, EMAIL_DAILY_CAP: '1', WHATSAPP_DAILY_CAP: '2' },
      fetchImpl: f,
    });

    // One live email uses up the EMAIL cap...
    const mail = a.engine.create({ subject: 'S', bodyText: 'B', recipients: 'a@x.com' });
    a.engine.start(mail.campaign.id);
    await a.engine.idle(mail.campaign.id);
    expect(a.store.campaigns.get(mail.campaign.id).stats.sent).toBe(1);

    // ...but WhatsApp still has its own full allowance of 2.
    const wa = a.engine.create({ channel: 'whatsapp', bodyText: 'Halo', recipients: '6281111111111\n6282222222222\n6283333333333' });
    a.engine.start(wa.campaign.id);
    await a.engine.idle(wa.campaign.id);
    const c = a.store.campaigns.get(wa.campaign.id);
    expect(c.stats.sent).toBe(2);
    expect(c.status).toBe(CampaignStatus.PAUSED);
    expect(c.status_reason).toBe('daily_cap');
  });

  it('honours Telegram flood-control retry_after and then succeeds', async () => {
    let n = 0;
    const f = fakeFetch(() => {
      n += 1;
      return n === 1 ? { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0.01 } } } : {};
    });
    const a = makeAuto({ env: TG, fetchImpl: f });
    const { campaign } = a.engine.create({ channel: 'telegram', bodyText: 'Halo', recipients: '123456789' });
    a.engine.start(campaign.id);
    await a.engine.idle(campaign.id);
    expect(a.store.outbox.all(campaign.id)[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('a configuration error pauses the campaign instead of failing everyone', async () => {
    const f = fakeFetch(() => ({ status: 400, body: { error: { code: 132001, message: 'Template name does not exist' } } }));
    const a = makeAuto({ env: { ...WA, WHATSAPP_TEMPLATE_NAME: 'hilang' }, fetchImpl: f });
    const { campaign } = a.engine.create({ channel: 'whatsapp', bodyText: 'Halo', recipients: '6281111111111\n6282222222222' });
    const alerts = [];
    a.engine.on('alert', (e) => alerts.push(e));
    a.engine.start(campaign.id);
    await a.engine.idle(campaign.id);

    const c = a.store.campaigns.get(campaign.id);
    expect(c.status).toBe(CampaignStatus.PAUSED);
    expect(c.status_reason).toBe('config');
    expect(c.stats).toMatchObject({ failed: 0, queued: 2 });
    expect(f.calls).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'config', messageChannel: 'whatsapp' });
  });

  it('fixed-destination channels work without any recipient list', async () => {
    const f = fakeFetch(() => ({ body: 'ok' }));
    const a = makeAuto({ env: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' }, fetchImpl: f });
    const { campaign, report } = a.engine.create({ channel: 'slack', subject: 'Deploy', bodyText: 'Versi 2.0 rilis' });
    expect(report.valid).toBe(1);
    a.engine.start(campaign.id);
    await a.engine.idle(campaign.id);
    expect(f.calls[0].json.text).toContain('Versi 2.0 rilis');
    expect(a.store.campaigns.get(campaign.id).stats.sent).toBe(1);
  });

  it('@subscribers expands to active subscribers only, at creation time', () => {
    const a = makeAuto({ env: TG, fetchImpl: fakeFetch() });
    a.store.subscribers.upsert({ channel: 'telegram', address: '11111', name: 'Ani' });
    a.store.subscribers.upsert({ channel: 'telegram', address: '22222', name: 'Budi' });
    a.store.subscribers.setActive('telegram', '22222', false);

    const { campaign } = a.engine.create({ channel: 'telegram', bodyText: 'Halo', recipients: '@subscribers\n33333' });
    expect(a.store.outbox.all(campaign.id).map((r) => r.email).sort()).toEqual(['11111', '33333']);
  });

  it('rejects attachments on a channel that cannot carry them', () => {
    const a = makeAuto({ env: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' }, fetchImpl: fakeFetch() });
    const att = a.attachments.save({ originalName: 'a.pdf', buffer: Buffer.from('%PDF') });
    expect(() => a.engine.create({ channel: 'slack', bodyText: 'x', attachmentIds: [att.id] })).toThrow(/tidak mendukung lampiran/);
  });

  it('warns about messages that will be truncated or split', () => {
    const a = makeAuto({ env: { ...WA, WHATSAPP_TEMPLATE_NAME: 't' }, fetchImpl: fakeFetch() });
    const { report } = a.engine.create({ channel: 'whatsapp', bodyText: 'x'.repeat(1500), recipients: '6281111111111' });
    expect(report.warnings.join(' ')).toMatch(/DIPOTONG/);
  });

  it('rejects an unknown channel', () => {
    const a = makeAuto({ fetchImpl: fakeFetch() });
    expect(() => a.engine.create({ channel: 'fax', bodyText: 'x', recipients: '1' })).toThrow(/Kanal tidak dikenal/);
  });

  it('SSE channel name is not overwritten by the message channel', async () => {
    const a = makeAuto({ env: TG, fetchImpl: fakeFetch() });
    const seen = [];
    a.events.on('event', (e) => seen.push(e));
    const { campaign } = a.engine.create({ channel: 'telegram', bodyText: 'Halo', recipients: '123456789' });
    a.engine.start(campaign.id);
    await a.engine.idle(campaign.id);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.channel === 'campaign')).toBe(true);
    expect(seen[0].messageChannel).toBe('telegram');
  });
});

// ------------------------------------------------------- scheduler fan-out

describe('multi-channel jobs', () => {
  const run = async (a, job) => {
    a.scheduler.runNow(job.id);
    await a.scheduler.idle();
    for (const c of a.store.campaigns.list()) await a.engine.idle(c.id);
  };

  it('one job delivers to several channels at once', async () => {
    const f = fakeFetch(() => ({ body: { ok: true, result: { message_id: 1 }, id: 'x' } }));
    const a = makeAuto({ env: { ...TG, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' }, fetchImpl: f });
    const job = a.scheduler.createJob({
      name: 'Pengumuman', type: 'email', schedule: 'daily@08:00',
      payload: {
        subject: 'Info {{tanggal}}', bodyText: 'Halo {{nama|Tim}}',
        targets: [
          { channel: 'email', recipients: 'a@x.com' },
          { channel: 'telegram', recipients: '123456789' },
          { channel: 'slack' },
        ],
      },
    }, { activate: true });

    await run(a, job);
    expect(a.sendMail).toHaveBeenCalledTimes(1);
    expect(f.calls.some((c) => c.url.includes('/sendMessage'))).toBe(true);
    expect(f.calls.some((c) => c.url.startsWith('https://hooks.slack.com'))).toBe(true);

    const campaigns = a.store.campaigns.list();
    expect(campaigns.map((c) => c.channel).sort()).toEqual(['email', 'slack', 'telegram']);
    expect(a.store.runs.forJob(job.id)[0].status).toBe('success');
  });

  it('a failing channel does not stop the others (partial success)', async () => {
    const f = fakeFetch();
    const a = makeAuto({ env: TG, fetchImpl: f });
    const job = a.scheduler.createJob({
      name: 'Parsial', type: 'email', schedule: 'daily@08:00',
      payload: {
        subject: 'S', bodyText: 'B',
        // telegram has no subscribers yet -> that target fails, email must still go
        targets: [{ channel: 'email', recipients: 'a@x.com' }, { channel: 'telegram', recipients: '@subscribers' }],
      },
    }, { activate: true });

    await run(a, job);
    expect(a.sendMail).toHaveBeenCalledTimes(1);
    const r = a.store.runs.forJob(job.id)[0];
    expect(r.status).toBe('success');
    expect(r.meta.partial).toBe(true);
    expect(r.output).toMatch(/GAGAL/);
  });

  it('ai_email writes a formal email and a short chat message, as drafts by default', async () => {
    const a = makeAuto({ env: TG, fetchImpl: fakeFetch() });
    const job = a.scheduler.createJob({
      name: 'Ringkasan', type: 'ai_email', schedule: 'daily@17:00',
      payload: {
        brief: 'ringkasan kerja hari ini',
        targets: [{ channel: 'email', recipients: 'a@x.com' }, { channel: 'telegram', recipients: '123456789' }],
      },
    }, { activate: true });
    const reviews = [];
    a.scheduler.on('review_needed', (e) => reviews.push(e));

    await run(a, job);
    const list = a.store.campaigns.list();
    expect(list).toHaveLength(2);
    expect(list.every((c) => c.status === CampaignStatus.DRAFT)).toBe(true);
    expect(reviews).toHaveLength(2);
    expect(a.sendMail).not.toHaveBeenCalled();
    // the {{nama}} placeholder was given a fallback so unnamed recipients are not skipped
    expect(list.find((c) => c.channel === 'telegram').body_text).toContain('{{nama|Bapak/Ibu}}');
  });

  it('legacy single-channel payloads keep working', () => {
    const a = makeAuto({ fetchImpl: fakeFetch() });
    const job = a.scheduler.createJob({
      name: 'Lama', type: 'email', schedule: 'daily@08:00',
      payload: { subject: 'S', bodyText: 'B', recipients: 'a@x.com' },
    });
    expect(job.payload.targets).toEqual([{ channel: 'email', recipients: [{ email: 'a@x.com', name: '' }] }]);
  });

  it('validates targets', () => {
    const a = makeAuto({ fetchImpl: fakeFetch() });
    const make = (targets) => () => a.scheduler.createJob({
      name: 'X', type: 'email', schedule: 'daily@08:00', payload: { subject: 'S', bodyText: 'B', targets },
    });
    expect(make([{ channel: 'fax', recipients: '1' }])).toThrow(/Kanal tidak dikenal/);
    expect(make([{ channel: 'telegram', recipients: 'abc' }])).toThrow(/telegram/);
    expect(make([{ channel: 'email', recipients: 'a@x.com' }, { channel: 'email', recipients: 'b@x.com' }])).toThrow(/lebih dari sekali/);
    expect(make([])).toThrow(/minimal satu kanal/);
  });
});

// -------------------------------------------------------- telegram inbox

describe('Telegram inbox (opt-in / opt-out)', () => {
  const msg = (chatId, text, extra = {}) => ({
    update_id: 1,
    message: {
      text, chat: { id: chatId, type: 'private' },
      from: { first_name: 'Budi', last_name: 'Santoso', username: 'budi' }, ...extra,
    },
  });

  function setup(env = {}) {
    const a = makeAuto({ env: { ...TG, TELEGRAM_POLLING: 'true', ...env }, fetchImpl: fakeFetch() });
    const replies = [];
    const channel = a.channels.get('telegram');
    channel.reply = vi.fn(async (chatId, html) => { replies.push({ chatId, html }); });
    const inbox = new TelegramInbox({ channel, store: a.store, env: { ...TG, TELEGRAM_POLLING: 'true', ...env } });
    return { a, inbox, replies };
  }

  it('/start subscribes the chat and replies', async () => {
    const { a, inbox, replies } = setup();
    const r = await inbox.handleUpdate(msg(55555, '/start'));
    expect(r.action).toBe('subscribed');
    expect(a.store.subscribers.get('telegram', '55555')).toMatchObject({ name: 'Budi Santoso', username: 'budi', active: 1 });
    expect(replies[0].html).toContain('Budi Santoso');
  });

  it('409 dari consumer lain: mencoba lagi berkala, bukan mematikan inbox selamanya', async () => {
    const calls = [];
    const inbox = new TelegramInbox({
      channel: {
        mode: 'live',
        async getUpdates() {
          calls.push(1);
          const e = new Error('Conflict: terminated by other getUpdates request');
          e.responseCode = 409;
          throw e;
        },
        reply: async () => {},
      },
      store: { subscribers: { upsert() {}, setActive() {}, counts: () => ({}) }, suppressions: { add() {}, remove() {} } },
      env: { TELEGRAM_POLLING: 'true', TELEGRAM_BOT_TOKEN: TG_TOKEN },
    });
    const conflicts = [];
    inbox.on('conflict', (e) => conflicts.push(e));
    expect(inbox.start()).toBe(true);
    await new Promise((r) => setTimeout(r, 80)); // first 409 handled, now in backoff
    expect(calls.length).toBe(1);
    expect(inbox.running).toBe(true);          // the old behaviour stopped the inbox here
    expect(inbox.conflictStreak).toBe(1);
    expect(inbox.status().conflicts).toBe(1);
    expect(conflicts).toHaveLength(1);         // emitted once per conflict streak

    await inbox.stop();
    const t0 = Date.now();
    while (inbox.running && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 25));
    expect(inbox.running).toBe(false);
  });

  it('merekam setiap pengirim ke memori kontak (people)', async () => {
    const { a, inbox } = setup();
    await inbox.handleUpdate(msg(55555, 'halo, ada?'));
    const p = a.store.people.get('telegram', '55555');
    expect(p).toMatchObject({ name: 'Budi Santoso', seen_count: 1, is_owner: 0 });
    expect(p.last_message).toBe('halo, ada?');
  });

  it('/stop unsubscribes AND suppresses permanently', async () => {
    const { a, inbox } = setup();
    await inbox.handleUpdate(msg(55555, '/start'));
    await inbox.handleUpdate(msg(55555, '/stop'));
    expect(a.store.subscribers.get('telegram', '55555').active).toBe(0);
    expect(a.store.suppressions.has('telegram:55555')).toBe(true);

    // campaigns skip them even if the id is pasted manually
    const { campaign } = a.engine.create({ channel: 'telegram', bodyText: 'Halo', recipients: '55555' });
    expect(a.store.outbox.all(campaign.id)[0].status).toBe('skipped');
  });

  it('/start again re-subscribes and lifts the suppression', async () => {
    const { a, inbox } = setup();
    await inbox.handleUpdate(msg(55555, '/stop'));
    await inbox.handleUpdate(msg(55555, '/start'));
    expect(a.store.subscribers.get('telegram', '55555').active).toBe(1);
    expect(a.store.suppressions.has('telegram:55555')).toBe(false);
  });

  it('enforces the join code when configured', async () => {
    const { a, inbox } = setup({ TELEGRAM_JOIN_CODE: 'rahasia' });
    expect((await inbox.handleUpdate(msg(1, '/start'))).reason).toBe('bad_code');
    expect((await inbox.handleUpdate(msg(1, '/start salah'))).reason).toBe('bad_code');
    expect(a.store.subscribers.get('telegram', '1')).toBeNull();
    expect((await inbox.handleUpdate(msg(1, '/start rahasia'))).action).toBe('subscribed');
  });

  it('enforces the allow-list when configured', async () => {
    const { a, inbox } = setup({ TELEGRAM_ALLOWED_CHAT_IDS: '10, 20' });
    expect((await inbox.handleUpdate(msg(99, '/start'))).reason).toBe('not_allowed');
    expect((await inbox.handleUpdate(msg(10, '/start'))).action).toBe('subscribed');
    expect(a.store.subscribers.get('telegram', '99')).toBeNull();
  });

  it('/id answers anyone with the chat id (handy for groups)', async () => {
    const { inbox, replies } = setup({ TELEGRAM_JOIN_CODE: 'x' });
    const r = await inbox.handleUpdate(msg(-100123, '/id'));
    expect(r.action).toBe('id');
    expect(replies[0].html).toContain('-100123');
  });

  it('ignores ordinary chatter and a failed reply does not undo the subscription', async () => {
    const { a, inbox } = setup();
    expect(await inbox.handleUpdate(msg(7, 'halo bot'))).toBeNull();
    inbox.channel.reply = vi.fn(async () => { throw new Error('boom'); });
    await inbox.handleUpdate(msg(7, '/start'));
    expect(a.store.subscribers.get('telegram', '7').active).toBe(1);
  });

  it('stays off unless explicitly enabled', () => {
    const a = makeAuto({ env: TG, fetchImpl: fakeFetch() }); // TELEGRAM_POLLING not set
    expect(a.inbox.enabled).toBe(false);
    expect(a.inbox.start()).toBe(false);
  });
});

// ============================================ real HTTP against a local mock

describe('real HTTP (local mock servers, real fetch)', async () => {
  const http = await import('node:http');
  const express = (await import('express')).default;
  const request = (await import('supertest')).default;
  const { createAutomationRouter } = await import('../src/automation/routes.js');

  let server;
  let port;
  const seen = [];

  beforeEach(async () => {
    seen.length = 0;
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        seen.push({ method: req.method, url: req.url, headers: req.headers, raw, text: raw.toString('latin1') });
        const send = (status, obj) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (/\/sendMessage$/.test(req.url) || /\/sendDocument$/.test(req.url)) return send(200, { ok: true, result: { message_id: 4242 } });
        if (/\/getMe$/.test(req.url)) return send(200, { ok: true, result: { username: 'mock_bot' } });
        if (/\/media$/.test(req.url)) return send(200, { id: 'MEDIA-77' });
        if (/\/messages$/.test(req.url)) return send(200, { messages: [{ id: 'wamid.MOCK' }] });
        return send(200, { ok: true });
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  const close = () => new Promise((r) => server.close(r));

  it('Telegram: JSON sendMessage and multipart sendDocument cross a real socket', async () => {
    const a = makeAuto({ env: { ...TG, TELEGRAM_API_BASE: `http://127.0.0.1:${port}` } }); // no fetchImpl => global fetch
    const file = a.attachments.save({ originalName: 'Daftar Harga.pdf', buffer: Buffer.from('%PDF-1.4 ISI-LAMPIRAN-UNIK'), contentType: 'application/pdf' });

    const { campaign } = a.engine.create({
      channel: 'telegram', bodyText: 'Halo <Budi> & tim', recipients: '123456789', attachmentIds: [file.id],
    });
    a.engine.start(campaign.id);
    await a.engine.idle(campaign.id);
    await close();

    expect(a.store.campaigns.get(campaign.id).stats.sent).toBe(1);

    const msg = seen.find((r) => r.url.endsWith('/sendMessage'));
    expect(msg.url).toBe(`/bot${TG_TOKEN}/sendMessage`);
    const body = JSON.parse(msg.raw.toString('utf8'));
    expect(body).toMatchObject({ chat_id: '123456789', parse_mode: 'HTML' });
    expect(body.text).toBe('Halo &lt;Budi&gt; &amp; tim');

    const doc = seen.find((r) => r.url.endsWith('/sendDocument'));
    expect(doc.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(doc.text).toContain('name="chat_id"');
    expect(doc.text).toContain('filename="Daftar Harga.pdf"');
    expect(doc.text).toContain('ISI-LAMPIRAN-UNIK');
  });

  it('WhatsApp: media is uploaded once for several recipients, then referenced', async () => {
    const a = makeAuto({ env: { ...WA, WHATSAPP_API_BASE: `http://127.0.0.1:${port}` } });
    const file = a.attachments.save({ originalName: 'tarif.pdf', buffer: Buffer.from('%PDF-1.4 TARIF'), contentType: 'application/pdf' });

    const { campaign } = a.engine.create({
      channel: 'whatsapp', bodyText: 'Terlampir tarif terbaru',
      recipients: '0812-1111-1111\n0812-2222-2222\n0812-3333-3333', attachmentIds: [file.id],
    });
    a.engine.start(campaign.id);
    await a.engine.idle(campaign.id);
    await close();

    expect(a.store.campaigns.get(campaign.id).stats.sent).toBe(3);
    expect(seen.filter((r) => r.url.endsWith('/media'))).toHaveLength(1);

    const msgs = seen.filter((r) => r.url.endsWith('/messages')).map((r) => JSON.parse(r.raw.toString('utf8')));
    expect(msgs.filter((m) => m.type === 'text')).toHaveLength(3);
    const docs = msgs.filter((m) => m.type === 'document');
    expect(docs).toHaveLength(3);
    expect(new Set(docs.map((d) => d.document.id))).toEqual(new Set(['MEDIA-77']));
    expect(seen[0].headers.authorization).toBe('Bearer EAAtesttoken');
  });

  it('generic webhook: the signature verifies against the exact bytes received', async () => {
    const a = makeAuto({ env: { WEBHOOK_URL: `http://127.0.0.1:${port}/hook`, WEBHOOK_SECRET: 'kunci-rahasia' } });
    const { campaign } = a.engine.create({ channel: 'webhook', subject: 'Deploy', bodyText: 'Rilis 2.1 selesai' });
    a.engine.start(campaign.id);
    await a.engine.idle(campaign.id);
    await close();

    const hit = seen.find((r) => r.url === '/hook');
    const expected = `sha256=${crypto.createHmac('sha256', 'kunci-rahasia').update(hit.raw).digest('hex')}`;
    expect(hit.headers['x-wanar-signature']).toBe(expected);
    expect(JSON.parse(hit.raw.toString('utf8'))).toMatchObject({ event: 'wanar.message', subject: 'Deploy', text: 'Rilis 2.1 selesai' });
  });

  it('a dead endpoint becomes a transient failure, not a crash', async () => {
    await close(); // nothing listening any more
    const a = makeAuto({ env: { ...TG, TELEGRAM_API_BASE: `http://127.0.0.1:${port}`, EMAIL_MAX_ATTEMPTS: '2' } });
    const { campaign } = a.engine.create({ channel: 'telegram', bodyText: 'Halo', recipients: '123456789' });
    a.engine.start(campaign.id);
    await a.engine.idle(campaign.id);
    const row = a.store.outbox.all(campaign.id)[0];
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(2);
    expect(row.last_error).toMatch(/terhubung|ECONNREFUSED/i);
  });

  it('HTTP API: channel status, test endpoint, subscribers, channel-aware parse and campaigns', async () => {
    await close();
    const a = makeAuto({ env: TG }); // Telegram configured, but never contacted here
    const app = express();
    app.use(express.json());
    app.use('/api/automation', createAutomationRouter({ automation: a }));

    const list = await request(app).get('/api/automation/channels').expect(200);
    expect(list.body.channels.map((c) => c.id)).toEqual(['email', 'telegram', 'whatsapp', 'slack', 'discord', 'teams', 'webhook']);
    expect(list.body.channels.find((c) => c.id === 'telegram').mode).toBe('live');
    expect(list.body.channels.find((c) => c.id === 'whatsapp').mode).toBe('dry-run');
    expect(JSON.stringify(list.body)).not.toContain('AAFakeToken');

    // unconfigured channel: explains instead of pretending
    const test = await request(app).post('/api/automation/channels/whatsapp/test').send({ to: '0812-3456-7890' }).expect(200);
    expect(test.body).toMatchObject({ success: false, mode: 'dry-run' });
    expect(test.body.missing).toContain('WHATSAPP_TOKEN');
    await request(app).post('/api/automation/channels/fax/test').send({}).expect(404);
    await request(app).post('/api/automation/channels/telegram/test').send({ to: 'bukan-id' }).expect(400);

    // subscribers
    await request(app).post('/api/automation/subscribers/telegram').send({ address: '987654321', name: 'Ani' }).expect(201);
    await request(app).post('/api/automation/subscribers/telegram').send({ address: 'x' }).expect(400);
    await request(app).post('/api/automation/subscribers/slack').send({ address: 'default' }).expect(400);
    const subs = await request(app).get('/api/automation/subscribers/telegram').expect(200);
    expect(subs.body.counts).toEqual({ total: 1, active: 1 });
    expect(subs.body.subscribers[0]).toMatchObject({ address: '987654321', name: 'Ani' });

    // channel-aware parsing
    const parsed = await request(app).post('/api/automation/recipients/parse')
      .send({ text: '0812-3456-7890\n+6281234567890\nabc', channel: 'whatsapp' }).expect(200);
    expect(parsed.body).toMatchObject({ valid: 1, duplicateCount: 1, invalidCount: 1, channel: 'whatsapp' });
    expect(parsed.body.sample[0].email).toBe('6281234567890');

    // campaign over a chat channel, using @subscribers
    const made = await request(app).post('/api/automation/campaigns').send({
      channel: 'telegram', bodyText: 'Halo {{nama|Teman}}', recipients: '@subscribers',
    }).expect(201);
    expect(made.body.campaign.channel).toBe('telegram');
    expect(made.body.report.valid).toBe(1);
    expect(made.body.preview[0].text).toBe('Halo Ani');

    // overview carries the channel cards
    const ov = await request(app).get('/api/automation/overview').expect(200);
    expect(ov.body.channels).toHaveLength(7);

    await request(app).delete('/api/automation/subscribers/telegram/987654321').expect(200);
  });
});

// ===================================================== all-channel template package

describe('AI template package (one brief -> every channel)', async () => {
  const { parsePackage, generatePackage } = await import('../src/automation/ai-compose.js');
  const express = (await import('express')).default;
  const request = (await import('supertest')).default;
  const { createAutomationRouter } = await import('../src/automation/routes.js');

  const ALL = ['email', 'telegram', 'whatsapp', 'slack', 'discord', 'teams', 'webhook'];
  const aiReturning = (obj) => ({
    async *chatStream() {
      yield { type: 'content', content: typeof obj === 'string' ? obj : JSON.stringify(obj) };
      yield { type: 'done' };
    },
  });

  const FULL = {
    name: 'Rapat Evaluasi Jumat',
    email: { subject: 'Undangan Rapat Evaluasi', body: 'Yth. {{nama}},\n\nRapat evaluasi Jumat pukul 10.00.\n\nSalam.' },
    telegram: { body: 'Halo {{nama}}! Rapat evaluasi Jumat jam 10.00.' },
    whatsapp: { body: 'Halo {{nama}}, rapat evaluasi Jumat 10.00.' },
    slack: { body: 'Halo {{nama|Bapak/Ibu}}, rapat evaluasi Jumat 10.00 di lantai 3.' },
    discord: { body: 'Rapat evaluasi Jumat 10.00.' },
    teams: { body: 'Rapat evaluasi Jumat 10.00.' },
    webhook: { body: 'Rapat evaluasi dijadwalkan Jumat 10.00.' },
  };

  it('parses a full package, including fenced JSON and bare-string channels', () => {
    const p = parsePackage('Ini hasilnya:\n```json\n' + JSON.stringify({ name: 'X', email: { subject: 'S', body: 'B' }, telegram: 'T' }) + '\n```');
    expect(p.name).toBe('X');
    expect(p.drafts.email).toEqual({ subject: 'S', body: 'B' });
    expect(p.drafts.telegram).toEqual({ subject: '', body: 'T' });
    expect(parsePackage('bukan json')).toBeNull();
  });

  it('returns a template for EVERY channel and a campaign name', async () => {
    const out = await generatePackage(aiReturning(FULL), { brief: 'undang rapat evaluasi Jumat 10.00' });
    expect(out.name).toBe('Rapat Evaluasi Jumat');
    expect(Object.keys(out.drafts).sort()).toEqual([...ALL].sort());
    expect(out.drafts.email.subject).toBe('Undangan Rapat Evaluasi');
    for (const ch of ALL) expect(out.drafts[ch].body.length).toBeGreaterThan(0);
  });

  it('guarantees name fallbacks for people, and a neutral greeting for team channels', async () => {
    const out = await generatePackage(aiReturning(FULL), { brief: 'x' });
    expect(out.drafts.email.body).toContain('{{nama|Bapak/Ibu}}');
    expect(out.drafts.telegram.body).toContain('{{nama|Bapak/Ibu}}');
    expect(out.drafts.whatsapp.body).toContain('{{nama|Bapak/Ibu}}');
    // a shared channel has no individual: never "Halo Bapak/Ibu"
    expect(out.drafts.slack.body).toBe('Halo Tim, rapat evaluasi Jumat 10.00 di lantai 3.');
    expect(out.drafts.slack.body).not.toContain('{{');
  });

  it('fills channels the model skipped so no form is left empty', async () => {
    const partial = { name: 'N', email: { subject: 'S', body: 'Isi email' }, telegram: { body: 'Pesan singkat' } };
    const out = await generatePackage(aiReturning(partial), { brief: 'x' });
    // person-facing channels get the personal greeting; team channels stay as written
    expect(out.drafts.whatsapp.body).toContain('Pesan singkat');
    expect(out.drafts.whatsapp.body).toContain('{{nama|Bapak/Ibu}}');
    expect(out.drafts.discord.body).toBe('Pesan singkat');
    expect(Object.keys(out.drafts)).toHaveLength(7);
  });

  it('falls back to a name derived from the brief', async () => {
    const out = await generatePackage(aiReturning({ email: { subject: 'S', body: 'B' } }), { brief: 'Pengumuman libur nasional' });
    expect(out.name).toBe('Pengumuman libur nasional');
  });

  it('rejects an empty brief and unreadable output', async () => {
    await expect(generatePackage(aiReturning(FULL), { brief: '  ' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(generatePackage(aiReturning('maaf saya tidak bisa'), { brief: 'x' })).rejects.toMatchObject({ code: 'unparseable' });
  });

  it('POST /compose/package returns the package over HTTP', async () => {
    const a = makeAuto({ ai: aiReturning(FULL), fetchImpl: fakeFetch() });
    const app = express();
    app.use(express.json());
    app.use('/api/automation', createAutomationRouter({ automation: a }));

    const r = await request(app).post('/api/automation/compose/package').send({ brief: 'undang rapat' }).expect(200);
    expect(r.body.success).toBe(true);
    expect(r.body.name).toBe('Rapat Evaluasi Jumat');
    expect(Object.keys(r.body.drafts)).toHaveLength(7);
    await request(app).post('/api/automation/compose/package').send({ brief: '' }).expect(400);
  });
});

// ========================================== guaranteed personal greeting

describe('ensurePersonalGreeting', async () => {
  const { ensurePersonalGreeting, generatePackage } = await import('../src/automation/ai-compose.js');

  it('turns a bare "Bapak/Ibu," greeting into a personalised one (the real failure we saw)', () => {
    expect(ensurePersonalGreeting('Bapak/Ibu,\n\nRapat Jumat.\n\nSalam,', 'email'))
      .toBe('Yth. {{nama|Bapak/Ibu}},\n\nRapat Jumat.\n\nSalam,');
    expect(ensurePersonalGreeting('Bapak/Ibu, Rapat Jumat jam 10.', 'telegram'))
      .toBe('Halo {{nama|Bapak/Ibu}}, Rapat Jumat jam 10.');
  });

  it('handles "Yth. Bapak/Ibu", "Halo Ibu" and similar generic openers', () => {
    expect(ensurePersonalGreeting('Yth. Bapak/Ibu,\nIsi', 'email')).toBe('Yth. {{nama|Bapak/Ibu}},\n\nIsi');
    expect(ensurePersonalGreeting('Halo Ibu, tagihan Anda', 'whatsapp')).toBe('Halo {{nama|Bapak/Ibu}}, tagihan Anda');
  });

  it('prepends a greeting when there is none', () => {
    expect(ensurePersonalGreeting('Rapat Jumat jam 10.', 'email')).toBe('Yth. {{nama|Bapak/Ibu}},\n\nRapat Jumat jam 10.');
    expect(ensurePersonalGreeting('Rapat Jumat jam 10.', 'whatsapp')).toBe('Halo {{nama|Bapak/Ibu}}! Rapat Jumat jam 10.');
  });

  it('leaves already-personalised text and empty text alone', () => {
    const ok = 'Yth. {{nama|Bapak/Ibu}},\n\nIsi';
    expect(ensurePersonalGreeting(ok, 'email')).toBe(ok);
    expect(ensurePersonalGreeting('Halo {{ name }}!', 'telegram')).toBe('Halo {{ name }}!');
    expect(ensurePersonalGreeting('  ', 'email')).toBe('  ');
  });

  it('does not touch a real name that merely starts with "Bapak"', () => {
    // "Bapak Budi," is a specific person => still prepend, never swallow the name
    const out = ensurePersonalGreeting('Bapak Budi, mohon konfirmasi', 'telegram');
    expect(out).toContain('{{nama|Bapak/Ibu}}');
  });

  it('every person-facing channel of a package is personalised, team channels are not', async () => {
    const bare = {
      name: 'N',
      email: { subject: 'S', body: 'Bapak/Ibu,\n\nIsi email.\n\nSalam,' },
      telegram: { body: 'Bapak/Ibu, isi telegram' },
      whatsapp: { body: 'Isi whatsapp tanpa sapaan' },
      slack: { body: 'Isi slack' }, discord: { body: 'd' }, teams: { body: 't' }, webhook: { body: 'w' },
    };
    const ai = { async *chatStream() { yield { type: 'content', content: JSON.stringify(bare) }; yield { type: 'done' }; } };
    const out = await generatePackage(ai, { brief: 'x' });
    for (const ch of ['email', 'telegram', 'whatsapp']) expect(out.drafts[ch].body).toContain('{{nama|Bapak/Ibu}}');
    for (const ch of ['slack', 'discord', 'teams', 'webhook']) expect(out.drafts[ch].body).not.toContain('{{');
    expect(out.drafts.email.body.startsWith('Yth. {{nama|Bapak/Ibu}},')).toBe(true);
  });
});

// ==================================== failover: do not hammer a dead provider

describe('failover walks the chain intelligently', async () => {
  const { SmartFailover, FailReason } = await import('../src/ai-failover.js');
  const { default: AIManager } = await import('../src/ai-manager.js');
  const { collectParsed, parsePackage, generatePackage } = await import('../src/automation/ai-compose.js');

  const models = (...ids) => ({ models: ids.map((id) => ({ id })) });

  it('a rejected credential marks the WHOLE provider down, and success clears it', () => {
    const fo = new SmartFailover({ a: { defaultModel: 'a1' } }, { a: models('a1', 'a2', 'a3') });
    expect(fo.shouldSkip('a', 'a2')).toBe(false);
    fo.markFailure('a', 'a1', FailReason.AUTH);
    expect(fo.isProviderDown('a')).toBe(true);
    expect(fo.shouldSkip('a', 'a2')).toBe(true);
    expect(fo.shouldSkip('a', 'a3')).toBe(true);
    fo.markSuccess('a', 'a1');
    expect(fo.isProviderDown('a')).toBe(false);
  });

  it('a quota/rate failure on one model does not condemn the others', () => {
    const fo = new SmartFailover({}, {});
    fo.markFailure('a', 'a1', FailReason.QUOTA);
    expect(fo.shouldSkip('a', 'a1')).toBe(true);
    expect(fo.shouldSkip('a', 'a2')).toBe(false);
  });

  function manager(providers, cfg) {
    const ai = new AIManager();
    ai.providers = providers;
    ai.failover = new SmartFailover(providers, cfg);
    ai.currentProvider = 'a';
    return ai;
  }
  const drain = async (gen) => {
    const out = [];
    for await (const e of gen) out.push(e);
    return out;
  };

  it('stops after ONE auth failure instead of trying every model of that provider', async () => {
    let aCalls = 0;
    const a = {
      defaultModel: 'a1',
      isAvailable: () => true,
      async *chatStream() { aCalls += 1; yield { type: 'error', content: 'Request failed with status code 401 unauthorized' }; },
    };
    const b = {
      defaultModel: 'b1',
      isAvailable: () => true,
      async *chatStream() { yield { type: 'content', content: 'dari B' }; yield { type: 'done' }; },
    };
    const ai = manager({ a, b }, { a: models('a1', 'a2', 'a3', 'a4', 'a5'), b: models('b1') });

    const events = await drain(ai.chatStream([{ role: 'user', content: 'hai' }], { provider: 'a', model: 'a1' }));
    expect(events.filter((e) => e.type === 'content').map((e) => e.content).join('')).toBe('dari B');
    expect(aCalls).toBe(1); // before the fix: 5
  });

  it('opens the circuit after repeated rate limits rather than walking all models', async () => {
    let aCalls = 0;
    const many = Array.from({ length: 30 }, (_, i) => `a${i + 1}`);
    const a = {
      defaultModel: 'a1',
      isAvailable: () => true,
      async *chatStream() { aCalls += 1; yield { type: 'error', content: 'Request failed with status code 429 rate limit' }; },
    };
    const b = {
      defaultModel: 'b1',
      isAvailable: () => true,
      async *chatStream() { yield { type: 'content', content: 'ok' }; yield { type: 'done' }; },
    };
    const ai = manager({ a, b }, { a: models(...many), b: models('b1') });

    await drain(ai.chatStream([{ role: 'user', content: 'hai' }], { provider: 'a', model: 'a1' }));
    expect(aCalls).toBeLessThanOrEqual(5); // circuit threshold is 4; before the fix: 30
  });

  it('collectParsed retries ONCE with a correction when the reply is not JSON', async () => {
    const seen = [];
    let n = 0;
    const ai = {
      async *chatStream(messages) {
        n += 1;
        seen.push(messages.length);
        yield { type: 'content', content: n === 1 ? 'Maaf, boleh jelaskan lebih detail?' : '{"name":"X","email":{"subject":"S","body":"B"}}' };
        yield { type: 'done' };
      },
    };
    const r = await collectParsed(ai, [{ role: 'user', content: 'u' }], {}, parsePackage);
    expect(r.parsed.name).toBe('X');
    expect(r.attempts).toBe(2);
    expect(seen).toEqual([1, 3]); // second call carried the bad answer + correction
  });

  it('gives up after the single retry instead of looping', async () => {
    let n = 0;
    const ai = { async *chatStream() { n += 1; yield { type: 'content', content: 'bukan json' }; yield { type: 'done' }; } };
    await expect(generatePackage(ai, { brief: 'x' })).rejects.toMatchObject({ code: 'unparseable' });
    expect(n).toBe(2);
  });
});

describe('team channels never greet "Bapak/Ibu"', async () => {
  const { generatePackage } = await import('../src/automation/ai-compose.js');

  it('rewrites a generic opener on Slack/Discord/Teams to "Halo Tim," and leaves webhooks alone', async () => {
    const raw = {
      name: 'N',
      email: { subject: 'S', body: 'Yth. {{nama|Bapak/Ibu}},\n\nIsi' },
      telegram: { body: 'Halo {{nama|Bapak/Ibu}}, isi' },
      whatsapp: { body: 'Halo {{nama|Bapak/Ibu}}, isi' },
      slack: { body: 'Bapak/Ibu,\nServer maintenance Sabtu.' },
      discord: { body: 'Yth. Bapak/Ibu, server maintenance Sabtu.' },
      teams: { body: 'Halo {{nama|Bapak/Ibu}}, server maintenance Sabtu.' },
      webhook: { body: 'Server maintenance Sabtu.' },
    };
    const ai = { async *chatStream() { yield { type: 'content', content: JSON.stringify(raw) }; yield { type: 'done' }; } };
    const { drafts } = await generatePackage(ai, { brief: 'x' });

    expect(drafts.slack.body).toBe('Halo Tim,\nServer maintenance Sabtu.');
    expect(drafts.discord.body).toBe('Halo Tim, server maintenance Sabtu.');
    expect(drafts.teams.body).toBe('Halo Tim, server maintenance Sabtu.');
    expect(drafts.webhook.body).toBe('Server maintenance Sabtu.');
    for (const ch of ['slack', 'discord', 'teams']) expect(drafts[ch].body).not.toMatch(/Bapak\/Ibu/);
  });
});

// ================================================= Telegram AI chat replies

describe('Telegram inbox: AI chat replies', () => {
  const OWNER = '1811580954';
  const privateMsg = (chatId, text, type = 'private') => ({
    update_id: 1,
    message: { text, chat: { id: Number(chatId), type }, from: { first_name: 'Wisnu' } },
  });

  function setup({ env = {}, responder } = {}) {
    const a = makeAuto({ env: { ...TG, ...env }, fetchImpl: fakeFetch() });
    const sent = [];
    const channel = a.channels.get('telegram');
    channel.reply = vi.fn(async (chatId, html) => { sent.push({ chatId: String(chatId), html }); });
    channel.sendAction = vi.fn(async () => {});
    const resp = responder || vi.fn(async ({ text }) => `Jawaban untuk: ${text}`);
    const inbox = new TelegramInbox({
      channel, store: a.store, env: { ...TG, ...env }, responder: resp,
    });
    return { a, inbox, sent, channel, resp };
  }

  it('answers a plain message from an allow-listed private chat', async () => {
    const { inbox, sent, resp, channel } = setup({ env: { TELEGRAM_AI_CHAT_IDS: OWNER } });
    const r = await inbox.handleUpdate(privateMsg(OWNER, 'halo, apa kabar?'));
    expect(r.action).toBe('ai_reply');
    await r.done;

    expect(resp).toHaveBeenCalledTimes(1);
    expect(channel.sendAction).toHaveBeenCalledWith(OWNER, 'typing');
    expect(sent).toEqual([{ chatId: OWNER, html: 'Jawaban untuk: halo, apa kabar?' }]);
  });

  it('is OFF by default: no allow-list means no AI replies at all', async () => {
    const { inbox, sent, resp } = setup(); // TELEGRAM_AI_CHAT_IDS unset
    expect(await inbox.handleUpdate(privateMsg(OWNER, 'halo'))).toBeNull();
    expect(resp).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(inbox.status().aiChat).toEqual({ enabled: false, chats: 0 });
  });

  it('ignores strangers, even though the bot is public', async () => {
    const { inbox, sent, resp } = setup({ env: { TELEGRAM_AI_CHAT_IDS: OWNER } });
    expect(await inbox.handleUpdate(privateMsg('99999999', 'halo'))).toBeNull();
    expect(resp).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('ignores groups, even an allow-listed group id', async () => {
    const { inbox, resp } = setup({ env: { TELEGRAM_AI_CHAT_IDS: '-1001234567890' } });
    expect(await inbox.handleUpdate(privateMsg('-1001234567890', 'halo', 'supergroup'))).toBeNull();
    expect(resp).not.toHaveBeenCalled();
  });

  it('keeps commands out of the AI: /start still subscribes', async () => {
    const { a, inbox, resp } = setup({ env: { TELEGRAM_AI_CHAT_IDS: OWNER } });
    const r = await inbox.handleUpdate(privateMsg(OWNER, '/start'));
    expect(r.action).toBe('subscribed');
    expect(resp).not.toHaveBeenCalled();
    expect(a.store.subscribers.get('telegram', OWNER).active).toBe(1);
  });

  it('remembers the conversation and caps how much', async () => {
    const seen = [];
    const { inbox } = setup({
      env: { TELEGRAM_AI_CHAT_IDS: OWNER },
      responder: async ({ history, text }) => { seen.push(history.map((h) => h.content)); return `balas ${text}`; },
    });
    for (const t of ['satu', 'dua', 'tiga']) {
      const r = await inbox.handleUpdate(privateMsg(OWNER, t));
      await r.done;
    }
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual(['satu', 'balas satu']);
    expect(seen[2]).toEqual(['satu', 'balas satu', 'dua', 'balas dua']);

    for (let i = 0; i < 10; i++) await (await inbox.handleUpdate(privateMsg(OWNER, `m${i}`))).done;
    expect(inbox._historyFor(OWNER).length).toBeLessThanOrEqual(12);
  });

  it('escapes the answer so model output cannot inject Telegram HTML', async () => {
    const { inbox, sent } = setup({
      env: { TELEGRAM_AI_CHAT_IDS: OWNER },
      responder: async () => 'Coba <b>tebal</b> & <a href="http://evil">klik</a>',
    });
    await (await inbox.handleUpdate(privateMsg(OWNER, 'x'))).done;
    expect(sent[0].html).toBe('Coba &lt;b&gt;tebal&lt;/b&gt; &amp; &lt;a href="http://evil"&gt;klik&lt;/a&gt;');
  });

  it('splits long answers into several messages under the limit', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `Paragraf ${i}: ${'isi '.repeat(60)}`).join('\n\n');
    const { inbox, sent } = setup({ env: { TELEGRAM_AI_CHAT_IDS: OWNER }, responder: async () => long });
    await (await inbox.handleUpdate(privateMsg(OWNER, 'panjang'))).done;
    expect(sent.length).toBeGreaterThan(1);
    for (const m of sent) expect(m.html.length).toBeLessThanOrEqual(4096);
  });

  it('answers politely (and never leaks the error) when the AI fails', async () => {
    const { inbox, sent } = setup({
      env: { TELEGRAM_AI_CHAT_IDS: OWNER },
      responder: async () => { throw new Error('401 sk-SECRET-KEY invalid'); },
    });
    await (await inbox.handleUpdate(privateMsg(OWNER, 'halo'))).done;
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toMatch(/AI sedang tidak tersedia/);
    expect(sent[0].html).not.toMatch(/SECRET|401/);
  });

  it('does not block polling while a slow model is thinking', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { inbox, sent } = setup({
      env: { TELEGRAM_AI_CHAT_IDS: OWNER },
      responder: async () => { await gate; return 'lambat tapi sampai'; },
    });
    const r = await inbox.handleUpdate(privateMsg(OWNER, 'halo')); // returns immediately
    expect(r.action).toBe('ai_reply');
    expect(sent).toHaveLength(0);
    release();
    await r.done;
    expect(sent[0].html).toBe('lambat tapi sampai');
  });

  it('keeps answers in order per chat', async () => {
    const order = [];
    const { inbox } = setup({
      env: { TELEGRAM_AI_CHAT_IDS: OWNER },
      responder: async ({ text }) => {
        await new Promise((r) => setTimeout(r, text === 'pertama' ? 40 : 1));
        order.push(text);
        return text;
      },
    });
    const a = await inbox.handleUpdate(privateMsg(OWNER, 'pertama'));
    const b = await inbox.handleUpdate(privateMsg(OWNER, 'kedua'));
    await Promise.all([a.done, b.done]);
    expect(order).toEqual(['pertama', 'kedua']);
  });

  it('rate-limits a chat that floods the AI', async () => {
    const { inbox, resp, sent } = setup({ env: { TELEGRAM_AI_CHAT_IDS: OWNER } });
    const results = [];
    for (let i = 0; i < 22; i++) results.push(await inbox.handleUpdate(privateMsg(OWNER, `m${i}`)));
    await Promise.all(results.filter((r) => r.done).map((r) => r.done));
    expect(resp).toHaveBeenCalledTimes(20);
    expect(results.filter((r) => r.action === 'rate_limited')).toHaveLength(2);
    expect(sent.some((m) => /Terlalu banyak pesan/.test(m.html))).toBe(true);
  });

  it('reports AI chat as enabled in status when allow-listed', () => {
    const { inbox } = setup({ env: { TELEGRAM_AI_CHAT_IDS: `${OWNER}, 222222` } });
    expect(inbox.status().aiChat).toEqual({ enabled: true, chats: 2 });
  });

  // Shared locations: these are not text, and they may become named places.

  const pinMsg = (chatId, extra = {}) => ({
    update_id: 7,
    message: {
      chat: { id: Number(chatId), type: 'private' }, from: { first_name: 'Wisnu' },
      location: { latitude: -6.2383, longitude: 106.9756 }, ...extra,
    },
  });

  it('offers to save a shared location pin from the owner', async () => {
    const { inbox, sent } = setup({ env: { TELEGRAM_AI_CHAT_IDS: OWNER } });
    const calls = [];
    inbox.onLocationPin = async (pin) => { calls.push(pin); return '📍 Lokasi diterima. Balas: simpan lokasi ini sebagai <nama>.'; };
    const r = await inbox.handleUpdate(pinMsg(OWNER));
    expect(r).toEqual({ action: 'location', chatId: OWNER });
    expect(calls).toEqual([{ chatId: OWNER, lat: -6.2383, lon: 106.9756, title: null, person: 'Wisnu' }]);
    expect(sent).toEqual([{ chatId: OWNER, html: '📍 Lokasi diterima. Balas: simpan lokasi ini sebagai &lt;nama&gt;.' }]);
  });

  it('passes a venue title through and escapes the reply', async () => {
    const { inbox, sent } = setup({ env: { TELEGRAM_AI_CHAT_IDS: OWNER } });
    let got = null;
    inbox.onLocationPin = async (pin) => { got = pin; return 'Simpan <b>"Kopi"</b>?'; };
    const r = await inbox.handleUpdate({
      update_id: 8,
      message: {
        chat: { id: Number(OWNER), type: 'private' }, from: { first_name: 'Wisnu' },
        venue: { title: 'Kopi Tuku', location: { latitude: -6.9, longitude: 107.6 } },
      },
    });
    expect(r.action).toBe('location');
    expect(got).toMatchObject({ chatId: OWNER, title: 'Kopi Tuku', lat: -6.9, lon: 107.6 });
    expect(sent[0].html).toBe('Simpan &lt;b&gt;"Kopi"&lt;/b&gt;?');
  });

  it('never reacts to a pin from a stranger, group, or without a handler', async () => {
    const { inbox, sent, resp } = setup({ env: { TELEGRAM_AI_CHAT_IDS: OWNER } });
    const calls = [];
    inbox.onLocationPin = async (pin) => { calls.push(pin); return 'x'; };
    // Strangers are ignored exactly like their text messages: no reaction at all.
    expect(await inbox.handleUpdate(pinMsg('99999999'))).toBeNull();
    expect(await inbox.handleUpdate(pinMsg(OWNER, { chat: { id: Number(OWNER), type: 'supergroup' } }))).toBeNull();
    expect(calls).toHaveLength(0);

    const noHandler = setup({ env: { TELEGRAM_AI_CHAT_IDS: OWNER } }).inbox; // onLocationPin not wired
    expect((await noHandler.handleUpdate(pinMsg(OWNER))).action).toBe('location_ignored');
    expect(resp).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe('a known-dead primary provider is not retried on every request', async () => {
  const { SmartFailover } = await import('../src/ai-failover.js');
  const { default: AIManager } = await import('../src/ai-manager.js');

  it('second request skips the primary whose key was rejected', async () => {
    let aCalls = 0;
    const a = { defaultModel: 'a1', isAvailable: () => true, async *chatStream() { aCalls += 1; yield { type: 'error', content: '403 forbidden invalid api key' }; } };
    const b = { defaultModel: 'b1', isAvailable: () => true, async *chatStream() { yield { type: 'content', content: 'B' }; yield { type: 'done' }; } };
    const ai = new AIManager();
    ai.providers = { a, b };
    ai.failover = new SmartFailover(ai.providers, { a: { models: [{ id: 'a1' }] }, b: { models: [{ id: 'b1' }] } });
    ai.currentProvider = 'a';

    const run = async () => { const out = []; for await (const e of ai.chatStream([{ role: 'user', content: 'x' }], { provider: 'a', model: 'a1' })) out.push(e); return out; };
    await run();
    await run();
    await run();
    expect(aCalls).toBe(1); // before: 3 (once per request)
  });
});

describe('Telegram AI persona: talks TO the owner, knows its real abilities', async () => {
  const { makeChatResponder } = await import('../src/automation/telegram-inbox.js');

  it('tells the model the person in the chat IS the owner, and lists the installed commands', async () => {
    let seen = '';
    const ai = { async *chatStream(_m, opts) { seen = opts.systemPrompt; yield { type: 'content', content: 'ok' }; yield { type: 'done' }; } };
    const respond = makeChatResponder({ aiManager: ai, ownerName: 'Wisnu Alfian Nur Ashar', context: () => 'Data jurnal: 0 jam.' });
    await respond({ history: [], text: 'kamu siapa', commands: ['/mulai — mulai bekerja', '/catat — catat bebas'] });

    expect(seen).toMatch(/ADALAH Wisnu Alfian Nur Ashar sendiri/);
    expect(seen).toMatch(/JANGAN menyebut Wisnu sebagai orang ketiga/);
    expect(seen).toMatch(/JANGAN pernah menjanjikan tindakan nanti/);
    expect(seen).toContain('/mulai — mulai bekerja');
    expect(seen).toContain('Data jurnal: 0 jam.');
  });

  it('the inbox passes its real command list to the responder', async () => {
    const calls = [];
    const inbox = new TelegramInbox({
      channel: { mode: 'live', reply: async () => {}, sendAction: async () => {} },
      store: { subscribers: { upsert() {}, setActive() {}, counts: () => ({}) }, suppressions: { add() {}, remove() {} } },
      env: { TELEGRAM_AI_CHAT_IDS: '1811580954' },
      responder: async (args) => { calls.push(args); return 'halo'; },
    });
    inbox.registerCommands({ mulai: { description: 'mulai bekerja', run: async () => 'ok' } });
    const r = await inbox.handleUpdate({ update_id: 1, message: { text: 'apa saja tugas kamu?', chat: { id: 1811580954, type: 'private' }, from: { first_name: 'Wisnu' } } });
    await r.done;
    expect(calls[0].commands).toEqual(expect.arrayContaining(['/mulai — mulai bekerja', '/help — daftar perintah']));
  });
});

describe('Telegram guest mode: communication only, never owner powers', async () => {
  const { makeGuestResponder } = await import('../src/automation/telegram-inbox.js');
  const OWNER = '1811580954';
  const GUEST = '777000111';

  const build = ({ replies = [], responder = async () => 'pemilik', guestResponder = async () => 'tamu', env = {} } = {}) => new TelegramInbox({
    channel: { mode: 'live', reply: async (to, html) => replies.push({ to, html }), sendAction: async () => {} },
    store: { subscribers: { upsert() {}, setActive() {}, counts: () => ({}) }, suppressions: { add() {}, remove() {} } },
    env: { TELEGRAM_AI_CHAT_IDS: OWNER, TELEGRAM_GUEST_CHAT_IDS: GUEST, ...env },
    responder,
    guestResponder,
  });

  const guestMessage = (text, id = GUEST, update_id = 1) => ({
    update_id,
    message: { text, chat: { id: Number(id), type: 'private' }, from: { first_name: 'Zahra' } },
  });

  it('answers a guest with the guest responder, flags it, and hides owner commands', async () => {
    const replies = [];
    const guestCalls = [];
    const exchanges = [];
    const inbox = build({
      replies,
      guestResponder: async (args) => { guestCalls.push(args); return 'Halo, saya AI-nya Wisnu.'; },
    });
    inbox.registerCommands({ rahasia: { description: 'data pemilik', run: async () => 'rahasia' } });
    inbox.onExchange = (e) => exchanges.push(e);

    const r = await inbox.handleUpdate(guestMessage('halo'));
    await r.done;

    expect(r.guest).toBe(true);
    expect(replies.map((x) => x.html)).toContain('Halo, saya AI-nya Wisnu.');
    expect(guestCalls[0].commands).toEqual(['/id — tampilkan Chat ID']);
    expect(guestCalls[0].commands.join(' ')).not.toContain('/rahasia');
    expect(exchanges[0].guest).toBe(true);
  });

  it('never runs owner-only commands for a guest', async () => {
    const replies = [];
    let ran = 0;
    const inbox = build({ replies });
    inbox.registerCommands({ mulai: { description: 'mulai bekerja', run: async () => { ran += 1; return 'mulai'; } } });

    const r = await inbox.handleUpdate(guestMessage('/mulai', GUEST, 2));

    expect(r).toBeNull();
    expect(ran).toBe(0);
    expect(replies).toHaveLength(0);
  });

  it('keeps owner powers when a chat appears in both lists', async () => {
    const replies = [];
    const inbox = build({
      replies,
      env: { TELEGRAM_AI_CHAT_IDS: GUEST, TELEGRAM_GUEST_CHAT_IDS: GUEST },
      responder: async () => 'jawaban pemilik',
      guestResponder: async () => 'jawaban tamu',
    });

    const r = await inbox.handleUpdate(guestMessage('halo', GUEST, 3));
    await r.done;

    expect(r.guest).toBe(false);
    expect(replies[0].html).toBe('jawaban pemilik');
  });

  it('does not subscribe a guest to broadcasts, but says chatting still works', async () => {
    const replies = [];
    const inbox = build({ replies });

    const r = await inbox.handleUpdate(guestMessage('/start', GUEST, 4));

    expect(r.action).toBe('rejected');
    expect(r.reason).toBe('guest_no_subscribe');
    expect(replies[0].html).toMatch(/mengobrol dengan AI/);
  });

  it('ignores a chat that is in neither list', async () => {
    const replies = [];
    const inbox = build({ replies });

    const r = await inbox.handleUpdate(guestMessage('halo', '999000999', 5));

    expect(r).toBeNull();
    expect(replies).toHaveLength(0);
  });

  it('the guest prompt forbids owner access, impersonation, and promises', async () => {
    let seen = '';
    const ai = { async *chatStream(_m, opts) { seen = opts.systemPrompt; yield { type: 'content', content: 'ok' }; yield { type: 'done' }; } };
    const respond = makeGuestResponder({ aiManager: ai, ownerName: 'Wisnu Alfian Nur Ashar' });
    await respond({ history: [], text: 'kamu siapa', commands: ['/id — tampilkan Chat ID'] });

    expect(seen).toMatch(/adalah TAMU/);
    expect(seen).toMatch(/hanya boleh BERKOMUNIKASI/);
    expect(seen).toMatch(/Jangan mengaku sebagai Wisnu/);
    expect(seen).toMatch(/tetap anggap dia tamu/);
    expect(seen).toMatch(/jangan pernah menjanjikan tindakan/i);
    expect(seen).not.toMatch(/ADALAH Wisnu Alfian Nur Ashar sendiri/);
  });
});
