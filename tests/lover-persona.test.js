import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createLoverPersona } from '../src/automation/lover-persona.js';

const DAY1 = Date.parse('2026-10-19T10:00:00+07:00');

function fakeAI(answers = []) {
  const seen = [];
  return {
    seen,
    ai: {
      async *chatStream(messages, opts) {
        seen.push({ messages, opts });
        const text = answers.length ? answers.shift() : 'ok';
        yield { type: 'content', content: text };
        yield { type: 'done' };
      },
    },
  };
}

function setup({ answers = [], env = {}, now = () => DAY1 } = {}) {
  const db = new Database(':memory:');
  const asked = [];
  const sent = [];
  const { ai, seen } = fakeAI(answers);
  const lover = createLoverPersona({
    db,
    aiManager: ai,
    env: { TELEGRAM_LOVER_CHAT_IDS: '777', LOVER_NAME: 'Zahra', ...env },
    notifyOwner: async (text) => { asked.push(text); return true; },
    sendToPartner: async (chatId, text) => { sent.push({ chatId, text }); },
    loadHistory: () => [],
    now,
  });
  return { db, lover, asked, sent, seen };
}

describe('Lover persona: speaks as the owner, knows busy/free, no owner access', () => {
  it('plain "aku sibuk ..." sets today\'s status and the prompt knows it', async () => {
    const { lover, seen } = setup({ answers: ['Iya sayang, aku lagi sibuk.'] });

    const reply = lover.ownerIntent('aku sibuk sampai jam 3');
    expect(reply).toMatch(/SIBUK/);
    expect(lover.status()).toMatchObject({ status: 'sibuk', note: 'sampai jam 3' });

    await lover.responder({ chatId: '777', text: 'kamu sibuk ga hari ini?', history: [], commands: [] });

    const prompt = seen[0].opts.systemPrompt;
    expect(prompt).toMatch(/Status Wisnu saat ini: SIBUK/);
    expect(prompt).toContain('sampai jam 3');
    expect(prompt).toMatch(/sedang SIBUK/);
    expect(prompt).toMatch(/jangan mengarang kegiatan/i);
  });

  it('resets busy/free at midnight WIB', async () => {
    let nowMs = DAY1;
    const { lover, seen } = setup({ answers: ['a', 'b'], now: () => nowMs });

    lover.ownerIntent('sibuk rapat');
    expect(lover.status().status).toBe('sibuk');

    nowMs = Date.parse('2026-10-20T01:00:00+07:00');
    expect(lover.status().status).toBe('unknown');

    await lover.responder({ chatId: '777', text: 'halo', history: [], commands: [] });
    expect(seen[0].opts.systemPrompt).toMatch(/Status .* TIDAK DIKETAHUI/);
    expect(seen[0].opts.systemPrompt).toMatch(/JANGAN bilang sedang sibuk atau luang/);
  });

  it('sets status through /sibuk and /luang', async () => {
    const { lover } = setup();

    expect(await lover.commands().sibuk.run({ arg: 'rapat sampai jam 3' })).toMatch(/SIBUK/);
    expect(lover.status()).toMatchObject({ status: 'sibuk', note: 'rapat sampai jam 3' });

    expect(await lover.commands().luang.run({})).toMatch(/LUANG/);
    expect(lover.status()).toMatchObject({ status: 'luang', note: '' });
  });

  it('asks the owner first, holds the partner message, then relays the answer', async () => {
    const { lover, asked, sent } = setup({
      answers: [
        '[[TANYA_OWNER: kapan kamu luang hari ini?]]',
        'Nanti malam ya sayang, jam 8 aku luang. 😊',
      ],
    });

    const hold = await lover.responder({ chatId: '777', text: 'nanti malam kamu luang ga?', history: [], commands: [] });
    expect(hold).toBe('Sebentar ya sayang, aku cek dulu ya 😊');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('kapan kamu luang hari ini?');
    expect(asked[0]).toContain('nanti malam kamu luang ga?');
    expect(lover.status().pending?.question).toBe('kapan kamu luang hari ini?');

    const out = await lover.commands().jawab.run({ arg: 'nanti malam jam 8 aku luang' });
    expect(out).toMatch(/Terkirim ke Zahra/);
    expect(sent).toEqual([{ chatId: '777', text: 'Nanti malam ya sayang, jam 8 aku luang. 😊' }]);
    expect(lover.status().pending).toBeNull();
  });

  it('expires an unanswered question after two hours and never sends a stale reply', async () => {
    let nowMs = DAY1;
    const { lover, sent } = setup({ answers: ['[[TANYA_OWNER: jam berapa?]]'], now: () => nowMs });

    await lover.responder({ chatId: '777', text: 'jam berapa?', history: [], commands: [] });
    nowMs = DAY1 + 3 * 3_600_000;

    const out = await lover.commands().jawab.run({ arg: 'jam 8' });
    expect(out).toMatch(/kedaluwarsa/);
    expect(sent).toHaveLength(0);
    expect(lover.status().pending).toBeNull();
  });

  it('shows status and pending questions with /status', async () => {
    const { lover } = setup({ answers: ['[[TANYA_OWNER: kamu di mana?]]'] });

    lover.ownerIntent('sibuk rapat');
    await lover.responder({ chatId: '777', text: 'kamu di mana?', history: [], commands: [] });

    const text = await lover.commands().status.run({ arg: '' });
    expect(text).toMatch(/SIBUK/);
    expect(text).toMatch(/Menunggu jawabanmu/);
    expect(text).toContain('kamu di mana?');
    expect(text).toContain('Zahra');
  });

  it('keeps the persona honest and powerless (no owner context, no fake actions)', async () => {
    const { lover, seen } = setup({ answers: ['ok'] });

    await lover.responder({ chatId: '777', text: 'kamu siapa?', history: [], commands: ['/id — tampilkan Chat ID'] });

    const prompt = seen[0].opts.systemPrompt;
    expect(prompt).toMatch(/jawab jujur/i);
    expect(prompt).toMatch(/Tidak ada akses ke data pribadi/);
    expect(prompt).toMatch(/\[\[TANYA_OWNER/);
    expect(prompt).toMatch(/Jangan menjanjikan tindakan nyata/);
    expect(prompt).not.toMatch(/Data jurnal|jurnal kerja aktif|riwayat percakapan sebelumnya/);
  });

  it('refuses to answer with no pending question', async () => {
    const { lover } = setup();
    expect(await lover.commands().jawab.run({ arg: 'halo' })).toMatch(/Tidak ada pertanyaan/);
  });
});
