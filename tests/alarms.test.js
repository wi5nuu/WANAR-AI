/**
 * "Bunyikan alarm jam 4 subuh": parsing, repeated ringing until acknowledged,
 * snooze, cap, and the plain-language control from Telegram.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createAlarms, parseAlarmRequest, alarmReplyKind } from '../src/worklog/alarms.js';
import { quickAlarm } from '../src/worklog/quick-alarm.js';

const T = (iso) => new Date(`${iso}+07:00`).getTime();
const wib = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' });

function setup({ start = '2026-10-15T21:00:00', env = {}, fetchImpl } = {}) {
  let t = T(start);
  const sent = [];
  const alarms = createAlarms({
    db: new Database(':memory:'),
    notify: async (c, text) => { sent.push({ c, text }); },
    chatId: () => '111',
    now: () => t,
    env: { ALARM_REPEAT_SECONDS: '20', ALARM_REPEAT_SLOW_SECONDS: '45', ALARM_MAX_FIRES: '12', ...env },
    fetchImpl,
  });
  return { alarms, sent, set: (iso) => { t = T(iso); }, adv: (s) => { t += s * 1000; }, now: () => t, svc: { alarms } };
}

describe('alarm time parsing', () => {
  const now = T('2026-10-15T20:30:00');
  it.each([
    ['bunyikan alarm jam 4 subuh', '2026-10-16 04:00:00', 'Shalat Subuh'],
    ['bangunkan saya jam 5 pagi', '2026-10-16 05:00:00', 'Bangun'],
    ['alarm besok jam 04.30 buat shalat subuh', '2026-10-16 04:30:00', 'Shalat Subuh'],
    ['pasang alarm setengah 5 pagi', '2026-10-16 04:30:00', 'Bangun'],
    ['alarm jam 9 malam', '2026-10-15 21:00:00', 'Bangun'],
    ['alarm 10 menit lagi', '2026-10-15 20:40:00', 'Bangun'],
    ['alarm lusa jam 3 sore', '2026-10-17 15:00:00', 'Bangun'],
  ])('%s', (text, when, label) => {
    const r = parseAlarmRequest(text, now);
    expect(wib(r.at)).toBe(when);
    expect(r.label).toBe(label);
  });

  it("classifies the owner's answer words", () => {
    expect(alarmReplyKind('bangun')).toBe('ack');
    expect(alarmReplyKind('sudah bangun kok')).toBe('ack');
    expect(alarmReplyKind('tunda 10 menit')).toBe('snooze');
    expect(alarmReplyKind('matikan alarm')).toBe('cancel');
    expect(alarmReplyKind('ingatkan meeting jam 3')).toBeNull();
  });
});

describe('alarm lifecycle', () => {
  it('stays silent before the time, then rings repeatedly until acknowledged', async () => {
    const w = setup();
    w.alarms.add({ at: T('2026-10-16T04:00:00'), label: 'Shalat Subuh' });
    await w.alarms.tick();
    expect(w.sent).toHaveLength(0);

    w.set('2026-10-16T04:00:00');
    await w.alarms.tick();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].text).toMatch(/ALARM 04:00 — Shalat Subuh/);

    w.adv(10); await w.alarms.tick();
    expect(w.sent).toHaveLength(1); // not yet: the gap is 20s
    w.adv(11); await w.alarms.tick();
    expect(w.sent).toHaveLength(2);
    w.adv(20); await w.alarms.tick();
    w.adv(20); await w.alarms.tick();
    expect(w.sent.length).toBe(4);
    expect(w.sent[3].text).toMatch(/BANGUN/);

    expect(w.alarms.ringing()).toHaveLength(1);
    expect(w.alarms.ack()).toBe(1);
    w.adv(60); await w.alarms.tick();
    expect(w.sent.length).toBe(4); // silenced
    expect(w.alarms.list()).toHaveLength(0);
  });

  it('gets more insistent and gives up at the cap', async () => {
    const w = setup();
    w.alarms.add({ at: T('2026-10-16T04:00:00'), label: 'Bangun' });
    w.set('2026-10-16T04:00:00');
    for (let i = 0; i < 40; i++) { await w.alarms.tick(); w.adv(46); }
    expect(w.sent.some((s) => /MASIH BUNYI/.test(s.text))).toBe(true);
    expect(w.sent.at(-1).text).toMatch(/saya hentikan setelah 12 kali/);
    expect(w.alarms.ringing()).toHaveLength(0);
  });

  it('snooze re-arms it', async () => {
    const w = setup();
    w.alarms.add({ at: T('2026-10-16T04:00:00'), label: 'Bangun' });
    w.set('2026-10-16T04:00:00');
    await w.alarms.tick();
    expect(w.alarms.snooze(5)).toMatchObject({ snoozed: 1, minutes: 5 });
    expect(w.alarms.list()[0].at).toBe(T('2026-10-16T04:05:00'));
    const before = w.sent.length;
    w.adv(60); await w.alarms.tick();
    expect(w.sent.length).toBe(before); // quiet during the snooze
    w.set('2026-10-16T04:05:00'); await w.alarms.tick();
    expect(w.sent.length).toBe(before + 1);
  });

  it('also pushes an urgent ntfy notification when NTFY_TOPIC is set', async () => {
    const calls = [];
    const w = setup({
      env: { NTFY_TOPIC: 'wanar-wisnu' },
      fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true }; },
    });
    w.alarms.add({ at: T('2026-10-16T04:00:00'), label: 'Shalat Subuh' });
    w.set('2026-10-16T04:00:00');
    await w.alarms.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://ntfy.sh/wanar-wisnu');
    expect(calls[0].opts.headers.Priority).toBe('urgent');
  });

  it('rejects past or far-future alarms', () => {
    const w = setup();
    expect(() => w.alarms.add({ at: T('2026-10-15T10:00:00') })).toThrow(/sudah lewat/);
    expect(() => w.alarms.add({ at: T('2026-12-30T10:00:00') })).toThrow(/31 hari/);
  });
});

describe('Telegram control in plain language', () => {
  it('arms, acknowledges, snoozes and cancels without the model', async () => {
    const w = setup({ start: '2026-10-15T21:00:00' });
    const arm = quickAlarm(w.svc, 'tolong bunyikan alarm jam 4 subuh, saya mau shalat subuh', w.now(), { OWNER_CALL: 'Mas Wisnu' });
    expect(arm).toMatch(/Alarm "Shalat Subuh" terpasang/);
    expect(arm).toMatch(/04:00/);
    expect(arm).toMatch(/Jangan Ganggu/);
    expect(w.alarms.list()).toHaveLength(1);

    // not ringing yet: "ok" is just a chat message, not an acknowledgement
    expect(quickAlarm(w.svc, 'ok', w.now(), {})).toBeNull();

    w.set('2026-10-16T04:00:00'); await w.alarms.tick();
    expect(quickAlarm(w.svc, 'tunda 5 menit', w.now(), {})).toMatch(/tunda 5 menit/);
    w.set('2026-10-16T04:05:00'); await w.alarms.tick();
    expect(quickAlarm(w.svc, 'bangun', w.now(), { OWNER_CALL: 'Mas Wisnu' })).toMatch(/sudah bangun/);
    expect(w.alarms.ringing()).toHaveLength(0);

    quickAlarm(w.svc, 'alarm jam 6 pagi', w.now(), {});
    expect(quickAlarm(w.svc, 'alarm apa saja', w.now(), {})).toMatch(/06:00/);
    expect(quickAlarm(w.svc, 'matikan alarm', w.now(), {})).toMatch(/1 alarm saya matikan/);
    expect(w.alarms.list()).toHaveLength(0);
  });

  it('asks for the time when none is given', () => {
    const w = setup();
    expect(quickAlarm(w.svc, 'bunyikan alarm dong', w.now(), {})).toMatch(/jam berapa/);
  });
});
