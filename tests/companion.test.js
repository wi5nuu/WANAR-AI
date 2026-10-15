import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createWorklog } from '../src/worklog/index.js';
import { createCompanion, companionIntent } from '../src/companion.js';

const BASE = Date.parse('2026-10-14T00:00:00Z'); // 07:00 WIB, Rabu (a workday)
const at = (h, m = 0) => BASE + ((h - 7) * 60 + m) * 60_000;

function build({ ai = null, env = {} } = {}) {
  let clock = at(8, 0);
  const wl = createWorklog({ db: new Database(':memory:'), env: {}, now: () => clock });
  wl.service.updateSettings({ workStart: '08:00', workEnd: '17:00', breakStart: '12:00', breakEnd: '13:00', workdays: [0, 1, 2, 3, 4, 5, 6], autoStart: false, followSchedule: false });
  const sent = [];
  const remembered = [];
  const c = createCompanion({
    worklog: wl.service,
    aiManager: ai,
    env: { OWNER_NAME: 'Wisnu Alfian Nur Ashar', ...env },
    notify: async (chat, text) => { sent.push({ chat, text }); },
    defaultChatId: () => '1',
    remember: (chat, text) => remembered.push(text),
    now: () => clock,
    random: () => 0, // deterministic: every probability gate passes
  });
  return { wl, c, sent, remembered, set: (t) => { clock = t; }, svc: wl.service };
}

const aiSaying = (text) => ({ async *chatStream() { yield { type: 'content', content: text }; yield { type: 'done' }; } });

describe('Companion: peka terhadap keadaan nyata', () => {
  it('asks if he is tired after a long non-stop stretch', async () => {
    const t = build();
    t.set(at(8, 0)); t.svc.clockStart('x');
    t.set(at(11, 0)); // 180 minutes straight
    const r = await t.c.tick();
    expect(r.kind).toBe('long_stretch');
    expect(r.text).toMatch(/Pak Wisnu/);
    expect(t.sent).toHaveLength(1);
    expect(t.remembered).toEqual([r.text]); // so his reply "iya capek" has context
  });

  it('notices a skipped lunch, a finished task list, and overtime', async () => {
    const a = build();
    a.set(at(8, 0)); a.svc.clockStart('x'); a.set(at(13, 40));
    expect(a.c.choose(a.c.signals(), () => 0.99)?.kind).toBe('skipped_lunch');

    const b = build();
    b.set(at(9, 0)); b.svc.addTask({ date: b.svc.today(), title: 'Laporan', done: true });
    b.set(at(14, 0));
    expect(b.c.choose(b.c.signals(), () => 0.99)?.kind).toBe('all_done');

    const c = build();
    c.set(at(8, 0)); c.svc.clockStart('x'); c.set(at(17, 40));
    expect(c.c.choose(c.c.signals(), () => 0.99)?.kind).toBe('overtime');
  });

  it('stays quiet in quiet hours, after the daily cap, within the minimum gap and while he is chatting', async () => {
    const t = build();
    t.set(at(8, 0)); t.svc.clockStart('x');

    t.set(at(6, 0)); expect(await t.c.tick()).toBeNull();           // too early
    t.set(at(22, 30)); expect(await t.c.tick()).toBeNull();         // too late

    t.set(at(11, 0)); t.c.noteOwnerMessage();
    expect(await t.c.tick()).toBeNull();                            // he is talking right now

    t.set(at(11, 30));
    expect((await t.c.tick())?.kind).toBe('long_stretch');
    t.set(at(11, 45)); expect(await t.c.tick()).toBeNull();         // 90-minute gap

    // fill the daily cap
    t.set(at(14, 0)); await t.c.tick();
    t.set(at(16, 0)); await t.c.tick();
    t.set(at(19, 0));
    expect(t.c.status().sentToday).toBeLessThanOrEqual(3);
    t.set(at(20, 30));
    const before = t.sent.length;
    await t.c.tick();
    expect(t.sent.length - before).toBeLessThanOrEqual(1);
    expect(t.c.status().sentToday).toBeLessThanOrEqual(3);
  });

  it('never repeats the same kind within its cooldown', async () => {
    const t = build();
    t.set(at(8, 0)); t.svc.clockStart('x');
    t.set(at(11, 0)); expect((await t.c.tick())?.kind).toBe('long_stretch');
    t.set(at(12, 40)); // gap passed, still within the 3h cooldown
    expect((await t.c.tick())?.kind).not.toBe('long_stretch');
  });

  it('"jangan ganggu dulu" pauses it, "boleh sapa saya lagi" resumes', async () => {
    const t = build();
    t.set(at(8, 0)); t.svc.clockStart('x'); t.set(at(11, 0));
    expect(companionIntent(t.c, 'jangan ganggu dulu ya', 'Pak Wisnu')).toMatch(/tidak akan menyapa dulu sampai sekitar pukul/);
    expect(t.c.isPaused()).toBe(true);
    expect(await t.c.tick()).toBeNull();
    expect(companionIntent(t.c, 'boleh sapa saya lagi', 'Pak Wisnu')).toMatch(/menyapa lagi/);
    expect(t.c.isPaused()).toBe(false);
    expect(companionIntent(t.c, 'tolong buatkan email ke budi', 'Pak Wisnu')).toBeNull();
  });

  it('wording from the model is cleaned of Bapak/Ibu, Anda and kamu; AI down falls back to a human template', async () => {
    const t = build({ ai: aiSaying('Selamat siang, Bapak/Ibu. Apakah Anda capek? Kamu perlu istirahat?') });
    t.set(at(8, 0)); t.svc.clockStart('x'); t.set(at(11, 0));
    const r = await t.c.tick();
    expect(r.text).toBe('Selamat siang, Pak Wisnu. Apakah Pak Wisnu capek? Pak Wisnu perlu istirahat?');

    const d = build({ ai: { async *chatStream() { throw new Error('down'); } } });
    d.set(at(8, 0)); d.svc.clockStart('x'); d.set(at(11, 0));
    const r2 = await d.c.tick();
    expect(r2.text).toMatch(/Pak Wisnu/);
    expect(r2.text).not.toMatch(/Bapak\/Ibu|Anda|kamu/i);
  });

  it('"/peka coba" sends one now even in quiet hours; OWNER_CALL changes the address; it can be disabled', async () => {
    const t = build({ env: { OWNER_CALL: 'Mas Wisnu' } });
    t.set(at(22, 45));
    const r = await t.c.tick({ force: true });
    expect(r.text).toMatch(/Mas Wisnu/);
    expect(t.c.commands().peka).toBeTruthy();
    t.c.setEnabled(false);
    t.set(at(11, 0)); t.svc.clockStart('x');
    expect(await t.c.tick()).toBeNull();
  });
});
