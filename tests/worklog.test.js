/**
 * Test Suite: src/worklog/*  ("Jurnal Kerja")
 * In-memory SQLite, injected clock, fake git/fetch. No network, no real repos.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

import { localDate, atTime, dayBounds, addDays, formatMinutes, formatRupiah, isDate } from '../src/worklog/time.js';
import { parseAmount, parseQuick, normaliseAiProposal } from '../src/worklog/parse.js';
import { computeDay, balance, compare, productivity, verdict } from '../src/worklog/analytics.js';
import { validateFolder, scanFolder, repoCommits, githubActivity, SourceError } from '../src/worklog/activity.js';
import { createWorklog } from '../src/worklog/index.js';
import { createWorklogRouter } from '../src/worklog/routes.js';
import { WorklogError } from '../src/worklog/service.js';
import { TelegramInbox } from '../src/automation/telegram-inbox.js';
import { worklogTelegramCommands } from '../src/worklog/telegram.js';

const D = '2026-10-12'; // Monday
const T = (hhmm, date = D) => atTime(date, hhmm);

function build({ start = T('08:00'), ai = null, env = {} } = {}) {
  const db = new Database(':memory:');
  let clock = start;
  const now = () => clock;
  const wl = createWorklog({ db, aiManager: ai, env: { TELEGRAM_AI_CHAT_IDS: '', ...env }, now });
  return { ...wl, svc: wl.service, set: (ms) => { clock = ms; }, now };
}

// ---------------------------------------------------------------- time

describe('worklog time helpers (Asia/Jakarta)', () => {
  it('maps instants to LOCAL dates, not UTC dates', () => {
    expect(localDate(Date.parse('2026-10-12T17:30:00Z'))).toBe('2026-10-13'); // 00:30 WIB
    expect(localDate(Date.parse('2026-10-12T16:59:00Z'))).toBe('2026-10-12'); // 23:59 WIB
  });

  it('builds day bounds and times in WIB', () => {
    const [a, b] = dayBounds(D);
    expect(a).toBe(Date.parse('2026-10-11T17:00:00Z'));
    expect(b - a).toBe(24 * 3600_000);
    expect(atTime(D, '9')).toBe(Date.parse('2026-10-12T02:00:00Z'));
    expect(atTime(D, '17.30')).toBe(Date.parse('2026-10-12T10:30:00Z'));
    expect(atTime(D, '24:00')).toBe(b);
    expect(atTime(D, '25:00')).toBeNull();
  });

  it('formats and validates', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(isDate('2026-02-30')).toBe(false);
    expect(formatMinutes(450)).toBe('7j 30m');
    expect(formatRupiah(1250000)).toBe('Rp1.250.000');
  });
});

// --------------------------------------------------------------- parse

describe('parse: amounts and free text', () => {
  it('understands Indonesian money notations', () => {
    expect(parseAmount('25rb')).toBe(25000);
    expect(parseAmount('25 ribu')).toBe(25000);
    expect(parseAmount('1,5jt')).toBe(1500000);
    expect(parseAmount('2.5 juta')).toBe(2500000);
    expect(parseAmount('Rp 1.500.000')).toBe(1500000);
    expect(parseAmount('50k')).toBe(50000);
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('99 miliar miliar')).toBeNull();
  });

  it('parses a typical day note offline', () => {
    const p = parseQuick('kerja 9-17, istirahat 12-13, selesai fitur login, gaji proyek 1,5jt; makan siang 25rb\nhari ini lancar');
    expect(p.work).toEqual([{ start: '09:00', end: '17:00' }]);
    expect(p.breaks).toEqual([{ start: '12:00', end: '13:00' }]);
    expect(p.tasks).toEqual([{ title: 'selesai fitur login', done: true }]);
    expect(p.finance).toEqual([
      expect.objectContaining({ type: 'income', amount: 1500000, category: 'Pekerjaan' }),
      expect.objectContaining({ type: 'expense', amount: 25000, category: 'Makan & minum' }),
    ]);
    expect(p.report).toBe('hari ini lancar');
  });

  it('never reads a clock time as money', () => {
    expect(parseQuick('bayar jam 9').finance).toEqual([]);
  });

  it('normalises (and distrusts) an AI proposal', () => {
    const p = normaliseAiProposal({
      work: [{ start: '9:00', end: '17:00' }, { start: 'kemarin', end: '17:00' }, { start: '10:00', end: '10:00' }],
      finance: [
        { type: 'expense', amount: '25rb', note: 'makan' },
        { type: 'income', amount: -5 },
        { type: 'hack', amount: 1 },
        { type: 'income', amount: 99_000_000_000 },
      ],
      tasks: ['tulis laporan', { title: '  ' }, { title: 'deploy', done: false, minutes: 99999 }],
      report: 'x'.repeat(900),
    });
    expect(p.work).toEqual([{ start: '09:00', end: '17:00' }]);
    expect(p.finance).toEqual([expect.objectContaining({ type: 'expense', amount: 25000 })]);
    expect(p.tasks).toEqual([
      { title: 'tulis laporan', done: true, minutes: null, project: null },
      { title: 'deploy', done: false, minutes: null, project: null },
    ]);
    expect(p.report).toHaveLength(600);
  });
});

// ----------------------------------------------------------- analytics

const SETTINGS = { workdays: [1, 2, 3, 4, 5], targetHours: 8 };
const seg = (kind, a, b, date = D) => ({ id: `${kind}${a}`, kind, start_at: T(a, date), end_at: b ? T(b, date) : null, date });

describe('analytics', () => {
  it('subtracts a break that overlaps the work range (manual entry)', () => {
    const d = computeDay({ date: D, settings: SETTINGS, now: T('23:00'), segments: [seg('work', '09:00', '17:00'), seg('break', '12:00', '13:00')] });
    expect(d.workedMin).toBe(7 * 60);
    expect(d.breakMin).toBe(60);
    expect(d.achievement).toBeCloseTo(7 / 8);
    expect(d.status).toBe('done');
  });

  it('counts an open segment up to "now"', () => {
    const d = computeDay({ date: D, settings: SETTINGS, now: T('10:30'), segments: [seg('work', '09:00', null)] });
    expect(d.workedMin).toBe(90);
    expect(d.status).toBe('working');
  });

  it('weekends have no target', () => {
    const sat = '2026-10-17';
    const d = computeDay({ date: sat, settings: SETTINGS, now: T('23:00', sat), segments: [seg('work', '10:00', '12:00', sat)] });
    expect(d.isWorkday).toBe(false);
    expect(d.targetMin).toBe(0);
    expect(balance(d).checks.some((c) => c.id === 'offday')).toBe(true);
  });

  it('flags long days, missing breaks and late work', () => {
    const d = computeDay({ date: D, settings: SETTINGS, now: T('23:59'), segments: [seg('work', '08:00', '22:00')] });
    const b = balance(d);
    const ids = b.checks.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['long_day', 'no_break', 'late']));
    expect(b.level).toBe('bad');
    expect(b.score).toBeLessThan(60);
  });

  it('a normal day is balanced', () => {
    const d = computeDay({ date: D, settings: SETTINGS, now: T('23:00'), segments: [seg('work', '09:00', '17:00'), seg('break', '12:00', '13:00')] });
    expect(balance(d)).toMatchObject({ level: 'ok', label: 'Seimbang', score: 100 });
  });

  it('detects a multi-day overtime pattern', () => {
    const long = (date) => computeDay({ date, settings: SETTINGS, now: T('23:59', date), segments: [seg('work', '08:00', '18:30', date), seg('break', '12:00', '12:45', date)] });
    const days = ['2026-10-12', '2026-10-09', '2026-10-08', '2026-10-07', '2026-10-06'].map(long);
    expect(balance(days[0], days.slice(1)).checks.some((c) => c.id === 'trend_over')).toBe(true);
  });

  it('compares with the previous day as a percentage', () => {
    const today = { workedMin: 480, tasks: { done: 3 }, money: { net: 0 }, productivity: 80 };
    const prev = { date: '2026-10-09', workedMin: 400, tasks: { done: 1 }, money: { net: 0 }, productivity: 60 };
    expect(compare(today, prev)).toMatchObject({ previousDate: '2026-10-09', workedPct: 20, tasksDelta: 2, productivityDelta: 20 });
    expect(compare(today, null).workedPct).toBeNull();
  });

  it('productivity rewards hitting the target, not overworking', () => {
    const base = { targetMin: 480, tasks: { total: 2, done: 2 }, activity: { commits: 0, filesChanged: 0 }, report: { hasReport: true, length: 200 } };
    const on = productivity({ ...base, workedMin: 480 }).score;
    const over = productivity({ ...base, workedMin: 780 }).score;
    expect(on).toBe(80);
    expect(over).toBeLessThan(on);
  });

  it('gives a plain verdict', () => {
    expect(verdict({ workedMin: 0, tasks: { done: 0 }, targetMin: 480 }).enough).toBe(false);
    expect(verdict({ workedMin: 470, tasks: { done: 2 }, targetMin: 480 }).enough).toBe(true);
    expect(verdict({ workedMin: 200, tasks: { done: 1 }, targetMin: 480 }).text).toMatch(/42%/);
  });
});

// ---------------------------------------------------------- service

describe('service: live clock', () => {
  it('start -> pause -> resume -> stop yields the right minutes (manual mode)', () => {
    const w = build({ start: T('09:00') });
    w.svc.updateSettings({ followSchedule: false });
    w.svc.clockStart();
    w.set(T('12:00')); w.svc.clockPause();
    w.set(T('12:45')); w.svc.clockResume();
    w.set(T('17:00')); const s = w.svc.clockStop();
    expect(s.state).toBe('done');
    expect(s.workedMin).toBe(3 * 60 + 4 * 60 + 15);
    expect(s.breakMin).toBe(45);
  });

  it('refuses impossible transitions with clear errors', () => {
    const w = build();
    expect(() => w.svc.clockPause()).toThrow(/Belum mulai/);
    expect(() => w.svc.clockStop()).toThrow(WorklogError);
    w.svc.clockStart();
    expect(() => w.svc.clockStart()).toThrow(/sudah sedang bekerja/);
    expect(() => w.svc.clockResume()).toThrow(/tidak istirahat/);
  });

  it('splits a session that runs past midnight across both days', () => {
    const w = build({ start: T('22:00') });
    w.svc.clockStart();
    w.set(T('01:30', addDays(D, 1)));
    w.svc.clockStop();
    expect(w.svc.day(D).workedMin).toBe(120);
    expect(w.svc.day(addDays(D, 1)).workedMin).toBe(90);
  });
});

describe('service: entries, settings, analysis', () => {
  let w;
  beforeEach(() => { w = build({ start: T('20:00') }); });

  it('applies a parsed proposal and computes the day', async () => {
    const { proposal, engine } = await w.svc.parseText('kerja 9-17, istirahat 12-13, selesai fitur login, makan siang 25rb, gaji proyek 1,5jt');
    expect(engine).toBe('quick'); // no AI configured
    const saved = w.svc.applyProposal(D, proposal);
    expect(saved).toMatchObject({ segments: 2, tasks: 1, finance: 2 });
    const d = w.svc.day(D);
    expect(d.workedMin).toBe(420);
    expect(d.money).toEqual({ income: 1500000, expense: 25000, net: 1475000 });
    expect(d.tasks).toEqual({ total: 1, done: 1 });
    expect(d.targetMin).toBe(420); // default 09–17 with a 60-min break
    expect(d.achievement).toBe(1);
    expect(d.verdict.enough).toBe(true);
  });

  it('uses the AI when available, and falls back when it fails', async () => {
    const good = { async *chatStream() { yield { type: 'content', content: '{"work":[{"start":"08:00","end":"16:00"}],"tasks":[{"title":"review PR"}],"finance":[],"breaks":[],"report":"Review kode"}' }; yield { type: 'done' }; } };
    const wa = build({ ai: good });
    const r = await wa.svc.parseText('tadi pagi review PR dari jam 8 sampai 4 sore');
    expect(r.engine).toBe('ai');
    expect(r.proposal.work).toEqual([{ start: '08:00', end: '16:00' }]);

    const broken = { async *chatStream() { yield { type: 'error', content: 'down' }; yield { type: 'done' }; } };
    const wb = build({ ai: broken });
    expect((await wb.svc.parseText('beli kopi 20rb')).engine).toBe('quick');
  });

  it('compares with the previous day that has data', () => {
    w.svc.addSegment({ date: '2026-10-09', kind: 'work', start: '09:00', end: '15:00' });
    w.svc.addSegment({ date: D, kind: 'work', start: '09:00', end: '18:00' });
    const d = w.svc.day(D);
    expect(d.comparison.previousDate).toBe('2026-10-09');
    expect(d.comparison.workedPct).toBe(50);
  });

  it('validates settings strictly', () => {
    expect(() => w.svc.updateSettings({ workStart: '25:00' })).toThrow(/tidak valid/);
    expect(() => w.svc.updateSettings({ targetHours: 30 })).toThrow();
    expect(() => w.svc.updateSettings({ workdays: [1, 9] })).toThrow();
    expect(() => w.svc.updateSettings({ sources: { github: { username: 'bad name!' } } })).toThrow(/GitHub/);
    expect(() => w.svc.updateSettings({ sources: { github: { username: 'wi5nuu', repos: 'not-a-repo' } } })).toThrow(/pemilik\/nama/);
    const s = w.svc.updateSettings({ workStart: '08:30', targetHours: 7.5, hourlyRate: '50rb', sources: { github: { username: 'wi5nuu', repos: 'wi5nuu/WANAR-AI' } } });
    expect(s).toMatchObject({ workStart: '08:30', targetHours: 7.5, hourlyRate: 50000 });
    expect(s.sources.github).toEqual({ username: 'wi5nuu', repos: ['wi5nuu/WANAR-AI'] });
  });

  it('report length is enforced and mood validated', () => {
    expect(() => w.svc.setReport(D, { text: 'x'.repeat(601) })).toThrow(/maksimal/);
    expect(() => w.svc.setReport(D, { text: 'ok', mood: 9 })).toThrow(/Mood/);
    expect(w.svc.setReport(D, { text: 'Selesai integrasi pembayaran.', mood: 4 })).toMatchObject({ mood: 4 });
  });

  it('month summary groups expenses by category and tracks income target', () => {
    w.svc.updateSettings({ monthlyIncomeTarget: 10_000_000 });
    w.svc.addFinance({ date: D, type: 'expense', amount: '25rb', category: 'Makan & minum' });
    w.svc.addFinance({ date: '2026-10-02', type: 'expense', amount: 100000, category: 'Internet & langganan' });
    w.svc.addFinance({ date: D, type: 'income', amount: '2,5jt' });
    const m = w.svc.month('2026-10');
    expect(m.days).toHaveLength(31);
    expect(m.summary.income).toBe(2500000);
    expect(m.summary.incomeProgress).toBeCloseTo(0.25);
    expect(m.expenseByCategory[0]).toEqual({ category: 'Internet & langganan', amount: 100000 });
  });

  it('deterministic evaluation when no AI is available', async () => {
    w.svc.addSegment({ date: D, kind: 'work', start: '08:00', end: '19:00' });
    const ev = await w.svc.evaluate(D);
    expect(ev).toMatch(/istirahat minimal 30 menit/);
    expect(w.svc.day(D).evaluation).toBe(ev);
  });
});

describe('service: Telegram summary schedule', () => {
  it('sends the evening summary once per workday, at workEnd', async () => {
    const sent = [];
    const w = build({ start: T('16:59'), env: { TELEGRAM_AI_CHAT_IDS: '1811580954' } });
    w.svc.notify = async (chatId, text) => { sent.push({ chatId, text }); };
    w.svc.addSegment({ date: D, kind: 'work', start: '09:00', end: '16:00' });

    await w.svc.tick();
    expect(sent).toHaveLength(0); // before 17:00

    w.set(T('17:01'));
    await w.svc.tick();
    await w.svc.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe('1811580954');
    expect(sent[0].text).toMatch(/Ringkasan kerja/);
    expect(sent[0].text).toMatch(/7j/);
  });

  it('stays silent on a day with no data, and outside the 6-hour window', async () => {
    const sent = [];
    const empty = build({ start: T('17:05'), env: { TELEGRAM_AI_CHAT_IDS: '1811580954' } });
    empty.svc.notify = async (c, t) => sent.push(t);
    await empty.svc.tick();
    expect(sent).toHaveLength(0);

    const late = build({ start: T('23:30'), env: { TELEGRAM_AI_CHAT_IDS: '1811580954' } });
    late.svc.notify = async (c, t) => sent.push(t);
    late.svc.addSegment({ date: D, kind: 'work', start: '09:00', end: '16:00' });
    await late.svc.tick();
    expect(sent).toHaveLength(0); // 17:00 + 6h = 23:00 < 23:30
  });

  it('stays silent on weekends and without a chat id', async () => {
    const sent = [];
    const sat = '2026-10-17';
    const w = build({ start: T('18:00', sat), env: { TELEGRAM_AI_CHAT_IDS: '1811580954' } });
    w.svc.notify = async (c, t) => sent.push(t);
    await w.svc.tick();
    const w2 = build({ start: T('18:00') });
    w2.svc.notify = async (c, t) => sent.push(t);
    await w2.svc.tick();
    expect(sent).toHaveLength(0);
  });
});

// ------------------------------------------------------------ activity

describe('activity sources', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wl-act-'));

  it('refuses relative paths, missing folders, files and system folders', () => {
    expect(() => validateFolder('proyek')).toThrow(SourceError);
    expect(() => validateFolder(path.join(os.tmpdir(), 'tidak-ada-xyz'))).toThrow(/tidak ditemukan/);
    const dir = tmp();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');
    expect(() => validateFolder(file)).toThrow(/bukan folder/);
    if (process.platform === 'win32') expect(() => validateFolder('C:\\Windows')).toThrow(/sistem/);
    else expect(() => validateFolder('/etc')).toThrow(/sistem/);
    expect(validateFolder(dir)).toBe(path.resolve(dir));
  });

  it('counts files modified within the day and skips node_modules', () => {
    const dir = tmp();
    const [from, to] = dayBounds(D);
    const mk = (rel, at) => {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'x');
      fs.utimesSync(p, at / 1000, at / 1000);
    };
    mk('src/app.js', T('10:00'));
    mk('src/style.css', T('11:00'));
    mk('docs/old.md', T('10:00', '2026-10-01'));
    mk('node_modules/lib/index.js', T('10:00'));
    const r = scanFolder(dir, from, to);
    expect(r.filesChanged).toBe(2);
    expect(r.byExt).toEqual({ css: 1, js: 1 });
    expect(r.recent[0].file).toBe(path.join('src', 'style.css'));
  });

  it('reads git log without a shell and filters by author', async () => {
    const calls = [];
    const fakeExec = (cmd, args, opts, cb) => {
      calls.push({ cmd, args });
      const line = (h, n, e, at, s) => [h, n, e, Math.floor(at / 1000), s].join('\x1f');
      cb(null, [
        line('aaaaaaaa1', 'Wisnu', 'wisnu@x.com', T('10:00'), 'feat: login'),
        line('bbbbbbbb2', 'Bot', 'bot@x.com', T('11:00'), 'chore: deps'),
      ].join('\n'));
    };
    const [from, to] = dayBounds(D);
    const r = await repoCommits('/repo', from, to, { author: 'wisnu', execFileImpl: fakeExec });
    expect(r.commits).toBe(1);
    expect(r.messages[0].subject).toBe('feat: login');
    expect(calls[0].cmd).toBe('git');
    expect(calls[0].args).toEqual(expect.arrayContaining(['-c', 'core.fsmonitor=false', '-C', '/repo', 'log']));
  });

  it('counts GitHub pushes for the day only, and never leaks the token', async () => {
    const seen = [];
    const fetchImpl = vi.fn(async (url, init) => {
      seen.push(init.headers);
      return new Response(JSON.stringify([
        { type: 'PushEvent', created_at: new Date(T('10:00')).toISOString(), repo: { name: 'wi5nuu/WANAR-AI' }, payload: { distinct_size: 3 } },
        { type: 'PullRequestEvent', created_at: new Date(T('11:00')).toISOString(), repo: { name: 'wi5nuu/WANAR-AI' }, payload: { action: 'opened', number: 7 } },
        { type: 'PushEvent', created_at: new Date(T('10:00', '2026-10-01')).toISOString(), repo: { name: 'wi5nuu/x' }, payload: { distinct_size: 9 } },
      ]), { status: 200 });
    });
    const [from, to] = dayBounds(D);
    const r = await githubActivity('wi5nuu', from, to, { token: 'ghp_secret', fetchImpl });
    expect(r).toMatchObject({ commits: 3, pushes: 1, prs: 1, error: null });
    expect(seen[0].Authorization).toBe('Bearer ghp_secret');
    expect(JSON.stringify(r)).not.toContain('ghp_secret');
    expect((await githubActivity('bad name', from, to, { fetchImpl })).error).toMatch(/tidak valid/);
  });

  it('explains GitHub rate limits', async () => {
    const fetchImpl = async () => new Response('{}', { status: 403 });
    const [from, to] = dayBounds(D);
    expect((await githubActivity('wi5nuu', from, to, { fetchImpl })).error).toMatch(/GITHUB_TOKEN/);
  });
});

// ------------------------------------------------------------ telegram

describe('Telegram commands (owner only)', () => {
  const OWNER = '1811580954';
  const msg = (chatId, text) => ({ update_id: 1, message: { text, chat: { id: Number(chatId), type: 'private' }, from: { first_name: 'Wisnu' } } });

  const withCmds = (w) => Object.assign(w, { __cmds: { worklogTelegramCommands } });

  it('owner can clock in/out and log via /catat, /uang, /laporan', async () => {
    const w = withCmds(build({ start: T('09:00') }));
    const replies = [];
    const channel = { mode: 'live', reply: async (c, h) => replies.push(h), sendAction: async () => {} };
    const store = { subscribers: { upsert() {}, setActive() {}, counts: () => ({}) }, suppressions: { add() {}, remove() {} } };
    const inbox = new TelegramInbox({ channel, store, env: { TELEGRAM_AI_CHAT_IDS: OWNER } });
    inbox.registerCommands(w.__cmds.worklogTelegramCommands(w.svc));

    w.svc.updateSettings({ followSchedule: false }); // this test drives every transition by hand
    await inbox.handleUpdate(msg(OWNER, '/mulai'));
    w.set(T('12:00')); await inbox.handleUpdate(msg(OWNER, '/istirahat'));
    w.set(T('13:00')); await inbox.handleUpdate(msg(OWNER, '/lanjut'));
    await inbox.handleUpdate(msg(OWNER, '/uang -25rb makan siang'));
    await inbox.handleUpdate(msg(OWNER, '/uang +1,5jt bayaran proyek'));
    await inbox.handleUpdate(msg(OWNER, '/catat selesai fitur login'));
    await inbox.handleUpdate(msg(OWNER, '/laporan Integrasi login selesai & diuji.'));
    w.set(T('17:00')); await inbox.handleUpdate(msg(OWNER, '/selesai'));

    const d = w.svc.day(D);
    expect(d.workedMin).toBe(7 * 60);
    expect(d.money).toEqual({ income: 1500000, expense: 25000, net: 1475000 });
    expect(d.tasks.done).toBe(1);
    expect(d.reportText).toBe('Integrasi login selesai & diuji.');
    expect(replies.at(-1)).toMatch(/Ringkasan kerja/);
    expect(replies.join('\n')).not.toMatch(/<script|undefined/);
  });

  it('strangers get no reaction at all', async () => {
    const w = withCmds(build());
    const replies = [];
    const channel = { mode: 'live', reply: async (c, h) => replies.push(h), sendAction: async () => {} };
    const store = { subscribers: { upsert() {}, setActive() {}, counts: () => ({}) }, suppressions: { add() {}, remove() {} } };
    const inbox = new TelegramInbox({ channel, store, env: { TELEGRAM_AI_CHAT_IDS: OWNER } });
    inbox.registerCommands(w.__cmds.worklogTelegramCommands(w.svc));

    expect(await inbox.handleUpdate(msg('99999999', '/mulai'))).toBeNull();
    expect(await inbox.handleUpdate(msg('99999999', '/uang +99jt hack'))).toBeNull();
    expect(replies).toHaveLength(0);
    expect(w.svc.status().state).toBe('idle');
  });

  it('errors are explained, not thrown; built-ins cannot be shadowed', async () => {
    const w = withCmds(build());
    const replies = [];
    const channel = { mode: 'live', reply: async (c, h) => replies.push(h), sendAction: async () => {} };
    const store = { subscribers: { upsert() {}, setActive() {}, counts: () => ({}) }, suppressions: { add() {}, remove() {} } };
    const inbox = new TelegramInbox({ channel, store, env: { TELEGRAM_AI_CHAT_IDS: OWNER } });
    inbox.registerCommands({ ...w.__cmds.worklogTelegramCommands(w.svc), stop: { run: async () => 'hijacked' } });

    await inbox.handleUpdate(msg(OWNER, '/selesai'));
    expect(replies[0]).toMatch(/Tidak ada sesi kerja/);
    expect(inbox.ownerCommands.has('stop')).toBe(false);

    await inbox.handleUpdate(msg(OWNER, '/help'));
    expect(replies.at(-1)).toMatch(/\/mulai/);
  });
});

// --------------------------------------------------------------- HTTP

describe('HTTP API (/api/worklog)', () => {
  function app() {
    const w = build({ start: T('20:00') });
    const a = express();
    a.use(express.json());
    a.use('/api/worklog', createWorklogRouter({ worklog: w, env: {} }));
    return { a, w };
  }

  it('overview, clock, entries and report', async () => {
    const { a, w } = app();
    await request(a).post('/api/worklog/clock/stop').expect(409);
    await request(a).post('/api/worklog/segments').send({ date: D, kind: 'work', start: '09:00', end: '17:00' }).expect(201);
    await request(a).post('/api/worklog/segments').send({ date: D, kind: 'work', start: '17:00', end: '09:00' }).expect(400);
    const t = await request(a).post('/api/worklog/tasks').send({ date: D, title: 'Deploy v2', done: true }).expect(201);
    await request(a).patch(`/api/worklog/tasks/${t.body.task.id}`).send({ done: false }).expect(200);
    await request(a).post('/api/worklog/finance').send({ date: D, type: 'income', amount: '1jt' }).expect(201);
    await request(a).post('/api/worklog/finance').send({ date: D, type: 'income', amount: 'banyak' }).expect(400);
    await request(a).put(`/api/worklog/report/${D}`).send({ text: 'Rilis v2.' }).expect(200);

    const o = await request(a).get(`/api/worklog/overview?date=${D}`).expect(200);
    expect(o.body.day).toMatchObject({ workedMin: 480, reportText: 'Rilis v2.' });
    expect(o.body.day.tasks).toEqual({ total: 1, done: 0 });
    expect(o.body.week.days).toHaveLength(7);
    expect(w.svc.status().state).toBe('done'); // worked today, nothing open
  });

  it('parse -> apply flow', async () => {
    const { a } = app();
    const p = await request(a).post('/api/worklog/parse').send({ text: 'makan 25rb, selesai review kode' }).expect(200);
    expect(p.body.proposal.finance[0].amount).toBe(25000);
    const r = await request(a).post('/api/worklog/apply').send({ date: D, proposal: p.body.proposal }).expect(200);
    expect(r.body.saved).toMatchObject({ tasks: 1, finance: 1 });
  });

  it('CSV export neutralises spreadsheet formulas', async () => {
    const { a } = app();
    await request(a).put(`/api/worklog/report/${D}`).send({ text: '=HYPERLINK("http://evil","klik")' }).expect(200);
    const r = await request(a).get(`/api/worklog/export.csv?from=${D}&to=${D}`).expect(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text).toContain(`"'=HYPERLINK(""http://evil"",""klik"")"`);
    expect(r.text).not.toMatch(/,=HYPERLINK/);
  });

  it('is refused from the network without a token', async () => {
    const { a } = app();
    await request(a).get('/api/worklog/overview').set('X-Forwarded-For', '10.0.0.5').expect(403);
  });
});

describe('AI finance categories are normalised', () => {
  it('maps free-form categories onto the standard set and keeps the detail as a note', () => {
    const p = normaliseAiProposal({
      finance: [
        { type: 'expense', amount: 22000, category: 'kopi' },
        { type: 'income', amount: 750000, category: 'desain logo' },
        { type: 'expense', amount: 5000, category: 'Transportasi', note: 'parkir' },
        { type: 'expense', amount: 9000, category: 'aneh-aneh' },
      ],
    });
    expect(p.finance).toEqual([
      { type: 'expense', amount: 22000, category: 'Makan & minum', note: 'kopi' },
      { type: 'income', amount: 750000, category: 'Pekerjaan', note: 'desain logo' },
      { type: 'expense', amount: 5000, category: 'Transportasi', note: 'parkir' },
      { type: 'expense', amount: 9000, category: 'Lainnya', note: 'aneh-aneh' },
    ]);
  });
});

describe('a quiet evening does not swallow a later summary', () => {
  it('sends once data appears later inside the window', async () => {
    const sent = [];
    const w = build({ start: T('17:05'), env: { TELEGRAM_AI_CHAT_IDS: '1811580954' } });
    w.svc.notify = async (c, t) => sent.push(t);
    await w.svc.tick();
    expect(sent).toHaveLength(0);

    w.svc.addTask({ date: D, title: 'tulis dokumentasi', done: true });
    w.set(T('19:00'));
    await w.svc.tick();
    expect(sent).toHaveLength(1);
  });
});

// ======================================================= follow the schedule

describe('follow schedule: one "Mulai", the day runs itself', () => {
  const setup = (patch = {}) => {
    const w = build({ start: T('07:55') });
    w.svc.updateSettings({ workStart: '08:00', workEnd: '17:00', breakStart: '12:00', breakEnd: '13:00', ...patch });
    return w;
  };

  it('derives the target from the schedule: 08–17 minus 12–13 = 8 hours', () => {
    const w = setup();
    expect(w.svc.getSettings()).toMatchObject({ targetHours: 8, targetHoursAuto: true });
    expect(w.svc.status().targetMin).toBe(480);
    w.svc.updateSettings({ targetHours: 6 });
    expect(w.svc.getSettings()).toMatchObject({ targetHours: 6, targetHoursAuto: false });
    w.svc.updateSettings({ targetHours: 'auto' });
    expect(w.svc.getSettings().targetHours).toBe(8);
  });

  it('works 08–12, breaks 12–13 automatically, works 13–17, stops at 17:00', () => {
    const w = setup();
    w.set(T('08:00'));
    w.svc.clockStart();
    expect(w.svc.status().next).toEqual({ kind: 'break', at: T('12:00') });

    w.set(T('12:00'));
    let st = w.svc.status();
    expect(st.state).toBe('break');
    expect(st.workedMin).toBe(240);
    expect(st.next).toEqual({ kind: 'resume', at: T('13:00') });

    w.set(T('12:40'));
    expect(w.svc.status().workedMin).toBe(240); // the clock does not run during the break

    w.set(T('13:00'));
    st = w.svc.status();
    expect(st.state).toBe('working');
    expect(st.next).toEqual({ kind: 'stop', at: T('17:00') });

    w.set(T('17:00'));
    st = w.svc.status();
    expect(st.state).toBe('done');
    expect(st.workedMin).toBe(480);
    expect(st.breakMin).toBe(60);
    expect(w.svc.day(D).achievement).toBe(1);
  });

  it('writes the EXACT scheduled minutes even if nobody looked until much later', () => {
    const w = setup();
    w.set(T('08:00'));
    w.svc.clockStart();
    w.set(T('19:30')); // laptop asleep the whole afternoon
    const st = w.svc.status();
    expect(st.state).toBe('done');
    expect(st.workedMin).toBe(480);
    const segs = w.svc.day(D).segments.map((s) => [s.kind, s.source]);
    expect(segs).toEqual([['work', 'web'], ['break', 'auto'], ['work', 'auto']]);
  });

  it('coming back early from the break still stops at 17:00', () => {
    const w = setup();
    w.set(T('08:00')); w.svc.clockStart();
    w.set(T('12:00')); w.svc.status();
    w.set(T('12:30')); w.svc.clockResume();
    w.set(T('17:00'));
    expect(w.svc.status()).toMatchObject({ state: 'done', workedMin: 240 + 270, breakMin: 30 });
  });

  it('overtime after 17:00 is allowed and is not cut again', () => {
    const w = setup();
    w.set(T('08:00')); w.svc.clockStart();
    w.set(T('17:00')); w.svc.status();
    w.set(T('17:30')); w.svc.clockStart();
    w.set(T('19:00'));
    expect(w.svc.status()).toMatchObject({ state: 'working', workedMin: 480 + 90 });
  });

  it('starting during or after the break window does not trigger a break', () => {
    const w = setup();
    w.set(T('12:20')); w.svc.clockStart();
    w.set(T('14:00'));
    expect(w.svc.status()).toMatchObject({ state: 'working', breakMin: 0 });
  });

  it('autoStart (opt-in) starts the day at workStart', () => {
    const w = setup({ autoStart: true });
    w.set(T('07:59'));
    expect(w.svc.status().state).toBe('idle');
    w.set(T('08:01'));
    const st = w.svc.status();
    expect(st.state).toBe('working');
    expect(st.workedMin).toBe(1);
    expect(w.svc.day(D).segments[0]).toMatchObject({ start_at: T('08:00'), source: 'auto' });
  });

  it('autoStart noticed late (14:51) still counts from 08:00 and deducts the 12–13 break', () => {
    const w = setup({ autoStart: true });
    w.set(T('14:51'));
    const st = w.svc.status();
    expect(st.state).toBe('working');
    expect(st.workedMin).toBe(4 * 60 + 111); // 08–12 + 13–14:51
    expect(st.breakMin).toBe(60);
    const segs = w.svc.day(D).segments.map((x) => [x.kind, x.start_at, x.end_at]);
    expect(segs).toEqual([['work', T('08:00'), T('12:00')], ['break', T('12:00'), T('13:00')], ['work', T('13:00'), null]]);
  });

  it('autoStart noticed during the break: work 08–12, break running', () => {
    const w = setup({ autoStart: true });
    w.set(T('12:30'));
    expect(w.svc.status()).toMatchObject({ state: 'break', workedMin: 240 });
  });

  it('repairs a day wrongly started at the break start (12:00 auto, no break)', () => {
    const w = setup({ autoStart: true });
    w.set(T('08:00'));
    w.svc.status(); // starts normally
    w.svc.resetDay(D);
    w.svc.store.segments.add({ date: D, kind: 'work', startAt: T('12:00'), source: 'auto' });
    w.svc.store.meta.set(`autostart:${D}`, T('12:00'));
    w.set(T('14:51'));
    const st = w.svc.status();
    expect(st.workedMin).toBe(4 * 60 + 111);
    expect(st.breakMin).toBe(60);
  });

  it('a session left running from yesterday is closed and does not block the auto start of today', () => {
    const w = setup({ autoStart: true });
    const Y = addDays(D, -1);
    w.set(T('09:00'));
    w.svc.store.segments.add({ date: Y, kind: 'work', startAt: atTime(Y, '13:00'), source: 'auto' });
    const st = w.svc.status();
    expect(st.state).toBe('working');
    expect(st.openSince).toBe(T('08:00'));
    const y = w.svc.day(Y);
    expect(y.workedMin).toBe(4 * 60); // 13:00 → 17:00 (scheduled end), not 20 hours
  });

  it('followSchedule=false leaves the clock fully manual', () => {
    const w = setup({ followSchedule: false });
    w.set(T('08:00')); w.svc.clockStart();
    w.set(T('15:00'));
    expect(w.svc.status()).toMatchObject({ state: 'working', breakMin: 0, next: null });
  });

  it('sends fresh Telegram notices on transitions, but not stale ones after downtime', async () => {
    const sent = [];
    const w = build({ start: T('08:00'), env: { TELEGRAM_AI_CHAT_IDS: '1811580954' } });
    w.svc.updateSettings({ workStart: '08:00', workEnd: '17:00', breakStart: '12:00', breakEnd: '13:00' });
    w.svc.notify = async (c, t) => { sent.push(t); };
    w.svc.clockStart();
    w.set(T('12:01')); w.svc.status();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.some((t) => /Waktunya istirahat/.test(t))).toBe(true);

    sent.length = 0;
    w.set(T('18:30')); w.svc.status(); // 13:00 and 17:00 passed long ago
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);
  });

  it('validates the break window', () => {
    const w = setup();
    expect(() => w.svc.updateSettings({ breakStart: '13:00', breakEnd: '12:00' })).toThrow(/setelah/);
    expect(() => w.svc.updateSettings({ breakStart: '07:00', breakEnd: '07:30' })).toThrow(/di dalam jam kerja/);
    expect(() => w.svc.updateSettings({ workStart: '18:00' })).toThrow(/setelah jam mulai/);
  });
});

describe('reset a day', () => {
  it('removes sessions (and optionally the rest)', () => {
    const w = build({ start: T('20:00') });
    w.svc.addSegment({ date: D, kind: 'work', start: '08:00', end: '17:00' });
    w.svc.addSegment({ date: D, kind: 'break', start: '12:00', end: '13:00' });
    w.svc.addTask({ date: D, title: 'x', done: true });
    expect(w.svc.resetDay(D)).toEqual({ segments: 2, tasks: 0, finance: 0, report: false });
    expect(w.svc.day(D).workedMin).toBe(0);
    expect(w.svc.day(D).tasks.total).toBe(1); // untouched unless asked
    expect(w.svc.resetDay(D, { tasks: true }).tasks).toBe(1);
  });

  it('is exposed over HTTP', async () => {
    const w = build({ start: T('20:00') });
    const a = express();
    a.use(express.json());
    a.use('/api/worklog', createWorklogRouter({ worklog: w, env: {} }));
    await request(a).post('/api/worklog/segments').send({ date: D, kind: 'work', start: '08:00', end: '17:00' }).expect(201);
    const r = await request(a).post(`/api/worklog/days/${D}/reset`).send({}).expect(200);
    expect(r.body.removed.segments).toBe(1);
    await request(a).post('/api/worklog/days/bukan-tanggal/reset').send({}).expect(400);
  });
});

// ============================================== /jadwal + hands-free days

describe('/jadwal from Telegram and a fully hands-free workday', () => {
  const OWNER = '1811580954';
  const msg = (text) => ({ update_id: 1, message: { text, chat: { id: Number(OWNER), type: 'private' }, from: { first_name: 'Wisnu' } } });
  const mkInbox = (w, replies) => {
    const inbox = new TelegramInbox({
      channel: { mode: 'live', reply: async (c, h) => replies.push(h), sendAction: async () => {} },
      store: { subscribers: { upsert() {}, setActive() {}, counts: () => ({}) }, suppressions: { add() {}, remove() {} } },
      env: { TELEGRAM_AI_CHAT_IDS: OWNER },
    });
    inbox.registerCommands(worklogTelegramCommands(w.svc));
    return inbox;
  };

  it('sets the schedule, break, weekdays and derives the target', async () => {
    const w = build({ start: T('07:00') });
    const replies = [];
    const inbox = mkInbox(w, replies);
    await inbox.handleUpdate(msg('/jadwal 08:00-17:00 istirahat 12:00-13:00 senin-jumat'));
    const s = w.svc.getSettings();
    expect(s).toMatchObject({ workStart: '08:00', workEnd: '17:00', breakStart: '12:00', breakEnd: '13:00', workdays: [1, 2, 3, 4, 5], targetHours: 8 });
    expect(replies.at(-1)).toMatch(/berlaku walau laptop mati/);

    await inbox.handleUpdate(msg('/jadwal 9-18 13-14 senin-sabtu'));
    expect(w.svc.getSettings()).toMatchObject({ workStart: '09:00', workEnd: '18:00', breakStart: '13:00', breakEnd: '14:00', workdays: [1, 2, 3, 4, 5, 6] });

    await inbox.handleUpdate(msg('/jadwal otomatis on'));
    expect(w.svc.getSettings()).toMatchObject({ autoStart: true, followSchedule: true });

    await inbox.handleUpdate(msg('/jadwal 17-08'));
    expect(replies.at(-1)).toMatch(/setelah jam mulai/);
  });

  it('a whole day runs by itself: nobody opens the app, only the server tick runs', async () => {
    const w = build({ start: T('07:00') });
    w.svc.updateSettings({ workStart: '08:00', workEnd: '17:00', breakStart: '12:00', breakEnd: '13:00', workdays: [1, 2, 3, 4, 5], autoStart: true });
    for (const hm of ['07:59', '08:00', '09:30', '12:00', '12:30', '13:00', '16:59', '17:00', '18:00']) {
      w.set(T(hm));
      await w.svc.tick(); // what the server does every minute
    }
    const d = w.svc.day(D);
    expect(d.workedMin).toBe(480);
    expect(d.breakMin).toBe(60);
    expect(d.segments.map((s) => s.source)).toEqual(['auto', 'auto', 'auto']);
    expect(w.svc.status().state).toBe('done');
  });

  it('weekends stay untouched', async () => {
    const sat = '2026-10-17';
    const w = build({ start: T('07:00', sat) });
    w.svc.updateSettings({ workStart: '08:00', workEnd: '17:00', breakStart: '12:00', breakEnd: '13:00', workdays: [1, 2, 3, 4, 5], autoStart: true });
    w.set(T('10:00', sat));
    await w.svc.tick();
    expect(w.svc.day(sat).workedMin).toBe(0);
  });
});

// ================================================= reminders + assistant

describe('reminders', () => {
  it('validates time and text, and lists upcoming ones', () => {
    const w = build({ start: T('09:00') });
    expect(() => w.svc.addReminder({ at: `${D} 08:00`, text: 'x' })).toThrow(/sudah lewat/);
    expect(() => w.svc.addReminder({ at: 'besok', text: 'x' })).toThrow(/tidak valid/);
    expect(() => w.svc.addReminder({ at: `${D} 12:00`, text: '  ' })).toThrow(/kosong/);
    w.svc.addReminder({ at: `${D} 12:00`, text: 'Meeting Pak Andi' });
    w.svc.addReminder({ at: `${D} 11:45`, text: '15 menit lagi meeting' });
    expect(w.svc.listReminders().map((r) => r.text)).toEqual(['15 menit lagi meeting', 'Meeting Pak Andi']);
  });

  it('delivers each reminder exactly once, on time, via the tick', async () => {
    const sent = [];
    const w = build({ start: T('09:00'), env: { TELEGRAM_AI_CHAT_IDS: '1811580954' } });
    w.svc.notify = async (c, t) => { sent.push({ c, t }); };
    w.svc.addReminder({ at: `${D} 12:00`, text: 'Meeting Pak Andi' });

    w.set(T('11:59')); await w.svc.deliverReminders();
    expect(sent).toHaveLength(0);
    w.set(T('12:00')); await w.svc.deliverReminders();
    w.set(T('12:01')); await w.svc.deliverReminders();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ c: '1811580954' });
    expect(sent[0].t).toMatch(/Pengingat \(12:00\): Meeting Pak Andi/);
  });

  it('notes lateness after downtime, and drops reminders more than 6 hours late', async () => {
    const sent = [];
    const w = build({ start: T('09:00'), env: { TELEGRAM_AI_CHAT_IDS: '1811580954' } });
    w.svc.notify = async (c, t) => { sent.push(t); };
    w.svc.addReminder({ at: `${D} 10:00`, text: 'telat sedikit' });
    w.svc.addReminder({ at: `${D} 09:30`, text: 'sangat telat' });
    w.set(T('16:00'));
    await w.svc.deliverReminders();
    expect(sent).toEqual([expect.stringMatching(/telat sedikit[\s\S]*terlambat/)]);
  });

  it('cancelled reminders never fire', async () => {
    const sent = [];
    const w = build({ start: T('09:00'), env: { TELEGRAM_AI_CHAT_IDS: '1811580954' } });
    w.svc.notify = async (c, t) => { sent.push(t); };
    const r = w.svc.addReminder({ at: `${D} 12:00`, text: 'x' });
    w.svc.cancelReminder(r.id);
    w.set(T('12:05')); await w.svc.deliverReminders();
    expect(sent).toHaveLength(0);
    expect(() => w.svc.cancelReminder(r.id)).toThrow(/tidak ditemukan/);
  });
});

describe('Telegram assistant: plain language -> validated actions', async () => {
  const { parsePlan, executeActions, makeAssistantResponder } = await import('../src/worklog/assistant.js');

  it('parses a plan, keeps only whitelisted actions, and falls back to plain text', () => {
    const p = parsePlan('```json\n{"reply":"Siap","actions":[{"type":"reminder","at":"2026-10-12 11:45","text":"a"},{"type":"shell","cmd":"rm -rf /"}]}\n```');
    expect(p.reply).toBe('Siap');
    expect(p.actions).toEqual([{ type: 'reminder', at: '2026-10-12 11:45', text: 'a' }]);
    expect(parsePlan('halo juga')).toEqual({ reply: 'halo juga', actions: [] });
  });

  it('caps the number of actions per message', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ type: 'task', title: `t${i}` }));
    expect(parsePlan(JSON.stringify({ reply: '', actions: many })).actions).toHaveLength(8);
  });

  it('executes actions and reports real outcomes, including failures', () => {
    const w = build({ start: T('09:00') });
    const lines = executeActions(w.svc, [
      { type: 'reminder', at: `${D} 11:45`, text: '15 menit lagi meeting Pak Andi' },
      { type: 'reminder', at: `${D} 07:00`, text: 'sudah lewat' },
      { type: 'task', title: 'Meeting dengan Pak Andi jam 12:00' },
      { type: 'finance', kind: 'expense', amount: '35rb', note: 'makan siang' },
      { type: 'clock', action: 'start' },
      { type: 'finance', kind: 'aneh', amount: 1 },
    ], { chatId: '1811580954' });
    expect(lines[0]).toMatch(/^✓ Pengingat: .*11\.45 — 15 menit lagi meeting Pak Andi/);
    expect(lines[1]).toMatch(/^✗ Waktu pengingat sudah lewat/);
    expect(lines[2]).toBe('✓ Tugas dicatat: Meeting dengan Pak Andi jam 12:00');
    expect(lines[3]).toBe('✓ Pengeluaran Rp35.000 · makan siang');
    expect(lines[4]).toMatch(/^✓ Mulai bekerja/);
    expect(lines[5]).toMatch(/^✗ Jenis uang tidak jelas/);
    expect(w.svc.listReminders()).toHaveLength(1);
    expect(w.svc.day(D).money.expense).toBe(35000);
  });

  it('cancels a reminder by keyword', () => {
    const w = build({ start: T('09:00') });
    w.svc.addReminder({ at: `${D} 12:00`, text: 'Meeting Pak Andi' });
    const lines = executeActions(w.svc, [{ type: 'cancel_reminder', match: 'andi' }]);
    expect(lines[0]).toMatch(/dibatalkan: Meeting Pak Andi/);
    expect(w.svc.listReminders()).toHaveLength(0);
  });

  it('end to end: the model plan becomes saved reminders + task + a code-written confirmation', async () => {
    const w = build({ start: T('09:00') });
    const plan = {
      reply: 'Oke Wisnu, sudah saya atur.',
      actions: [
        { type: 'task', title: 'Meeting dengan Pak Andi' },
        { type: 'reminder', at: `${D} 11:45`, text: '15 menit lagi: meeting dengan Pak Andi' },
        { type: 'reminder', at: `${D} 12:00`, text: 'Meeting dengan Pak Andi sekarang' },
      ],
    };
    let prompt = '';
    const ai = { async *chatStream(_m, o) { prompt = o.systemPrompt; yield { type: 'content', content: JSON.stringify(plan) }; yield { type: 'done' }; } };
    const respond = makeAssistantResponder({ aiManager: ai, worklog: w.svc });
    const reply = await respond({ text: 'saya ada meeting jam 12 dengan Pak Andi, tolong catat dan ingatkan', chatId: '1811580954' });

    expect(prompt).toMatch(/SEKARANG: .*pukul/);
    expect(prompt).toMatch(/15 menit sebelum/);
    expect(reply).toMatch(/^Oke Wisnu, sudah saya atur\./);
    expect(reply).toMatch(/✓ Tugas dicatat: Meeting dengan Pak Andi/);
    expect((reply.match(/✓ Pengingat/g) || []).length).toBe(2);
    expect(w.svc.listReminders()).toHaveLength(2);
    expect(w.svc.day(D).taskList[0].title).toBe('Meeting dengan Pak Andi');
  });

  it('a plain question changes nothing', async () => {
    const w = build({ start: T('09:00') });
    const ai = { async *chatStream() { yield { type: 'content', content: '{"reply":"Hari ini kamu belum mulai kerja.","actions":[]}' }; yield { type: 'done' }; } };
    const reply = await makeAssistantResponder({ aiManager: ai, worklog: w.svc })({ text: 'saya sudah kerja berapa jam?' });
    expect(reply).toBe('Hari ini Mas Wisnu belum mulai kerja.'); // never "kamu"/"Anda"/"Bapak/Ibu" to the owner
    expect(w.svc.listReminders()).toHaveLength(0);
  });

  it('pelajaran malam (nightly learning) ikut masuk ke prompt sebagai catatan internal', async () => {
    const w = build({ start: T('09:00') });
    let captured = '';
    const ai = { async *chatStream(_m, o) { captured = o.systemPrompt; yield { type: 'content', content: '{"reply":"Baik.","actions":[]}' }; yield { type: 'done' }; } };
    const learning = { promptBlock: () => 'Pelajaran dari interaksi sebelumnya:\n- Sering lupa istirahat — ingatkan halus.' };
    const reply = await makeAssistantResponder({ aiManager: ai, worklog: w.svc, learning })({ text: 'halo', chatId: '1' });
    expect(captured).toContain('Pelajaran dari interaksi sebelumnya');
    expect(captured).toContain('JANGAN dibacakan');
    expect(typeof reply).toBe('string');

    // Tanpa learning (atau blok kosong) prompt tetap bersih.
    let clean = '';
    const ai2 = { async *chatStream(_m, o) { clean = o.systemPrompt; yield { type: 'content', content: '{"reply":"Halo.","actions":[]}' }; yield { type: 'done' }; } };
    await makeAssistantResponder({ aiManager: ai2, worklog: w.svc, learning: { promptBlock: () => '' } })({ text: 'halo', chatId: '1' });
    expect(clean).not.toContain('PELAJARAN');
  });

  it('aksi berisiko (kirim kampanye) ditangani chatActions: usulan lalu YA, tanpa model', async () => {
    const w = build({ start: T('09:00') });
    const chatActions = {
      confirm: vi.fn(async (t) => (String(t).trim().toUpperCase() === 'YA' ? 'DIJALANKAN LEWAT GERBANG' : null)),
      propose: vi.fn(async (t) => (String(t).toLowerCase().includes('kampanye') ? 'USULAN: balas YA' : null)),
    };
    const ai = { chatStream() { throw new Error('model must not be called'); } };
    const respond = makeAssistantResponder({ aiManager: ai, worklog: w.svc, chatActions });

    expect(await respond({ text: 'kirim kampanye promo', chatId: '1' })).toBe('USULAN: balas YA');
    expect(await respond({ text: 'YA', chatId: '1' })).toBe('DIJALANKAN LEWAT GERBANG');
    expect(chatActions.confirm).toHaveBeenCalledTimes(2);
  });

  it('/pengingat and /batal manage reminders from Telegram', async () => {
    const w = build({ start: T('09:00') });
    w.svc.addReminder({ at: `${D} 12:00`, text: 'Meeting Pak Andi' });
    const replies = [];
    const inbox = new TelegramInbox({
      channel: { mode: 'live', reply: async (c, h) => replies.push(h), sendAction: async () => {} },
      store: { subscribers: { upsert() {}, setActive() {}, counts: () => ({}) }, suppressions: { add() {}, remove() {} } },
      env: { TELEGRAM_AI_CHAT_IDS: '1811580954' },
    });
    inbox.registerCommands(worklogTelegramCommands(w.svc));
    const m = (text) => ({ update_id: 1, message: { text, chat: { id: 1811580954, type: 'private' }, from: { first_name: 'Wisnu' } } });
    await inbox.handleUpdate(m('/pengingat'));
    expect(replies.at(-1)).toMatch(/1\. .*Meeting Pak Andi/);
    await inbox.handleUpdate(m('/batal 1'));
    expect(replies.at(-1)).toMatch(/dibatalkan/);
    expect(w.svc.listReminders()).toHaveLength(0);
  });
});

describe('assistant without model cooperation', async () => {
  const { fallbackPlan, makeAssistantResponder } = await import('../src/worklog/assistant.js');

  it('fallbackPlan turns a meeting into task + two reminders, honouring the lead time', () => {
    const p = fallbackPlan('besok jam 2 siang ada call klien, ingatkan 30 menit sebelumnya', T('09:00'));
    expect(p.actions.map((a) => a.type)).toEqual(['task', 'reminder', 'reminder']);
    expect(p.actions[1].at).toMatch(/13:30$/);
    expect(p.actions[2].at).toMatch(/14:00$/);
  });

  it('acts even when the model returns prose or an empty action list', async () => {
    const w = build({ start: T('09:00') });
    const ai = { async *chatStream() { yield { type: 'content', content: 'Baik, saya catat ya!' }; yield { type: 'done' }; } };
    const reply = await makeAssistantResponder({ aiManager: ai, worklog: w.svc })({ text: 'saya ada meeting jam 12 dengan Pak Andi, ingatkan', chatId: '1811580954' });
    expect(reply).toMatch(/✓ Pengingat/);
    expect(w.svc.listReminders()).toHaveLength(2);
  });

  it('answers reminder listing from the database without calling the model', async () => {
    const w = build({ start: T('09:00') });
    w.svc.addReminder({ at: `${D} 12:00`, text: 'Meeting Pak Andi' });
    const ai = { chatStream() { throw new Error('model must not be called'); } };
    const reply = await makeAssistantResponder({ aiManager: ai, worklog: w.svc })({ text: 'apa saja pengingat saya?' });
    expect(reply).toMatch(/1\. .*Meeting Pak Andi/);
  });
});

describe("persona: bawahan yang sopan, hangat, dan tahu konteks", async () => {
  const { makeAssistantResponder, addressOwner } = await import("../src/worklog/assistant.js");

  it("the prompt makes the owner the boss, bans Bapak/Ibu/Anda/kamu, asks for empathy and uses real tasks", async () => {
    const w = build({ start: T("09:00") });
    w.svc.addTask({ date: D, title: "Kirim laporan harian" });
    let prompt = "";
    const ai = { async *chatStream(_m, o) { prompt = o.systemPrompt; yield { type: "content", content: JSON.stringify({ reply: "Baik, Mas Wisnu.", actions: [] }) }; yield { type: "done" }; } };
    await makeAssistantResponder({ aiManager: ai, worklog: w.svc })({ text: "pagi gini enaknya ngapain yak hehe", chatId: "1" });
    expect(prompt).toMatch(/ATASANMU sekaligus PEMILIKMU/);
    expect(prompt).toMatch(/panggil dia "Mas Wisnu"/);
    expect(prompt).toContain('JANGAN pernah memakai "Bapak/Ibu", "Anda", atau "kamu"');
    expect(prompt).toMatch(/Saat dia curhat: dengarkan/);
    expect(prompt).toMatch(/Tugas terbuka hari ini: Kirim laporan harian/);
    expect(prompt).toMatch(/Status kerja hari ini:/);
  });

  it("addressOwner rewrites every forbidden form", () => {
    expect(addressOwner("Selamat pagi, Bapak/Ibu. Apakah Anda siap? Kamu bisa istirahat.", "Pak Wisnu"))
      .toBe("Selamat pagi, Pak Wisnu. Apakah Pak Wisnu siap? Pak Wisnu bisa istirahat.");
  });

  it("OWNER_CALL changes how he is addressed", async () => {
    process.env.OWNER_CALL = "Bos Wisnu";
    try {
      const w = build({ start: T("09:00") });
      const ai = { async *chatStream() { yield { type: "content", content: JSON.stringify({ reply: "Siap, Anda tenang saja.", actions: [] }) }; yield { type: "done" }; } };
      const reply = await makeAssistantResponder({ aiManager: ai, worklog: w.svc })({ text: "halo", chatId: "1" });
      expect(reply).toBe("Siap, Bos Wisnu tenang saja.");
    } finally { delete process.env.OWNER_CALL; }
  });
});

describe("persona: tetap menjawab walau model gagal", async () => {
  const { makeAssistantResponder } = await import("../src/worklog/assistant.js");

  it("an empty model answer falls back to a plain warm reply instead of an error", async () => {
    const w = build({ start: T("09:00") });
    let call = 0;
    const ai = { async *chatStream(_m, o) {
      call++;
      if (call <= 2) { yield { type: "done" }; return; } // JSON attempt + its corrective retry: empty
      expect(o.systemPrompt).not.toMatch(/Kamu BISA bertindak/); // plain conversation, no action schema
      yield { type: "content", content: "Wah, pasti capek ya, Pak. Cerita saja, saya dengar." }; yield { type: "done" };
    } };
    const reply = await makeAssistantResponder({ aiManager: ai, worklog: w.svc })({ text: "capek banget hari ini", chatId: "1" });
    expect(reply).toBe("Wah, pasti capek ya, Mas. Cerita saja, saya dengar.");
  });

  it("when every attempt fails the boss still gets a polite human answer, never a thrown error", async () => {
    const w = build({ start: T("09:00") });
    const ai = { async *chatStream() { yield { type: "error", content: "provider down" }; } };
    const reply = await makeAssistantResponder({ aiManager: ai, worklog: w.svc })({ text: "halo", chatId: "1" });
    expect(reply).toMatch(/^Maaf Mas Wisnu, saya sedang kesulitan terhubung/);
    expect(reply).toMatch(/\/hariini/);
  });
});

describe('owner is always "Mas Wisnu", never Pak/Bapak', () => {
  it('rewrites Pak/Bapak/Anda/kamu aimed at the owner but keeps other people\'s titles', async () => {
    const { addressOwner } = await import('../src/worklog/assistant.js');
    const call = 'Mas Wisnu';
    expect(addressOwner('Siap, Pak Wisnu.', call)).toBe('Siap, Mas Wisnu.');
    expect(addressOwner('Baik Pak, saya cek dulu.', call)).toBe('Baik Mas, saya cek dulu.');
    expect(addressOwner('Selamat pagi, Bapak Wisnu. Kamu capek?', call)).toBe('Selamat pagi, Mas Wisnu. Mas Wisnu capek?');
    expect(addressOwner('Meeting dengan Pak Andi jam 12, Bapak/Ibu.', call)).toBe('Meeting dengan Pak Andi jam 12, Mas Wisnu.');
  });
});
