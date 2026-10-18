/**
 * Test Suite: WhatsApp dua arah — webhook Meta (GET handshake + POST signature),
 * inbox AI untuk nomor pemilik, STOP/START (opt-out/opt-in), dedup retry Meta,
 * balasan free-form di mode template, dan routing pengiriman "wa:...".
 *
 * Semua lewat `fetch` palsu: tanpa jaringan, tanpa kredensial nyata.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import express from 'express';
import request from 'supertest';

import { createAutomation } from '../src/automation/index.js';
import { verifyWebhookSignature, verifyKirimSignature } from '../src/automation/whatsapp-inbox.js';
import { createWhatsAppWebhookRouter } from '../src/automation/whatsapp-webhook.js';
import { createOwnerContext } from '../src/memory/owner-context.js';
import { createWorklog } from '../src/worklog/index.js';

// ---------------------------------------------------------------- helpers

const OWNER = '628111222333';
const OTHER = '628999888777';
const SECRET = 'app-secret-test';
const VERIFY = 'verify-token-test';
const TG_TOKEN = '123456789:AAFakeTokenFakeTokenFakeToken_abcdef';

const WA_ENV = {
  WHATSAPP_TOKEN: 'EAAtesttoken',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_VERIFY_TOKEN: VERIFY,
  WHATSAPP_APP_SECRET: SECRET,
  WHATSAPP_AI_CHAT_IDS: OWNER,
  WHATSAPP_THROTTLE_MS: '0',
};

function fakeFetch(handler = () => ({})) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method,
      headers: init.headers || {},
      json: typeof init.body === 'string' ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null,
    };
    calls.push(call);
    const r = (await handler(call, calls.length)) || {};
    const status = r.status ?? 200;
    const body = r.body === undefined
      ? JSON.stringify({ ok: true, result: { message_id: 1000 + calls.length }, messages: [{ id: `wamid.sent.${calls.length}` }] })
      : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    return new Response(status === 204 ? null : body, { status, headers: r.headers });
  });
  fn.calls = calls;
  return fn;
}

function makeAuto({ env = {}, fetchImpl = fakeFetch() } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const a = createAutomation({
    db,
    aiManager: { async *chatStream() { yield { type: 'content', content: 'ok' }; yield { type: 'done' }; } },
    env: { EMAIL_THROTTLE_MS: '0', TELEGRAM_THROTTLE_MS: '0', ...env },
    transport: { sendMail: vi.fn(async (m) => ({ messageId: `<${m.to}>`, accepted: [m.to] })) },
    fetchImpl,
    engineOptions: { backoffBaseMs: 1 },
    attachmentsDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wanar-wa-')),
  });
  return { a, db, fetchImpl };
}

/** One inbound webhook payload, shaped exactly like Meta's. */
const inbound = ({ from = OWNER, text = 'halo', id = 'wamid.1', type = 'text', profileName = 'Wisnu' } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA-ID',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '6281230000000', phone_number_id: '1234567890' },
        contacts: profileName ? [{ profile: { name: profileName }, wa_id: from }] : [],
        messages: [{
          from, id, timestamp: '1700000000', type,
          ...(type === 'text' ? { text: { body: text } } : { audio: { id: 'media-1', mime_type: 'audio/ogg' } }),
        }],
      },
    }],
  }],
});

const firstValue = (p) => p.entry[0].changes[0].value;
const firstMessage = (p) => firstValue(p).messages[0];

function setup(env = {}, responder = vi.fn(async () => 'Halo Mas, saya siap.')) {
  const { a, db, fetchImpl } = makeAuto({ env: { ...WA_ENV, ...env } });
  const inbox = a.whatsappInbox;
  inbox.responder = responder;
  return { a, db, inbox, responder, fetchImpl };
}

// --------------------------------------------------------- signature (pure)

describe('verifyWebhookSignature', () => {
  const raw = Buffer.from(JSON.stringify({ hello: 'dunia' }));
  const hex = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');

  it('accepts the correct sha256 signature and rejects everything else', () => {
    expect(verifyWebhookSignature(raw, `sha256=${hex}`, SECRET)).toBe(true);
    expect(verifyWebhookSignature(raw, `sha256=${hex}`, 'secret-lain')).toBe(false);
    expect(verifyWebhookSignature(Buffer.from('{}'), `sha256=${hex}`, SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, 'sha256=deadbeef', SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, `sha256=${hex}`, '')).toBe(false);
  });
});

// ------------------------------------------------------------ inbox (owner)

describe('WhatsApp inbox — obrolan AI dengan pemilik', () => {
  it('menjawab pemilik lewat teks bebas dan menyimpan percakapan', async () => {
    const { inbox, responder, fetchImpl } = setup();
    const payload = inbound({ text: 'halo, apa kabar?' });
    const r = await inbox.handleMessage(firstValue(payload), firstMessage(payload));
    expect(r.action).toBe('ai_reply');
    await r.done;

    expect(responder).toHaveBeenCalledTimes(1);
    const arg = responder.mock.calls[0][0];
    expect(arg.chatId).toBe(`wa:${OWNER}`);
    expect(arg.text).toBe('halo, apa kabar?');
    expect(inbox._historyFor(OWNER).map((t) => t.role)).toEqual(['user', 'assistant']);

    const sent = fetchImpl.calls.find((c) => /\/messages$/.test(c.url) && c.json?.type === 'text');
    expect(sent).toBeTruthy();
    expect(sent.json.to).toBe(OWNER);
    expect(sent.json.text.body).toContain('Halo Mas');
  });

  it('tetap free-form walau template kampanye dikonfigurasi', async () => {
    const { inbox, fetchImpl } = setup({ WHATSAPP_TEMPLATE_NAME: 'kabar_baru' });
    const payload = inbound({ text: 'tes template mode' });
    const r = await inbox.handleMessage(firstValue(payload), firstMessage(payload));
    await r.done;
    expect(fetchImpl.calls.some((c) => c.json?.template)).toBe(false);
    expect(fetchImpl.calls.some((c) => c.json?.type === 'text')).toBe(true);
  });

  it('mengabaikan nomor yang tidak terdaftar dan pesan non-teks pemilik diberi tahu', async () => {
    const { inbox, responder } = setup();
    const asing = inbound({ from: OTHER, text: 'halo dong' });
    expect((await inbox.handleMessage(firstValue(asing), firstMessage(asing))).action).toBe('ignored');
    expect(responder).not.toHaveBeenCalled();

    const audio = inbound({ type: 'audio', id: 'wamid.audio' });
    expect((await inbox.handleMessage(firstValue(audio), firstMessage(audio))).action).toBe('unsupported_reply');
    expect(responder).not.toHaveBeenCalled();
  });

  it('drop duplikat: retry Meta tidak dijawab dua kali', async () => {
    const { inbox, responder } = setup();
    const value = firstValue(inbound({ id: 'wamid.kembar' }));
    const first = await inbox.handleMessage(value, value.messages[0]);
    await first.done;
    const retry = await inbox.handleMessage(value, value.messages[0]);
    expect(retry.action).toBe('duplicate');
    expect(responder).toHaveBeenCalledTimes(1);
  });

  it('abaikan payload nomor lain yang berbagi webhook ini', async () => {
    const { inbox, responder } = setup();
    const payload = inbound();
    payload.entry[0].changes[0].value.metadata.phone_number_id = '9999999999';
    const out = await inbox.handleWebhook(payload);
    expect(out.handled).toBe(0);
    expect(responder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------- lokasi dibagikan (pin)

describe('WhatsApp inbox — lokasi yang dibagikan pemilik', () => {
  const locationPayload = ({ from = OWNER, id = 'wamid.loc.1', lat = -6.2383, lon = 106.9756, name } = {}) => ({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA-ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '6281230000000', phone_number_id: '1234567890' },
          contacts: [{ profile: { name: 'Wisnu' }, wa_id: from }],
          messages: [{
            from, id, timestamp: '1700000000', type: 'location',
            location: { latitude: lat, longitude: lon, ...(name ? { name } : {}) },
          }],
        },
      }],
    }],
  });

  it('menawarkan simpan pin dan membalas di chat yang sama', async () => {
    const { inbox, fetchImpl } = setup();
    const calls = [];
    inbox.onLocationPin = async (pin) => { calls.push(pin); return `📍 Lokasi diterima (${pin.lat}, ${pin.lon}).`; };
    const p = locationPayload();
    const r = await inbox.handleMessage(firstValue(p), firstMessage(p));
    expect(r).toEqual({ action: 'location', phone: OWNER });
    expect(calls).toEqual([{ chatId: `wa:${OWNER}`, lat: -6.2383, lon: 106.9756, title: null, person: 'Wisnu' }]);
    const sent = fetchImpl.calls.find((c) => c.json?.to === OWNER);
    expect(sent.json.type).toBe('text');
    expect(sent.json.text.body).toMatch(/Lokasi diterima/);
  });

  it('meneruskan nama tempat dari WhatsApp sebagai judul', async () => {
    const { inbox } = setup();
    let got = null;
    inbox.onLocationPin = async (pin) => { got = pin; return 'ok'; };
    const p = locationPayload({ id: 'wamid.loc.2', name: 'Warung Bu Tini' });
    await inbox.handleMessage(firstValue(p), firstMessage(p));
    expect(got).toMatchObject({ chatId: `wa:${OWNER}`, title: 'Warung Bu Tini' });
  });

  it('mengabaikan pin dari nomor asing tanpa balasan apa pun', async () => {
    const { inbox } = setup();
    const calls = [];
    inbox.onLocationPin = async (pin) => { calls.push(pin); return 'x'; };
    const p = locationPayload({ from: OTHER, id: 'wamid.loc.3' });
    const r = await inbox.handleMessage(firstValue(p), firstMessage(p));
    expect(r).toEqual({ action: 'ignored', phone: OTHER });
    expect(calls).toHaveLength(0);
  });

  it('tanpa penangan pin: pesan non-teks pemilik tetap diberi tahu seperti biasa', async () => {
    const { inbox } = setup();
    const p = locationPayload({ id: 'wamid.loc.4' });
    const r = await inbox.handleMessage(firstValue(p), firstMessage(p));
    expect(r.action).toBe('unsupported_reply');
  });
});

// --------------------------------------------------------- opt-in / opt-out

describe('WhatsApp inbox — STOP / START', () => {
  it('STOP berhenti langganan + suppression permanen; START memulihkan', async () => {
    const { a, inbox } = setup();
    await inbox.handleMessage(firstValue(inbound({ text: 'start' })), firstMessage(inbound({ text: 'start' })));
    expect(a.store.subscribers.get('whatsapp', OWNER)).toMatchObject({ active: 1, name: 'Wisnu' });

    const stop = await inbox.handleMessage(firstValue(inbound({ text: 'STOP', id: 'wamid.stop' })), firstMessage(inbound({ text: 'STOP', id: 'wamid.stop' })));
    expect(stop.action).toBe('unsubscribed');
    expect(a.store.subscribers.get('whatsapp', OWNER).active).toBe(0);
    expect(a.store.suppressions.has(`whatsapp:${OWNER}`)).toBe(true);

    const again = inbound({ text: 'start', id: 'wamid.start2' });
    expect((await inbox.handleMessage(firstValue(again), firstMessage(again))).action).toBe('subscribed');
    expect(a.store.subscribers.get('whatsapp', OWNER).active).toBe(1);
    expect(a.store.suppressions.has(`whatsapp:${OWNER}`)).toBe(false);
  });

  it('tanpa allowlist eksplisit, hanya nomor pemilik yang boleh START', async () => {
    const { a, inbox } = setup();
    const asing = inbound({ from: OTHER, text: 'start', id: 'wamid.a1' });
    const r = await inbox.handleMessage(firstValue(asing), firstMessage(asing));
    expect(r).toMatchObject({ action: 'rejected', reason: 'not_allowed' });
    expect(a.store.subscribers.get('whatsapp', OTHER)).toBeNull();
  });

  it('join code diberlakukan bila diatur', async () => {
    const { a, inbox } = setup({ WHATSAPP_JOIN_CODE: 'rahasia' });
    const wrong = inbound({ from: OTHER, text: 'start salah', id: 'wamid.j1' });
    expect((await inbox.handleMessage(firstValue(wrong), firstMessage(wrong))).reason).toBe('bad_code');
    const right = inbound({ from: OTHER, text: 'START rahasia', id: 'wamid.j2' });
    expect((await inbox.handleMessage(firstValue(right), firstMessage(right))).action).toBe('subscribed');
    expect(a.store.subscribers.get('whatsapp', OTHER).active).toBe(1);
  });

  it('kalimat biasa yang memuat kata "mulai kerja" bukan perintah', async () => {
    const { a, inbox } = setup();
    const r = await inbox.handleMessage(
      firstValue(inbound({ text: 'mulai kerja jam 8', id: 'wamid.k1' })),
      firstMessage(inbound({ text: 'mulai kerja jam 8', id: 'wamid.k1' }))
    );
    expect(r.action).toBe('ai_reply'); // percakapan biasa, bukan opt-in
    expect(a.store.subscribers.get('whatsapp', OWNER)).toBeNull();
  });
});

// ------------------------------------------------------------ memori kontak

describe('WhatsApp inbox — memori kontak (people)', () => {
  it('merekam nama profil, jumlah pesan, dan cuplikan pesan terakhir', async () => {
    const { a, inbox } = setup();
    const m1 = inbound({ from: OTHER, text: 'halo, ini Budi', id: 'wamid.p1', profileName: 'Budi' });
    await inbox.handleMessage(firstValue(m1), firstMessage(m1));
    const m2 = inbound({ from: OTHER, text: 'mau tanya harga jasa', id: 'wamid.p2', profileName: 'Budi Santoso' });
    await inbox.handleMessage(firstValue(m2), firstMessage(m2));

    const p = a.store.people.get('whatsapp', OTHER);
    expect(p).toMatchObject({ name: 'Budi Santoso', seen_count: 2, is_owner: 0 });
    expect(p.last_message).toBe('mau tanya harga jasa');
  });

  it('pemilik ditandai tersendiri dan tidak ikut daftar kontak', async () => {
    const { a, inbox } = setup();
    const m = inbound({ text: 'halo', id: 'wamid.o1' });
    const r = await inbox.handleMessage(firstValue(m), firstMessage(m));
    await r.done;
    expect(a.store.people.get('whatsapp', OWNER)).toMatchObject({ is_owner: 1 });
    expect(a.store.people.list().map((x) => x.address)).not.toContain(OWNER);
    expect(a.store.people.count()).toBe(0);
  });

  it('pesan non-teks tetap dicatat sebagai kontak (tanpa cuplikan)', async () => {
    const { a, inbox } = setup();
    const audio = inbound({ from: OTHER, type: 'audio', id: 'wamid.audio.p' });
    await inbox.handleMessage(firstValue(audio), firstMessage(audio));
    const p = a.store.people.get('whatsapp', OTHER);
    expect(p?.seen_count).toBe(1);
    expect(p?.last_message).toBeNull();
  });

  it('owner-context menampilkan kontak supaya "siapa yang chat tadi" terjawab', async () => {
    const { a, db, inbox } = setup();
    const m = inbound({ from: OTHER, text: 'halo, ini Budi', id: 'wamid.ctx1', profileName: 'Budi' });
    await inbox.handleMessage(firstValue(m), firstMessage(m));
    const ctx = createOwnerContext({ db, automation: a });
    const out = ctx({ text: 'siapa yang chat tadi?' });
    expect(out).toContain('Budi');
    expect(out).toContain('WA');
  });
});

// ------------------------------------------------------------- status update

describe('WhatsApp inbox — status pengiriman', () => {
  it('meneruskan statuses sebagai event realtime tanpa mengganggu pesan', async () => {
    const { inbox, responder } = setup();
    const events = [];
    inbox.on('delivery_status', (e) => events.push(e));
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: '1234567890' },
            statuses: [{ id: 'wamid.sent.1', status: 'delivered', recipient_id: OWNER, timestamp: '1700000001' }],
          },
        }],
      }],
    };
    const out = await inbox.handleWebhook(payload);
    expect(out.handled).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'delivered', phone: OWNER, messageId: 'wamid.sent.1' });
    expect(responder).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------- meja penjualan (orang asing)

describe('WhatsApp: calon klien (nomor selain pemilik) dijawab meja penjualan', () => {
  const sent = (fetchImpl) => fetchImpl.calls.filter((c) => c.url.includes('graph.facebook.com') && c.json?.type === 'text');

  it('orang asing: pesan diteruskan ke meja penjualan dan balasannya dikirim; pemilik tidak ikut', async () => {
    const { inbox, responder, fetchImpl } = setup();
    inbox.sales = { intake: vi.fn(async () => ({ autoSend: true, reply: 'Halo, saya asisten AI.', leadId: 7 })) };
    const stranger = await inbox.handleWebhook(inbound({ from: OTHER, text: 'butuh website toko online', id: 'wamid.s1', profileName: 'Budi' }));
    expect(stranger.results[0]).toMatchObject({ action: 'sales', leadId: 7 });
    expect(inbox.sales.intake).toHaveBeenCalledWith({ source: 'whatsapp', contact: OTHER, name: 'Budi', text: 'butuh website toko online' });
    const out = sent(fetchImpl);
    expect(out).toHaveLength(1);
    expect(out[0].json).toMatchObject({ to: OTHER, text: { body: 'Halo, saya asisten AI.' } });

    await inbox.handleWebhook(inbound({ from: OWNER, text: 'halo', id: 'wamid.o1' }));
    expect(inbox.sales.intake).toHaveBeenCalledTimes(1); // pesan pemilik tidak pernah masuk meja penjualan
    await vi.waitFor(() => expect(responder).toHaveBeenCalledTimes(1));
  });

  it('balasan otomatis mati: prospek dicatat tetapi tidak ada pesan keluar', async () => {
    const { inbox, fetchImpl } = setup();
    inbox.sales = { intake: vi.fn(async () => ({ autoSend: false, reply: 'draf', leadId: 8 })) };
    await inbox.handleWebhook(inbound({ from: OTHER, text: 'butuh website', id: 'wamid.s2' }));
    expect(sent(fetchImpl)).toHaveLength(0);
  });

  it('meja penjualan error: tidak melempar, tidak membalas', async () => {
    const { inbox, fetchImpl } = setup();
    inbox.sales = { intake: vi.fn(async () => { throw new Error('db down'); }) };
    const r = await inbox.handleWebhook(inbound({ from: OTHER, text: 'butuh website', id: 'wamid.s3' }));
    expect(r.results[0].action).toBe('ignored');
    expect(sent(fetchImpl)).toHaveLength(0);
  });

  it('tanpa meja penjualan perilaku lama tetap: orang asing diabaikan; STOP tetap dihormati', async () => {
    const { inbox, fetchImpl } = setup();
    const a = await inbox.handleWebhook(inbound({ from: OTHER, text: 'butuh website', id: 'wamid.s4' }));
    expect(a.results[0].action).toBe('ignored');
    expect(sent(fetchImpl)).toHaveLength(0);
    inbox.sales = { intake: vi.fn() };
    const stop = await inbox.handleWebhook(inbound({ from: OTHER, text: 'STOP', id: 'wamid.s5' }));
    expect(stop.results[0].action).toBe('unsubscribed'); // opt-out berlaku untuk semua, tidak masuk penjualan
    expect(inbox.sales.intake).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------- Kirimdev (BSP)

const KIRIM_SECRET = 'kirim-signing-secret-test';
const kirimSig = (raw, secret = KIRIM_SECRET, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;

describe('verifyKirimSignature', () => {
  const raw = '{"object":"whatsapp_business_account"}';

  it('menerima tanda tangan sah, menolak body/secret/format yang salah', () => {
    expect(verifyKirimSignature(raw, kirimSig(raw), [KIRIM_SECRET])).toBe(true);
    expect(verifyKirimSignature(raw + ' ', kirimSig(raw), [KIRIM_SECRET])).toBe(false);
    expect(verifyKirimSignature(raw, kirimSig(raw, 'secret-lain'), [KIRIM_SECRET])).toBe(false);
    expect(verifyKirimSignature(raw, 'v1=abcd', [KIRIM_SECRET])).toBe(false);
    expect(verifyKirimSignature(raw, 't=abc,v1=00', [KIRIM_SECRET])).toBe(false);
    expect(verifyKirimSignature(raw, undefined, [KIRIM_SECRET])).toBe(false);
    expect(verifyKirimSignature(raw, kirimSig(raw), [])).toBe(false);
  });

  it('menolak timestamp kedaluwarsa (replay) dan menerima salah satu secret saat rotasi', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyKirimSignature(raw, kirimSig(raw, KIRIM_SECRET, old), [KIRIM_SECRET])).toBe(false);
    expect(verifyKirimSignature(raw, kirimSig(raw), ['secret-lama', KIRIM_SECRET])).toBe(true);
    const t = Math.floor(Date.now() / 1000);
    const both = `t=${t},v1=${'0'.repeat(64)},v1=${crypto.createHmac('sha256', KIRIM_SECRET).update(`${t}.${raw}`).digest('hex')}`;
    expect(verifyKirimSignature(raw, both, [KIRIM_SECRET])).toBe(true);
  });
});

describe('Kirimdev sebagai penyedia WhatsApp', () => {
  const KIRIM_ENV = {
    WHATSAPP_TOKEN: 'kdv_live_testkey',
    WHATSAPP_PHONE_NUMBER_ID: '106540352242922',
    WHATSAPP_API_BASE: 'https://api.kirimdev.com',
    WHATSAPP_API_VERSION: 'v1',
    KIRIMDEV_WEBHOOK_SECRET: KIRIM_SECRET,
    WHATSAPP_AI_CHAT_IDS: OWNER,
    WHATSAPP_THROTTLE_MS: '0',
  };

  it('aktif hanya dengan secret Kirimdev (tanpa verify token / app secret Meta)', () => {
    const { inbox } = setup({ ...KIRIM_ENV, WHATSAPP_VERIFY_TOKEN: '', WHATSAPP_APP_SECRET: '' });
    expect(inbox.webhookReady).toBe(true);
    expect(inbox.status().webhook).toMatchObject({ ready: true, kirimdev: true, appSecret: false });
  });

  it('balasan dikirim ke api.kirimdev.com/v1/<phone_id>/messages dengan Bearer', async () => {
    const { a, fetchImpl } = makeAuto({ env: KIRIM_ENV });
    await a.notify(`wa:${OWNER}`, 'halo dari kirimdev');
    const call = fetchImpl.calls.find((c) => c.json?.type === 'text');
    expect(call.url).toBe('https://api.kirimdev.com/v1/106540352242922/messages');
    expect(call.headers.Authorization).toBe('Bearer kdv_live_testkey');
    expect(call.json).toMatchObject({ messaging_product: 'whatsapp', to: OWNER, text: { body: 'halo dari kirimdev' } });
  });

  it('webhook HTTP: X-Kirim-Signature sah diproses sekali, yang palsu/basi ditolak', async () => {
    const { inbox, responder } = setup({ ...KIRIM_ENV, WHATSAPP_VERIFY_TOKEN: '', WHATSAPP_APP_SECRET: '' });
    const app = express().use('/webhook/whatsapp', createWhatsAppWebhookRouter({ inbox }));
    const payload = inbound({ id: 'wamid.kirim1', text: 'halo lewat kirimdev' });
    firstValue(payload).metadata.phone_number_id = KIRIM_ENV.WHATSAPP_PHONE_NUMBER_ID;
    const raw = JSON.stringify(payload);
    const post = (sig) => request(app).post('/webhook/whatsapp')
      .set('Content-Type', 'application/json').set('x-kirim-signature', sig).send(raw);

    expect((await post('t=1,v1=00')).status).toBe(401);
    expect((await post(kirimSig(raw, 'bukan-secret-kita'))).status).toBe(401);
    expect((await post(kirimSig(raw, KIRIM_SECRET, 1700000000))).status).toBe(401); // replay
    expect(responder).not.toHaveBeenCalled();

    expect((await post(kirimSig(raw))).status).toBe(200);
    expect((await post(kirimSig(raw))).status).toBe(200); // retry Kirimdev: di-ack, tidak dijawab lagi
    await vi.waitFor(() => expect(responder).toHaveBeenCalledTimes(1));
  });

  it('tanpa secret apa pun, webhook menolak semuanya (503)', async () => {
    const { inbox } = setup({ ...KIRIM_ENV, KIRIMDEV_WEBHOOK_SECRET: '', WHATSAPP_VERIFY_TOKEN: '', WHATSAPP_APP_SECRET: '' });
    const app = express().use('/webhook/whatsapp', createWhatsAppWebhookRouter({ inbox }));
    const raw = JSON.stringify(inbound());
    const res = await request(app).post('/webhook/whatsapp')
      .set('Content-Type', 'application/json').set('x-kirim-signature', kirimSig(raw)).send(raw);
    expect(res.status).toBe(503);
  });
});

// --------------------------------------------------------------- webhook HTTP

describe('HTTP /webhook/whatsapp', () => {
  const buildApp = (inbox) => express().use('/webhook/whatsapp', createWhatsAppWebhookRouter({ inbox }));

  it('menjawab handshake verifikasi Meta (GET)', async () => {
    const { inbox } = setup();
    const app = buildApp(inbox);
    const ok = await request(app).get('/webhook/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '12345' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');

    const bad = await request(app).get('/webhook/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'salah', 'hub.challenge': '12345' });
    expect(bad.status).toBe(403);
  });

  it('menolak payload tanpa tanda tangan sah, memproses yang sah tepat sekali', async () => {
    const { inbox, responder } = setup();
    const app = buildApp(inbox);
    const raw = JSON.stringify(inbound({ id: 'wamid.http1', text: 'halo via webhook' }));
    const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(Buffer.from(raw)).digest('hex')}`;

    const unsigned = await request(app).post('/webhook/whatsapp')
      .set('Content-Type', 'application/json').set('x-hub-signature-256', 'sha256=deadbeef').send(raw);
    expect(unsigned.status).toBe(401);
    expect(responder).not.toHaveBeenCalled();

    const signed = await request(app).post('/webhook/whatsapp')
      .set('Content-Type', 'application/json').set('x-hub-signature-256', sig).send(raw);
    expect(signed.status).toBe(200);
    expect(signed.text).toBe('EVENT_RECEIVED');

    // Meta retry dengan payload yang sama: di-ack, tapi tidak dijawab dua kali.
    const retry = await request(app).post('/webhook/whatsapp')
      .set('Content-Type', 'application/json').set('x-hub-signature-256', sig).send(raw);
    expect(retry.status).toBe(200);

    await vi.waitFor(() => expect(responder).toHaveBeenCalledTimes(1));
  });
});

// ------------------------------------------------------- routing "wa:..." 

describe('automation.notify — routing pengiriman', () => {
  it('"wa:..." ke WhatsApp (teks bebas), chat id biasa ke Telegram', async () => {
    const { a, fetchImpl } = makeAuto({ env: { ...WA_ENV, TELEGRAM_BOT_TOKEN: TG_TOKEN } });
    await a.notify(`wa:${OWNER}`, 'Pengingat (09:00): cek email');
    await a.notify('55555', 'Halo Telegram');

    const wa = fetchImpl.calls.find((c) => c.url.includes('graph.facebook.com') && c.json?.type === 'text');
    expect(wa).toBeTruthy();
    expect(wa.json.to).toBe(OWNER);
    expect(wa.json.text.body).toContain('Pengingat');

    const tg = fetchImpl.calls.find((c) => c.url.includes('api.telegram.org') && /sendMessage/.test(c.url));
    expect(tg).toBeTruthy();
    expect(tg.json.chat_id).toBe('55555');
  });

  it('pengingat yang dibuat dari WhatsApp dikirim kembali ke WhatsApp', async () => {
    const { a, fetchImpl } = makeAuto({ env: { ...WA_ENV } });
    const { service } = createWorklog({ db: a.store._db, automation: a, env: {} });
    service.addReminder({ at: Date.now() - 1000, text: 'cek invoice', chatId: `wa:${OWNER}` });
    const sent = await service.deliverReminders();
    expect(sent).toBe(1);

    const wa = fetchImpl.calls.find((c) => c.url.includes('graph.facebook.com') && c.json?.type === 'text');
    expect(wa).toBeTruthy();
    expect(wa.json.to).toBe(OWNER);
    expect(wa.json.text.body).toContain('cek invoice');
  });
});
