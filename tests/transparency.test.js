/**
 * Test Suite: keterbukaan balasan otomatis & lead dari formulir situs.
 * Setiap balasan email otomatis diberi keterangan AI; relay Web3Forms tidak pernah dibalas, tetapi
 * menjadi lead; persona tidak boleh mengaku manusia atau mengklaim keadaan nyata pemilik.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createEmailDeskStore } from '../src/email-desk/store.js';
import { EmailDesk, AUTO_DISCLOSURE, withDisclosure, parseFormNotification } from '../src/email-desk/service.js';
import { buildReplySystem } from '../src/email-desk/persona.js';
import { salesPromptLines } from '../src/sales/prompt.js';

const OWNER = '1811580954';

function build(ai = null) {
  const db = new Database(':memory:');
  const store = createEmailDeskStore(db);
  const sent = []; const told = [];
  const mailer = { mode: 'live', cfg: { fromAddress: 'wisnu@wanar.id' }, async send(m) { sent.push(m); return { messageId: `<o${sent.length}@w>`, dryRun: false }; } };
  const desk = new EmailDesk({ store, mailer, aiManager: ai, env: { OWNER_NAME: 'Wisnu' }, notify: async (c, t) => { told.push(t); }, defaultChatId: () => OWNER });
  return { desk, sent, told };
}

const WEB3 = {
  messageId: '<w1@web3forms.com>', from: { address: 'notify+bk9wfo@web3forms.com', name: 'Notifications' }, subject: 'New Submission from Portfolio', headers: {},
  text: 'name  : Budi Santoso\nemail  : budi@toko.id\nphone  : +6281234567890\nmessage  : Halo saya ingin dibuatkan website toko kue\n',
};

describe('parseFormNotification', () => {
  it('membaca nama, email, telepon, pesan dari relay Web3Forms; null untuk pengirim lain', () => {
    expect(parseFormNotification(WEB3)).toEqual({ name: 'Budi Santoso', email: 'budi@toko.id', phone: '+6281234567890', message: 'Halo saya ingin dibuatkan website toko kue' });
    expect(parseFormNotification({ ...WEB3, from: { address: 'budi@toko.id' } })).toBeNull();
    expect(parseFormNotification({ ...WEB3, text: 'name  : x\n' })).toBeNull();
  });
});

describe('email dari formulir situs', () => {
  it('menjadi lead + kabar ke pemilik, TANPA membalas ke alamat relay', async () => {
    const w = build();
    w.desk.onFormLead = vi.fn(async () => ({ reply: 'Halo Budi, terima kasih. Toko kue ya?' }));
    const r = await w.desk.handleInbound(WEB3);
    expect(r.action).toBe('form_lead');
    expect(w.desk.onFormLead).toHaveBeenCalledWith(expect.objectContaining({ contact: 'budi@toko.id', name: 'Budi Santoso' }));
    expect(w.sent).toHaveLength(0);
    expect(w.told[0]).toContain('formulir situs portofolio');
    expect(w.told[0]).toContain('Saran balasan (belum dikirim');
    expect(w.told[0]).toContain('toko kue');
  });
});

describe('keterbukaan balasan otomatis', () => {
  it('withDisclosure menambahkan keterangan sekali saja', () => {
    const a = withDisclosure('Halo');
    expect(a.endsWith(AUTO_DISCLOSURE)).toBe(true);
    expect(withDisclosure(a)).toBe(a);
  });

  it('balasan otomatis terkirim dengan keterangan AI, balasan manual tidak diubah', async () => {
    const w = build();
    const d1 = await w.desk.draft({ to: 'budi@klien.com', subject: 's', body: 'Halo manual', chatId: OWNER });
    await w.desk.sendDraft(d1);
    expect(w.sent[0].text).toBe('Halo manual');
    const d2 = await w.desk.draft({ to: 'budi@klien.com', subject: 's', body: 'Balasan', chatId: OWNER, origin: 'autoreply' });
    await w.desk.sendDraft(d2, { auto: true });
    expect(w.sent[1].text).toContain('Balasan');
    expect(w.sent[1].text).toContain('asisten AI');
  });

  it('persona pasangan: tidak boleh mengaku manusia / mengklaim keadaan nyata; ajakan intim dieskalasi', () => {
    const p = buildReplySystem({ relation: 'partner', ownerName: 'Wisnu', name: 'Siti', signature: 'x' });
    expect(p).toContain('TRANSPARANSI');
    expect(p).toContain('jangan mengaku manusia');
    expect(p).toContain('intim/seksual');
    expect(p).not.toContain('Jangan menyebut dirimu AI');
    const g = buildReplySystem({ relation: null, ownerName: 'Wisnu', signature: 'x' });
    expect(g).toContain('TRANSPARANSI');
  });
});

describe('asisten tahu portofolio', () => {
  it('blok bisnis memuat portofolio terhubung', () => {
    const facts = { en: { personalInfo: { name: 'Wisnu A', role: 'Full-Stack', location: 'Bekasi', website: 'https://w.my.id', github: 'gh' }, skills: { programming: ['PHP'], webTech: ['React'], aiMl: [], securityCloud: [], tools: [], soft: [] }, experience: [], projects: [{ name: 'Ashar Grosir Parfum' }] } };
    const sales = { prospects: null, getFacts: () => facts, store: { stats: () => ({ open: 0, needsOwner: 0, won30: { n: 0 } }) }, catalog: () => ({ services: [] }) };
    const t = salesPromptLines({ sales }).join('\n');
    expect(t).toContain('PORTOFOLIO pemilik (TERHUBUNG');
    expect(t).toContain('Ashar Grosir Parfum');
    expect(t).toContain('JANGAN bilang kamu belum terhubung');
  });
});
