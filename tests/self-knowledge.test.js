/**
 * Test Suite: pengetahuan asisten tentang aplikasinya sendiri (halaman, fitur, model, kanal) dibaca dari
 * data nyata dan masuk ke prompt Telegram.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { appPromptLines, WEB_PAGES } from '../src/worklog/self-knowledge.js';
import { makeAssistantResponder } from '../src/worklog/assistant.js';

const aiManager = {
  getProvider: () => 'clouvia',
  getDefaultModel: () => 'deepseek-v4.1-flash',
  getConfiguredProviders: () => ['clouvia', 'nvidia'],
  providers: { clouvia: { defaultModel: 'deepseek-v4.1-flash' }, nvidia: { defaultModel: 'meta/llama-x' } },
};
const automation = { mailer: { mode: 'live' }, channels: { has: (id) => id !== 'whatsapp', get: (id) => ({ mode: id === 'email' ? 'dry-run' : 'live' }) } };

describe('appPromptLines', () => {
  it('memuat halaman, fitur, model nyata, dan status kanal/agen', () => {
    const t = appPromptLines({
      aiManager, automation,
      emailDesk: { live: true, defaultMode: 'auto', inboundMode: 'notify' },
      sales: { autoReply: true, prospects: { enabled: true } }, career: { enabled: true }, market: {},
      env: {},
    }).join('\n');
    expect(t).toContain('https://wanarai.ashargrosirparfum.com');
    expect(t).toContain('/agent-center — Pusat Agen');
    expect(t).toContain('/system-map — Peta Sistem 3D');
    expect(t).toContain('provider "clouvia", model bawaan "deepseek-v4.1-flash"');
    expect(t).toContain('nvidia: meta/llama-x');
    expect(t).toContain('Telegram: tersambung');
    expect(t).toContain('Email (SMTP): BELUM tersambung (mode dry-run)');
    expect(t).not.toContain('WhatsApp:');
    expect(t).toContain('Email Desk: aktif (kirim sungguhan)');
    expect(t).toContain('radar klien aktif');
    expect(t).toContain('Kamu tidak bisa membuka website secara langsung');
  });

  it('tidak melempar bila komponen tidak ada atau rusak', () => {
    expect(() => appPromptLines({})).not.toThrow();
    expect(() => appPromptLines({ aiManager: { getProvider() { throw new Error('x'); } }, emailDesk: { get live() { throw new Error('x'); } } })).not.toThrow();
  });

  it('daftar halaman sama dengan rute di client/src/App.jsx', () => {
    const app = fs.readFileSync(new URL('../client/src/App.jsx', import.meta.url), 'utf8');
    const routes = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*');
    const documented = WEB_PAGES.flatMap(([p]) => p.split(/ dan /)).map((p) => p.trim());
    for (const r of routes) expect(documented, `rute ${r} belum didokumentasikan`).toContain(r);
  });
});

describe('prompt asisten Telegram', () => {
  it('memuat blok APLIKASI WANAR AI', async () => {
    const calls = [];
    const ai = {
      ...aiManager,
      async *chatStream(messages, opts) { calls.push(opts); yield { type: 'content', content: JSON.stringify({ reply: 'ada, Mas', actions: [] }) }; yield { type: 'done' }; },
    };
    const worklog = { today: () => '2026-10-17', getSettings: () => ({ workStart: '08:00', workEnd: '17:00', breakStart: '12:00', breakEnd: '13:00', workdays: [1, 2, 3, 4, 5] }), listReminders: () => [] };
    const respond = makeAssistantResponder({ aiManager: ai, worklog, automation });
    await respond({ text: 'ada halaman apa saja di website kamu?', chatId: '1' });
    expect(calls[0].systemPrompt).toContain('APLIKASI WANAR AI');
    expect(calls[0].systemPrompt).toContain('/command-center — Command Center');
  });
});
