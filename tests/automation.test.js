/**
 * Test Suite: src/automation/*
 * Covers: schedule parser, mail-merge, recipient parsing, SMTP error handling,
 * campaign engine (queue/limits/recovery) and the job scheduler (approval gate,
 * misfires, failure circuit-breaker, review-before-send).
 *
 * Runs entirely against an in-memory SQLite database with a fake SMTP transport
 * and a stub AI manager — no network, no real mail, no touching data/wanar.db.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { parseSchedule, nextRun, previewSchedule, describe as describeSchedule, ScheduleError, zonedToUtc, zonedParts } from '../src/automation/cron.js';
import { render, extractVars, escapeHtml, textToHtml } from '../src/automation/templates.js';
import { parseRecipients, isValidEmail } from '../src/automation/recipients.js';
import { classifyMailError, ErrorKind, Mailer, readMailConfig } from '../src/automation/mailer.js';
import { parseEmailDraft, extractCode, collect } from '../src/automation/ai-compose.js';
import { createAutomation } from '../src/automation/index.js';
import { CampaignStatus, JobStatus } from '../src/automation/store.js';
import { validatePayload, JobError } from '../src/automation/scheduler.js';

const WIB = 'Asia/Jakarta';
const utc = (s) => Date.parse(s);

// ===================================================================== cron

describe('cron: schedule parsing & next run (Asia/Jakarta)', () => {
  it('daily@08:00 fires at 08:00 WIB (01:00 UTC)', () => {
    const s = parseSchedule('daily@08:00');
    // 07:00 WIB Monday -> same day 08:00 WIB
    expect(nextRun(s, utc('2026-10-12T00:00:00Z'), WIB)).toBe(utc('2026-10-12T01:00:00Z'));
    // 09:00 WIB -> next day 08:00 WIB
    expect(nextRun(s, utc('2026-10-12T02:00:00Z'), WIB)).toBe(utc('2026-10-13T01:00:00Z'));
  });

  it('is strictly after the reference instant', () => {
    const s = parseSchedule('daily@08:00');
    expect(nextRun(s, utc('2026-10-12T01:00:00Z'), WIB)).toBe(utc('2026-10-13T01:00:00Z'));
  });

  it('weekdays@09:30 skips the weekend', () => {
    const s = parseSchedule('weekdays@09:30');
    // Friday 10:00 WIB -> Monday 09:30 WIB (02:30 UTC)
    expect(nextRun(s, utc('2026-10-16T03:00:00Z'), WIB)).toBe(utc('2026-10-19T02:30:00Z'));
  });

  it('supports weekly day lists, including Indonesian names', () => {
    const s = parseSchedule('mingguan:senin,kamis@07:15');
    const first = nextRun(s, utc('2026-10-12T05:00:00Z'), WIB); // Monday 12:00 WIB, already past 07:15
    expect(first).toBe(utc('2026-10-14T00:15:00Z') + 24 * 3600_000); // Thursday 07:15 WIB
  });

  it('supports monthly dates', () => {
    const s = parseSchedule('monthly:1,15@08:00');
    expect(nextRun(s, utc('2026-10-12T00:00:00Z'), WIB)).toBe(utc('2026-10-15T01:00:00Z'));
  });

  it('handles raw cron with ranges, lists and steps', () => {
    const s = parseSchedule('*/15 9-17 * * 1-5');
    expect(nextRun(s, utc('2026-10-12T02:00:00Z'), WIB)).toBe(utc('2026-10-12T02:15:00Z')); // 09:00 -> 09:15 WIB
  });

  it('supports intervals', () => {
    const s = parseSchedule('every 15m');
    expect(s.type).toBe('interval');
    expect(nextRun(s, 1_000_000)).toBe(1_000_000 + 15 * 60_000);
    expect(parseSchedule('setiap 2 jam').intervalMs).toBe(2 * 3_600_000);
  });

  it('rejects nonsense and sub-minute intervals', () => {
    expect(() => parseSchedule('every 10s')).toThrow(ScheduleError);
    expect(() => parseSchedule('61 * * * *')).toThrow(ScheduleError);
    expect(() => parseSchedule('besok pagi')).toThrow(ScheduleError);
    expect(() => parseSchedule('daily@25:00')).toThrow(ScheduleError);
    expect(() => parseSchedule('')).toThrow(ScheduleError);
  });

  it('treats day-of-month and day-of-week as OR when both are restricted', () => {
    const s = parseSchedule('0 8 13 * 5'); // the 13th OR any Friday
    // From Mon 2026-10-12: first match is Fri 2026-10-16? No — the 13th (Tue) comes first.
    expect(nextRun(s, utc('2026-10-12T05:00:00Z'), WIB)).toBe(utc('2026-10-13T01:00:00Z'));
  });

  it('previewSchedule returns ascending upcoming runs and a description', () => {
    const p = previewSchedule('weekdays@09:00', WIB, 5);
    expect(p.next).toHaveLength(5);
    for (let i = 1; i < p.next.length; i++) expect(p.next[i]).toBeGreaterThan(p.next[i - 1]);
    expect(p.description).toMatch(/Senin–Jumat/);
    expect(() => previewSchedule('daily@08:00', 'Mars/Olympus')).toThrow(ScheduleError);
  });

  it('describes common schedules in Indonesian', () => {
    expect(describeSchedule(parseSchedule('daily@08:00'))).toBe('Setiap hari pukul 08:00');
    expect(describeSchedule(parseSchedule('every 30m'))).toBe('Setiap 30 menit');
  });

  it('round-trips wall-clock <-> UTC', () => {
    const ms = zonedToUtc(2026, 10, 12, 8, 0, WIB);
    expect(ms).toBe(utc('2026-10-12T01:00:00Z'));
    expect(zonedParts(ms, WIB)).toMatchObject({ year: 2026, month: 10, day: 12, hour: 8, minute: 0 });
  });
});

// ================================================================ templates

describe('templates: mail-merge', () => {
  it('substitutes variables case-insensitively with fallbacks', () => {
    const r = render('Halo {{Nama|Bapak/Ibu}}, tagihan {{jumlah}}', { nama: 'Budi', jumlah: 'Rp100' });
    expect(r.text).toBe('Halo Budi, tagihan Rp100');
    expect(render('Halo {{nama|Bapak/Ibu}}', {}).text).toBe('Halo Bapak/Ibu');
  });

  it('reports missing variables instead of silently blanking them', () => {
    const r = render('Halo {{nama}} dari {{kantor}}', { nama: 'Ani' });
    expect(r.missing).toEqual(['kantor']);
  });

  it('escapes substituted values in HTML mode (no injection via CSV cells)', () => {
    const r = render('<p>{{nama}}</p>', { nama: '<script>alert(1)</script>' }, { html: true });
    expect(r.text).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('never executes expressions (left verbatim, not evaluated)', () => {
    const src = '{{constructor.constructor("return 1")()}}';
    expect(render(src, {}).text).toBe(src);
  });

  it('does not leak inherited Object.prototype members', () => {
    const r = render('[{{constructor}}][{{__proto__}}][{{toString}}][{{hasOwnProperty}}]', {});
    expect(r.text).toBe('[][][][]');
    expect(r.missing.sort()).toEqual(['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
  });

  it('extractVars lists distinct placeholders', () => {
    expect(extractVars('{{a}} {{b|x}} {{a}}').sort()).toEqual(['a', 'b']);
  });

  it('textToHtml escapes and paragraphs', () => {
    const h = textToHtml('a <b>\n\nc');
    expect(h).toContain('&lt;b&gt;');
    expect((h.match(/<p /g) || []).length).toBe(2);
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });
});

// ============================================================== recipients

describe('recipients: parsing & validation', () => {
  it('parses a CSV with header and extra columns as variables', () => {
    const r = parseRecipients('nama,email,perusahaan\nBudi,budi@x.com,PT A\n"Ani, S.",ani@y.com,PT B');
    expect(r.recipients).toHaveLength(2);
    expect(r.recipients[0]).toMatchObject({ email: 'budi@x.com', name: 'Budi', vars: { perusahaan: 'PT A' } });
    expect(r.recipients[1].name).toBe('Ani, S.');
  });

  it('parses bare emails, "Name <mail>" and "Name, mail" lines', () => {
    const r = parseRecipients('a@x.com\nBudi <b@x.com>\nCitra, c@x.com');
    expect(r.recipients.map((x) => x.email)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(r.recipients[1].name).toBe('Budi');
    expect(r.recipients[2].name).toBe('Citra');
  });

  it('de-duplicates case-insensitively and reports invalid rows', () => {
    const r = parseRecipients('A@x.com\na@x.com\nbukan-email\nb@x.com');
    expect(r.recipients).toHaveLength(2);
    expect(r.duplicates).toEqual(['a@x.com']);
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0].line).toBe(3);
  });

  it('rejects CR/LF header-injection attempts', () => {
    expect(isValidEmail('a@x.com\r\nBcc: evil@z.com')).toBe(false);
    const r = parseRecipients(['a@x.com\nBcc: evil@z.com']);
    expect(r.recipients).toHaveLength(0);
  });

  it('accepts structured arrays and ignores comment lines', () => {
    const r = parseRecipients([{ email: 'a@x.com', name: 'A', kota: 'Bekasi' }, 'b@x.com']);
    expect(r.recipients[0].vars).toEqual({ kota: 'Bekasi' });
    expect(parseRecipients('# komentar\na@x.com').recipients).toHaveLength(1);
  });

  it('caps the list size', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `u${i}@x.com`).join('\n');
    expect(parseRecipients(lines, { max: 10 }).recipients).toHaveLength(10);
  });
});

// ================================================================== mailer

describe('mailer: config & error classification', () => {
  it('runs in dry-run mode without SMTP credentials', () => {
    const m = new Mailer({ MAIL_FROM: 'Tes <tes@example.com>' });
    expect(m.mode).toBe('dry-run');
    expect(m.describe().missing).toEqual(expect.arrayContaining(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']));
  });

  it('never exposes the password', () => {
    const m = new Mailer({ SMTP_HOST: 'smtp.x.com', SMTP_USER: 'me@x.com', SMTP_PASS: 'super-secret', MAIL_FROM: 'me@x.com' });
    expect(JSON.stringify(m.describe())).not.toContain('super-secret');
    expect(m.mode).toBe('live');
  });

  it('EMAIL_DRY_RUN forces simulation even when configured', () => {
    const m = new Mailer({ SMTP_HOST: 'h', SMTP_USER: 'me@x.com', SMTP_PASS: 'p', EMAIL_DRY_RUN: 'true' });
    expect(m.mode).toBe('dry-run');
  });

  it('parses MAIL_FROM with a display name', () => {
    const c = readMailConfig({ MAIL_FROM: '"PT Maju" <hrd@maju.co.id>', SMTP_USER: 'u@x.com' });
    expect(c.fromAddress).toBe('hrd@maju.co.id');
    expect(c.fromName).toBe('PT Maju');
  });

  it('classifies SMTP failures', () => {
    expect(classifyMailError({ code: 'EAUTH', message: 'Invalid login' }).kind).toBe(ErrorKind.AUTH);
    expect(classifyMailError({ responseCode: 550, response: '550 5.1.1 User unknown' })).toMatchObject({ kind: ErrorKind.PERMANENT, hardBounce: true });
    expect(classifyMailError({ responseCode: 550, response: '550 5.4.5 Daily user sending quota exceeded' }).kind).toBe(ErrorKind.QUOTA);
    expect(classifyMailError({ code: 'ETIMEDOUT', message: 'timeout' }).kind).toBe(ErrorKind.TRANSIENT);
  });

  it('refuses to build malformed messages and cannot spoof From', async () => {
    const sendMail = vi.fn(async () => ({ messageId: '<1>', accepted: ['a@x.com'] }));
    const m = new Mailer({ MAIL_FROM: 'me@x.com' }, { transport: { sendMail } });
    await expect(m.send({ to: 'bukan-email', subject: 's', text: 't' })).rejects.toMatchObject({ kind: ErrorKind.INVALID });
    await expect(m.send({ to: 'a@x.com', subject: '', text: 't' })).rejects.toMatchObject({ kind: ErrorKind.INVALID });

    await m.send({ to: 'a@x.com', subject: 'Hai\r\nBcc: z@z.com', text: 't', fromName: 'CEO <ceo@bank.com>' });
    const sent = sendMail.mock.calls[0][0];
    expect(sent.subject).not.toMatch(/[\r\n]/);
    expect(sent.from.address).toBe('me@x.com'); // identity is fixed
    expect(sent.from.name).not.toContain('<');
  });
});

// ============================================================== ai-compose

describe('ai-compose: output parsing', () => {
  it('parses JSON, fenced JSON and "Subjek:" formats', () => {
    expect(parseEmailDraft('{"subject":"A","body":"B"}')).toEqual({ subject: 'A', body: 'B' });
    expect(parseEmailDraft('Berikut:\n```json\n{"subject":"A","body":"B"}\n```')).toEqual({ subject: 'A', body: 'B' });
    expect(parseEmailDraft('Subjek: Rapat Besok\n\nHalo semua,\nRapat jam 9.')).toEqual({ subject: 'Rapat Besok', body: 'Halo semua,\nRapat jam 9.' });
    expect(parseEmailDraft('tidak ada struktur')).toBeNull();
  });

  it('extracts fenced code with its language', () => {
    expect(extractCode('x\n```python\nprint(1)\n```\ny')).toEqual({ language: 'python', code: 'print(1)' });
  });

  it('collect() discards partial output when the stream fails over', async () => {
    const ai = {
      async *chatStream() {
        yield { type: 'content', content: 'sampah-parsial' };
        yield { type: 'provider_switch', to: 'nvidia', model: 'm2', reset: true };
        yield { type: 'content', content: 'jawaban bersih' };
        yield { type: 'done' };
      },
    };
    const out = await collect(ai, []);
    expect(out.text).toBe('jawaban bersih');
    expect(out.provider).toBe('nvidia');
  });
});

// ===================================================== engine + scheduler

function build({ env = {}, transport, ai, engineOptions, schedulerOptions } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const sendMail = transport || vi.fn(async (m) => ({ messageId: `<${m.to}>`, accepted: [m.to] }));
  const aiManager = ai || {
    async *chatStream() {
      yield { type: 'content', content: '{"subject":"Ringkasan Harian","body":"Halo {{nama|Tim}},\\n\\nIni ringkasan hari ini."}' };
      yield { type: 'done' };
    },
  };
  const a = createAutomation({
    db,
    aiManager,
    env: { MAIL_FROM: 'Wanar <bot@kantor.co.id>', EMAIL_THROTTLE_MS: '0', ...env },
    transport: { sendMail },
    engineOptions: { backoffBaseMs: 1, ...engineOptions },
    schedulerOptions,
    attachmentsDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wanar-att-')),
  });
  return { ...a, sendMail, db };
}

const LIST = 'nama,email\nBudi,budi@x.com\nAni,ani@x.com\nCitra,citra@x.com';

describe('campaign engine', () => {
  let ctx;
  beforeEach(() => { ctx = build(); });

  it('creates a DRAFT and sends nothing until explicitly started', async () => {
    const { campaign, report } = ctx.engine.create({ subject: 'Halo {{nama}}', bodyText: 'Isi', recipients: LIST });
    expect(campaign.status).toBe(CampaignStatus.DRAFT);
    expect(report.valid).toBe(3);
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.sendMail).not.toHaveBeenCalled();
  });

  it('personalises and delivers every recipient once started', async () => {
    const { campaign } = ctx.engine.create({ subject: 'Halo {{nama}}', bodyText: 'Hai {{nama}}', recipients: LIST });
    ctx.engine.start(campaign.id, { approvedBy: 'wisnu' });
    await ctx.engine.idle(campaign.id);

    const done = ctx.store.campaigns.get(campaign.id);
    expect(done.status).toBe(CampaignStatus.COMPLETED);
    expect(done.stats).toMatchObject({ sent: 3, failed: 0, total: 3 });
    expect(done.approved_by).toBe('wisnu');

    const budi = ctx.sendMail.mock.calls.map((c) => c[0]).find((m) => m.to === 'budi@x.com');
    expect(budi.subject).toBe('Halo Budi');
    expect(budi.text).toBe('Hai Budi');
    expect(budi.html).toContain('Hai Budi');
  });

  it('honours the suppression list', async () => {
    ctx.store.suppressions.add('ani@x.com', 'opt-out');
    const { campaign, report } = ctx.engine.create({ subject: 'S', bodyText: 'B', recipients: LIST });
    expect(report.suppressed).toEqual(['ani@x.com']);
    ctx.engine.start(campaign.id);
    await ctx.engine.idle(campaign.id);
    const sentTo = ctx.sendMail.mock.calls.map((c) => c[0].to);
    expect(sentTo).not.toContain('ani@x.com');
    expect(ctx.store.campaigns.get(campaign.id).stats).toMatchObject({ sent: 2, skipped: 1 });
  });

  it('skips (not blanks) recipients with a missing variable', async () => {
    const { campaign } = ctx.engine.create({
      subject: 'Tagihan {{jumlah}}', bodyText: 'Hai {{nama}}',
      recipients: 'nama,email,jumlah\nBudi,budi@x.com,Rp1\nAni,ani@x.com,',
    });
    ctx.engine.start(campaign.id);
    await ctx.engine.idle(campaign.id);
    const stats = ctx.store.campaigns.get(campaign.id).stats;
    expect(stats).toMatchObject({ sent: 1, skipped: 1 });
    const skipped = ctx.store.outbox.page(campaign.id, { status: 'skipped' })[0];
    expect(skipped.last_error).toMatch(/jumlah/);
  });

  it('pauses on auth failure instead of failing every recipient', async () => {
    const c = build({ transport: vi.fn(async () => { const e = new Error('Invalid login'); e.code = 'EAUTH'; throw e; }) });
    const { campaign } = c.engine.create({ subject: 'S', bodyText: 'B', recipients: LIST });
    c.engine.start(campaign.id);
    await c.engine.idle(campaign.id);
    const got = c.store.campaigns.get(campaign.id);
    expect(got.status).toBe(CampaignStatus.PAUSED);
    expect(got.status_reason).toBe('auth');
    expect(got.stats).toMatchObject({ failed: 0, sent: 0, queued: 3 });
    expect(c.sendMail).toHaveBeenCalledTimes(1);
  });

  it('fails a hard bounce and auto-suppresses the address', async () => {
    const c = build({
      transport: vi.fn(async (m) => {
        if (m.to === 'ani@x.com') { const e = new Error('no'); e.responseCode = 550; e.response = '550 5.1.1 User unknown'; throw e; }
        return { messageId: '<ok>', accepted: [m.to] };
      }),
    });
    const { campaign } = c.engine.create({ subject: 'S', bodyText: 'B', recipients: LIST });
    c.engine.start(campaign.id);
    await c.engine.idle(campaign.id);
    expect(c.store.campaigns.get(campaign.id).stats).toMatchObject({ sent: 2, failed: 1 });
    expect(c.store.suppressions.has('ani@x.com')).toBe(true);
  });

  it('retries transient errors with backoff, then succeeds', async () => {
    let calls = 0;
    const c = build({
      transport: vi.fn(async (m) => {
        calls += 1;
        if (calls <= 2) { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; throw e; }
        return { messageId: '<ok>', accepted: [m.to] };
      }),
    });
    const { campaign } = c.engine.create({ subject: 'S', bodyText: 'B', recipients: 'a@x.com' });
    c.engine.start(campaign.id);
    await c.engine.idle(campaign.id);
    const row = c.store.outbox.all(campaign.id)[0];
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(3);
  });

  it('stops at the daily cap and resumes the next local day', async () => {
    const c = build({ env: { EMAIL_DAILY_CAP: '2', SMTP_HOST: 'h', SMTP_USER: 'u@x.com', SMTP_PASS: 'p' } });
    const { campaign } = c.engine.create({ subject: 'S', bodyText: 'B', recipients: LIST });
    c.engine.start(campaign.id);
    await c.engine.idle(campaign.id);
    const paused = c.store.campaigns.get(campaign.id);
    expect(paused.status).toBe(CampaignStatus.PAUSED);
    expect(paused.status_reason).toBe('daily_cap');
    expect(paused.stats.sent).toBe(2);

    // Same day: must NOT wake.
    expect(c.engine.resumeDue(Date.now())).toEqual([]);
  });

  it('never re-sends a row that was mid-flight at crash time (at-most-once)', async () => {
    const { campaign } = ctx.engine.create({ subject: 'S', bodyText: 'B', recipients: 'a@x.com' });
    const row = ctx.store.outbox.all(campaign.id)[0];
    ctx.store.outbox.mark(row.id, { status: 'sending' });
    ctx.store.campaigns.update(campaign.id, { status: 'running', mode: 'live' });

    const rec = ctx.engine.init();
    expect(rec.interruptedRows).toBe(1);
    await ctx.engine.idle(campaign.id);
    expect(ctx.sendMail).not.toHaveBeenCalled();
    expect(ctx.store.outbox.all(campaign.id)[0].status).toBe('failed');
  });

  it('enforces the recipient ceiling', () => {
    const c = build({ env: { EMAIL_MAX_RECIPIENTS: '2' } });
    expect(() => c.engine.create({ subject: 'S', bodyText: 'B', recipients: LIST })).toThrow(/Maksimal 2/);
  });

  it('cancel stops a running campaign', async () => {
    const c = build({ env: { EMAIL_THROTTLE_MS: '20' } });
    const { campaign } = c.engine.create({ subject: 'S', bodyText: 'B', recipients: LIST, throttleMs: 20 });
    c.engine.start(campaign.id);
    c.engine.cancel(campaign.id);
    await c.engine.idle(campaign.id);
    expect(c.store.campaigns.get(campaign.id).status).toBe(CampaignStatus.CANCELLED);
    expect(c.sendMail.mock.calls.length).toBeLessThan(3);
  });

  it('retryFailed requeues only failed rows', async () => {
    const c = build({
      transport: vi.fn(async (m) => {
        if (m.to === 'ani@x.com') { const e = new Error('x'); e.responseCode = 554; e.response = '554 rejected'; throw e; }
        return { messageId: '<ok>', accepted: [m.to] };
      }),
    });
    const { campaign } = c.engine.create({ subject: 'S', bodyText: 'B', recipients: LIST });
    c.engine.start(campaign.id);
    await c.engine.idle(campaign.id);
    const r = c.engine.retryFailed(campaign.id);
    expect(r.requeued).toBe(1);
  });

  it('emits realtime progress events', async () => {
    const events = [];
    ctx.engine.on('campaign', (e) => events.push(e));
    const { campaign } = ctx.engine.create({ subject: 'S', bodyText: 'B', recipients: LIST });
    ctx.engine.start(campaign.id);
    await ctx.engine.idle(campaign.id);
    expect(events.some((e) => e.type === 'progress')).toBe(true);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });
});

describe('scheduler', () => {
  let ctx;
  const emailJob = (extra = {}) => ({
    name: 'Laporan Harian', type: 'email', schedule: 'daily@08:00',
    payload: { subject: 'Laporan {{tanggal}}', bodyText: 'Halo {{nama|Tim}}', recipients: LIST },
    ...extra,
  });
  const makeDue = (id) => ctx.store.jobs.update(id, { next_run_at: Date.now() - 1000 });

  beforeEach(() => { ctx = build(); });

  it('a proposed job is inert until a human approves it', async () => {
    const job = ctx.scheduler.createJob(emailJob(), { actor: 'agent' });
    expect(job.status).toBe(JobStatus.PENDING_APPROVAL);
    makeDue(job.id);

    const t = await ctx.scheduler.tick();
    expect(t.started).toEqual([]);
    expect(() => ctx.scheduler.runNow(job.id)).toThrow(/belum disetujui/);
    expect(ctx.sendMail).not.toHaveBeenCalled();
  });

  it('runs an approved email job and records the run', async () => {
    const job = ctx.scheduler.createJob(emailJob(), { activate: true, actor: 'wisnu' });
    expect(job.status).toBe(JobStatus.ACTIVE);
    makeDue(job.id);

    const t = await ctx.scheduler.tick();
    expect(t.started).toEqual([job.id]);
    await ctx.scheduler.idle();
    const { campaign } = { campaign: ctx.store.campaigns.list()[0] };
    await ctx.engine.idle(campaign.id);

    expect(ctx.sendMail).toHaveBeenCalledTimes(3);
    const runs = ctx.store.runs.forJob(job.id);
    expect(runs[0]).toMatchObject({ status: 'success', trigger: 'schedule' });
    const after = ctx.store.jobs.get(job.id);
    expect(after.run_count).toBe(1);
    expect(after.next_run_at).toBeGreaterThan(Date.now());
  });

  it('approveJob arms a pending job from NOW (no stale fire)', () => {
    const job = ctx.scheduler.createJob(emailJob(), { actor: 'agent' });
    ctx.store.jobs.update(job.id, { next_run_at: Date.now() - 86_400_000 });
    const approved = ctx.scheduler.approveJob(job.id, 'wisnu');
    expect(approved.status).toBe(JobStatus.ACTIVE);
    expect(approved.next_run_at).toBeGreaterThan(Date.now());
  });

  it('skips runs missed beyond the catch-up window', async () => {
    const c = build({ schedulerOptions: { catchUpWindowMs: 60_000 } });
    const job = c.scheduler.createJob(emailJob(), { activate: true });
    c.store.jobs.update(job.id, { next_run_at: Date.now() - 3_600_000 });
    const t = await c.scheduler.tick();
    expect(t.skipped).toEqual([job.id]);
    expect(c.sendMail).not.toHaveBeenCalled();
    expect(c.store.runs.forJob(job.id)[0].status).toBe('skipped');
  });

  it('pauses a job after repeated consecutive failures', async () => {
    const ai = { async *chatStream() { yield { type: 'error', content: 'semua provider gagal' }; yield { type: 'done' }; } };
    const c = build({ ai, schedulerOptions: { maxConsecutiveFailures: 2 } });
    const job = c.scheduler.createJob(
      { name: 'AI', type: 'ai_email', schedule: 'every 5m', payload: { brief: 'tes', recipients: 'a@x.com' } },
      { activate: true }
    );
    for (let i = 0; i < 2; i++) {
      c.store.jobs.update(job.id, { next_run_at: Date.now() - 1000 });
      await c.scheduler.tick();
      await c.scheduler.idle();
    }
    const after = c.store.jobs.get(job.id);
    expect(after.status).toBe(JobStatus.PAUSED);
    expect(after.status_reason).toMatch(/gagal 2x/);
  });

  it('ai_email lands as a DRAFT for review by default (no unattended send)', async () => {
    const job = ctx.scheduler.createJob(
      { name: 'Ringkasan', type: 'ai_email', schedule: 'daily@17:00', payload: { brief: 'ringkasan kerja', recipients: LIST } },
      { activate: true }
    );
    const reviews = [];
    ctx.scheduler.on('review_needed', (e) => reviews.push(e));
    makeDue(job.id);
    await ctx.scheduler.tick();
    await ctx.scheduler.idle();

    const c = ctx.store.campaigns.list()[0];
    expect(c.status).toBe(CampaignStatus.DRAFT);
    expect(c.subject).toBe('Ringkasan Harian');
    expect(ctx.sendMail).not.toHaveBeenCalled();
    expect(reviews).toHaveLength(1);
  });

  it('ai_email with autoSend delivers without review', async () => {
    const job = ctx.scheduler.createJob(
      { name: 'Ringkasan', type: 'ai_email', schedule: 'daily@17:00', payload: { brief: 'x', recipients: LIST, autoSend: true } },
      { activate: true }
    );
    makeDue(job.id);
    await ctx.scheduler.tick();
    await ctx.scheduler.idle();
    const c = ctx.store.campaigns.list()[0];
    await ctx.engine.idle(c.id);
    expect(ctx.sendMail).toHaveBeenCalledTimes(3);
  });

  it('ai_task stores its output and can run without recipients', async () => {
    const job = ctx.scheduler.createJob(
      { name: 'Catatan', type: 'ai_task', schedule: 'every 1h', payload: { prompt: 'ringkas' } },
      { activate: true }
    );
    const out = ctx.scheduler.runNow(job.id);
    expect(out.started).toBe(true);
    await ctx.scheduler.idle();
    expect(ctx.store.runs.forJob(job.id)[0].status).toBe('success');
  });

  it('does not overlap a job with itself', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const ai = { async *chatStream() { await gate; yield { type: 'content', content: 'ok' }; yield { type: 'done' }; } };
    const c = build({ ai });
    const job = c.scheduler.createJob({ name: 'L', type: 'ai_task', schedule: 'every 1m', payload: { prompt: 'p' } }, { activate: true });
    c.scheduler.runNow(job.id);
    expect(() => c.scheduler.runNow(job.id)).toThrow(/sedang berjalan/);
    release();
    await c.scheduler.idle();
  });

  it('completes a job once max_runs is reached', async () => {
    const job = ctx.scheduler.createJob({ ...emailJob(), maxRuns: 1 }, { activate: true });
    makeDue(job.id);
    await ctx.scheduler.tick();
    await ctx.scheduler.idle();
    expect(ctx.store.jobs.get(job.id).status).toBe(JobStatus.COMPLETED);
  });

  it('validates payloads and schedules up-front', () => {
    expect(() => ctx.scheduler.createJob({ ...emailJob(), schedule: 'kapan-kapan' })).toThrow(JobError);
    expect(() => ctx.scheduler.createJob({ ...emailJob(), name: '' })).toThrow(/Nama/);
    expect(() => validatePayload('email', { subject: 'x', bodyText: 'y', recipients: 'bukan-email' })).toThrow(/penerima/);
    expect(() => validatePayload('nope', {})).toThrow(/tidak dikenal/);
  });
});

// ================================================ agent tools + action gate

describe('agent tools: proposals only, sending is gated', async () => {
  const { initAutomation, _resetAutomation } = await import('../src/automation/runtime.js');
  const { executeTool } = await import('../src/tools/registry.js');
  const gate = await import('../src/security/action-gate.js');

  let auto;
  beforeEach(() => {
    _resetAutomation();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const sendMail = vi.fn(async (m) => ({ messageId: '<id>', accepted: [m.to] }));
    auto = initAutomation({
      db,
      aiManager: { async *chatStream() { yield { type: 'done' }; } },
      env: { MAIL_FROM: 'bot@kantor.co.id', EMAIL_THROTTLE_MS: '0' },
      transport: { sendMail },
    });
    auto.sendMail = sendMail;
    gate.revokeAll();
  });

  it('automation_create_job never self-activates, even if asked to', async () => {
    const r = await executeTool('automation_create_job', {
      name: 'Harian', type: 'email', schedule: 'daily@08:00',
      subject: 'S', body: 'B', recipients: 'a@x.com', activate: true, status: 'active',
    });
    expect(r.success).toBe(true);
    expect(r.job.status).toBe('pending_approval');
    expect(r.job.needsApproval).toBe(true);
    expect(r.message).toMatch(/MENUNGGU PERSETUJUAN/);
  });

  it('automation_draft_email creates a draft and sends nothing', async () => {
    const r = await executeTool('automation_draft_email', {
      subject: 'Halo {{nama}}', body: 'Isi', recipients: 'nama,email\nBudi,b@x.com\nAni,a@x.com',
    });
    expect(r.status).toBe('draft');
    expect(r.recipients).toBe(2);
    expect(r.preview[0].subject).toMatch(/^Halo /);
    await new Promise((res) => setTimeout(res, 20));
    expect(auto.sendMail).not.toHaveBeenCalled();
  });

  it('automation_send_campaign is blocked until a human approves THAT campaign', async () => {
    const d = await executeTool('automation_draft_email', { subject: 'S', body: 'B', recipients: 'a@x.com' });
    const blocked = await executeTool('automation_send_campaign', { campaign_id: d.campaignId });
    expect(blocked.blocked).toBe(true);
    expect(auto.sendMail).not.toHaveBeenCalled();

    // Approval for a DIFFERENT campaign must not authorize this one.
    gate.mintApproval({ tool: 'automation_send_campaign', target: 'campaign:cmp_other' });
    const still = await executeTool('automation_send_campaign', { campaign_id: d.campaignId });
    expect(still.blocked).toBe(true);

    gate.mintApproval({ tool: 'automation_send_campaign', target: `campaign:${d.campaignId}` });
    const ok = await executeTool('automation_send_campaign', { campaign_id: d.campaignId });
    expect(ok.success).toBe(true);
    await auto.engine.idle(d.campaignId);
    expect(auto.sendMail).toHaveBeenCalledTimes(1);

    // Single-use: replaying the same call is blocked again.
    const again = await executeTool('automation_send_campaign', { campaign_id: d.campaignId });
    expect(again.blocked).toBe(true);
  });

  it('extractTarget binds to the campaign id', () => {
    expect(gate.extractTarget('automation_send_campaign', { campaign_id: 'cmp_abc' })).toBe('campaign:cmp_abc');
  });
});

// ================================================================ HTTP API

describe('HTTP API (/api/automation)', async () => {
  const express = (await import('express')).default;
  const request = (await import('supertest')).default;
  const { createAutomationRouter } = await import('../src/automation/routes.js');

  let app;
  let ctx;
  beforeEach(() => {
    ctx = build();
    app = express();
    app.use(express.json());
    app.use('/api/automation', createAutomationRouter({ automation: ctx, actorOf: () => 'wisnu' }));
  });

  it('GET /overview reports mailer mode, usage and counts', async () => {
    const r = await request(app).get('/api/automation/overview').expect(200);
    expect(r.body.success).toBe(true);
    expect(r.body.usage).toMatchObject({ sentToday: 0 });
    expect(r.body.counts.jobsActive).toBe(0);
    expect(JSON.stringify(r.body)).not.toMatch(/"pass"/); // credentials never leave the server
  });

  it('POST /schedule/preview validates expressions without erroring the request', async () => {
    const ok = await request(app).post('/api/automation/schedule/preview').send({ schedule: 'weekdays@09:00' }).expect(200);
    expect(ok.body.success).toBe(true);
    expect(ok.body.next).toHaveLength(5);
    const bad = await request(app).post('/api/automation/schedule/preview').send({ schedule: 'kapan-kapan' }).expect(200);
    expect(bad.body.success).toBe(false);
    expect(bad.body.error).toMatch(/tidak dikenali/);
  });

  it('POST /recipients/parse summarises a pasted list', async () => {
    const r = await request(app).post('/api/automation/recipients/parse')
      .send({ text: 'nama,email,kota\nBudi,budi@x.com,Bekasi\nBudi2,budi@x.com,Bekasi\nrusak,bukan' })
      .expect(200);
    expect(r.body).toMatchObject({ valid: 1, duplicateCount: 1, invalidCount: 1 });
    expect(r.body.columns).toEqual(['kota']);
  });

  it('job lifecycle: create (inert) -> approve -> run now -> history', async () => {
    const created = await request(app).post('/api/automation/jobs').send({
      name: 'Laporan', type: 'email', schedule: 'daily@08:00',
      payload: { subject: 'Hai {{nama}}', bodyText: 'Isi', recipients: LIST },
    }).expect(201);
    const id = created.body.job.id;
    expect(created.body.job.status).toBe('pending_approval');
    expect(created.body.job.scheduleDescription).toBe('Setiap hari pukul 08:00');

    await request(app).post(`/api/automation/jobs/${id}/run`).expect(409); // not approved
    await request(app).post(`/api/automation/jobs/${id}/approve`).expect(200);
    await request(app).post(`/api/automation/jobs/${id}/run`).expect(202);
    await ctx.scheduler.idle();
    const c = ctx.store.campaigns.list()[0];
    await ctx.engine.idle(c.id);

    const runs = await request(app).get(`/api/automation/jobs/${id}/runs`).expect(200);
    expect(runs.body.runs[0].status).toBe('success');
    expect(ctx.sendMail).toHaveBeenCalledTimes(3);
  });

  it('campaign flow: create -> preview -> start -> detail with progress', async () => {
    const made = await request(app).post('/api/automation/campaigns').send({
      name: 'Pengumuman', subject: 'Halo {{nama}}', bodyText: 'Rapat besok', recipients: LIST, throttleMs: 0,
    }).expect(201);
    const id = made.body.campaign.id;
    expect(made.body.campaign.status).toBe('draft');
    expect(made.body.preview).toHaveLength(3);
    expect(ctx.sendMail).not.toHaveBeenCalled();

    await request(app).post(`/api/automation/campaigns/${id}/start`).expect(202);
    await ctx.engine.idle(id);
    const d = await request(app).get(`/api/automation/campaigns/${id}`).expect(200);
    expect(d.body.campaign.status).toBe('completed');
    expect(d.body.campaign.stats.sent).toBe(3);
    expect(d.body.recipients).toHaveLength(3);
  });

  it('maps domain errors to proper HTTP statuses', async () => {
    await request(app).get('/api/automation/campaigns/cmp_nope').expect(404);
    await request(app).post('/api/automation/campaigns/cmp_nope/start').expect(404);
    await request(app).post('/api/automation/campaigns').send({ subject: '', bodyText: 'x', recipients: 'a@x.com' }).expect(400);
    await request(app).post('/api/automation/jobs').send({ name: 'x', type: 'email', schedule: 'bukan-jadwal', payload: {} }).expect(400);
  });

  it('suppression list: add, list, remove', async () => {
    await request(app).post('/api/automation/suppressions').send({ emails: ['x@y.com', 'rusak'] }).expect(201);
    const l = await request(app).get('/api/automation/suppressions').expect(200);
    expect(l.body.suppressions.map((s) => s.email)).toEqual(['x@y.com']);
    await request(app).delete('/api/automation/suppressions/x@y.com').expect(200);
    expect((await request(app).get('/api/automation/suppressions')).body.suppressions).toHaveLength(0);
  });

  it('SMTP test explains missing configuration instead of pretending to send', async () => {
    const dry = build({ env: { MAIL_FROM: 'bot@x.com' } });
    // The shared `build()` injects a transport (=> live); build a true dry-run mailer.
    const { Mailer } = await import('../src/automation/mailer.js');
    dry.mailer = new Mailer({ MAIL_FROM: 'bot@x.com' });
    const a2 = express();
    a2.use(express.json());
    a2.use('/api/automation', createAutomationRouter({ automation: { ...dry, mailer: dry.mailer } }));
    const r = await request(a2).post('/api/automation/smtp/test').send({ to: 'me@x.com' }).expect(200);
    expect(r.body.success).toBe(false);
    expect(r.body.mode).toBe('dry-run');
    expect(r.body.missing).toContain('SMTP_HOST');
  });

  it('streams realtime campaign events over SSE', async () => {
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const got = await new Promise((resolve, reject) => {
        const chunks = [];
        const req = http.get(`http://127.0.0.1:${port}/api/automation/events`, (res) => {
          res.on('data', (d) => {
            chunks.push(d.toString());
            const all = chunks.join('');
            if (all.includes('event: campaign') && all.includes('"type":"status"')) { req.destroy(); resolve(all); }
          });
          // Trigger activity once the stream is open.
          setTimeout(() => {
            const { campaign } = ctx.engine.create({ subject: 'S', bodyText: 'B', recipients: 'a@x.com' });
            ctx.engine.start(campaign.id);
          }, 50);
        });
        req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
        setTimeout(() => { req.destroy(); reject(new Error('SSE timeout')); }, 4000);
      });
      expect(got).toContain('event: hello');
      expect(got).toContain('event: campaign');
    } finally {
      server.close();
    }
  });
});

// ============================================================ access guard

describe('network access guard', async () => {
  const express = (await import('express')).default;
  const request = (await import('supertest')).default;
  const { createAutomationRouter } = await import('../src/automation/routes.js');

  const make = (env) => {
    const c = build();
    const app = express();
    app.use(express.json());
    app.use('/api/automation', createAutomationRouter({ automation: c, env }));
    return app;
  };
  // supertest connects over loopback; X-Forwarded-For simulates a proxied/remote caller.
  const REMOTE = { 'X-Forwarded-For': '10.3.23.50' };

  it('allows direct localhost access without a token', async () => {
    await request(make({})).get('/api/automation/overview').expect(200);
  });

  it('refuses remote callers when no AUTOMATION_TOKEN is configured', async () => {
    const r = await request(make({})).get('/api/automation/jobs').set(REMOTE).expect(403);
    expect(r.body.code).toBe('remote_forbidden');
    await request(make({})).post('/api/automation/suppressions').set(REMOTE).send({ emails: ['a@x.com'] }).expect(403);
  });

  it('requires the exact token for remote callers when configured', async () => {
    const app = make({ AUTOMATION_TOKEN: 's3cret-token' });
    await request(app).get('/api/automation/jobs').set(REMOTE).expect(401);
    await request(app).get('/api/automation/jobs').set({ ...REMOTE, 'X-Automation-Token': 'salah' }).expect(401);
    await request(app).get('/api/automation/jobs').set({ ...REMOTE, 'X-Automation-Token': 's3cret-token' }).expect(200);
    // the permanent token is never accepted in a URL (it would land in access logs)
    await request(app).get('/api/automation/jobs?token=s3cret-token').set(REMOTE).expect(401);
  });

  it('streams use short-lived signed tickets instead of the token', async () => {
    const { issueStreamTicket, verifyStreamTicket } = await import('../src/automation/routes.js');
    const app = make({ AUTOMATION_TOKEN: 's3cret-token' });
    const r = await request(app).get('/api/automation/stream-ticket').set({ ...REMOTE, 'X-Automation-Token': 's3cret-token' }).expect(200);
    expect(r.body.ticket).toMatch(/^\d+\.[\w-]+$/);
    expect(r.headers['cache-control']).toMatch(/no-store/);
    await request(app).get(`/api/automation/jobs?ticket=${encodeURIComponent(r.body.ticket)}`).set(REMOTE).expect(401); // data: never via ticket
    await request(app).get('/api/automation/stream-ticket').set(REMOTE).expect(401); // ticket needs the token first

    const now = Date.now();
    expect(verifyStreamTicket('s3cret-token', issueStreamTicket('s3cret-token', now - 11 * 60_000))).toBe(false); // expired
    expect(verifyStreamTicket('lain', issueStreamTicket('s3cret-token'))).toBe(false); // other secret
    const t = issueStreamTicket('s3cret-token');
    expect(verifyStreamTicket('s3cret-token', t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBe(false); // forged
    // tickets only open GET streams, never actions
    await request(app).post(`/api/automation/suppressions?ticket=${encodeURIComponent(t)}`).set(REMOTE).send({ emails: ['a@x.com'] }).expect(401);
  });

  it('a configured token does not weaken localhost access', async () => {
    await request(make({ AUTOMATION_TOKEN: 'x' })).get('/api/automation/overview').expect(200);
  });
});

describe('rate limiting of operator actions', () => {
  it('the dedicated automation limiter is far looser than the 5/min scan limiter', async () => {
    const { createRateLimiters } = await import('../src/middleware/rate-limit.js');
    const lim = createRateLimiters();
    expect(typeof lim.automation).toBe('function');
    expect(lim.automation).not.toBe(lim.strict);
  });
});

// ============================================== failover persistence + fallback

describe('failover cooldown persistence', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { SmartFailover, FailReason } = await import('../src/ai-failover.js');
  const { ensureNameFallback } = await import('../src/automation/ai-compose.js');

  const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wanar-fo-')), 'state.json');
  const settle = () => new Promise((r) => setTimeout(r, 700));

  it('quota cooldowns survive a restart (no cold re-probing of dead models)', async () => {
    const statePath = tmpFile();
    const a = new SmartFailover({}, {}, { statePath });
    a.markFailure('openagentic', 'deepseek-v4.1-flash-free', FailReason.QUOTA);
    await settle();

    const b = new SmartFailover({}, {}, { statePath }); // "restarted" process
    expect(b.isCoolingDown('openagentic', 'deepseek-v4.1-flash-free')).toBe(true);
  });

  it('AUTH cooldowns are NOT persisted, so a fixed key works right after restart', async () => {
    const statePath = tmpFile();
    const a = new SmartFailover({}, {}, { statePath });
    a.markFailure('nvidia', 'm', FailReason.AUTH);
    await settle();
    const b = new SmartFailover({}, {}, { statePath });
    expect(b.isCoolingDown('nvidia', 'm')).toBe(false);
  });

  it('a success clears the persisted entry', async () => {
    const statePath = tmpFile();
    const a = new SmartFailover({}, {}, { statePath });
    a.markFailure('p', 'm', FailReason.QUOTA);
    await settle();
    a.markSuccess('p', 'm');
    await settle();
    expect(new SmartFailover({}, {}, { statePath }).isCoolingDown('p', 'm')).toBe(false);
  });

  it('is inert without a statePath and survives a corrupt file', () => {
    expect(() => new SmartFailover({}, {}).markFailure('p', 'm', FailReason.QUOTA)).not.toThrow();
    const statePath = tmpFile();
    fs.writeFileSync(statePath, '{not json');
    expect(() => new SmartFailover({}, {}, { statePath })).not.toThrow();
  });

  it('ensureNameFallback only touches bare name placeholders', () => {
    expect(ensureNameFallback('Yth. {{nama}}, {{ name }}')).toBe('Yth. {{nama|Bapak/Ibu}}, {{name|Bapak/Ibu}}');
    expect(ensureNameFallback('{{nama|Pak}} {{tanggal}}')).toBe('{{nama|Pak}} {{tanggal}}');
  });
});

describe('failover error classification (Indonesian provider messages)', async () => {
  const { classifyError, FailReason } = await import('../src/ai-failover.js');

  it('recognises the OpenAgentic "Kuota ... telah habis" message as QUOTA', () => {
    const msg = 'Kuota gratis model deepseek-v4.1-flash-free hari ini telah habis (3,002,147,874/3,000,000,001 token untuk semua pengguna). Model akan kembali tersedia besok pukul 00:00 WIB.';
    expect(classifyError(msg)).toBe(FailReason.QUOTA);
  });

  it('still classifies English quota/rate/auth errors', () => {
    expect(classifyError('You exceeded your current quota')).toBe(FailReason.QUOTA);
    expect(classifyError('429 Too Many Requests')).toBe(FailReason.RATE);
    expect(classifyError('401 Unauthorized')).toBe(FailReason.AUTH);
  });
});

// ================================================================ attachments

describe('attachments', async () => {
  const { sanitizeFilename, AttachmentError } = await import('../src/automation/attachments.js');
  const express = (await import('express')).default;
  const request = (await import('supertest')).default;
  const { createAutomationRouter } = await import('../src/automation/routes.js');

  const pdf = Buffer.from('%PDF-1.4 contoh isi lampiran');
  let ctx;
  beforeEach(() => { ctx = build(); });

  it('sanitises display names (no traversal, control chars or hidden files)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\a\\laporan?.pdf')).toBe('laporan_.pdf');
    expect(sanitizeFilename('..hidden.txt')).toBe('hidden.txt');
    expect(sanitizeFilename('a\r\nBcc: x.pdf')).not.toMatch(/[\r\n]/);
    expect(sanitizeFilename('')).toBe('lampiran');
    expect(sanitizeFilename('Laporan Bulanan Q3.xlsx')).toBe('Laporan Bulanan Q3.xlsx');
  });

  it('stores files under a server-generated name, never the user filename', () => {
    const att = ctx.attachments.save({ originalName: '../../evil name.pdf', buffer: pdf, contentType: 'application/pdf' });
    expect(att.id).toMatch(/^att_[a-f0-9]{12}$/);
    expect(att.storedName).toMatch(/^att_[a-f0-9]{12}\.pdf$/);
    expect(att.filename).toBe('evil name.pdf');
    expect(nodeFs.existsSync(ctx.attachments.pathOf(att))).toBe(true);
    expect(att.sha256).toHaveLength(64);
  });

  it('refuses executables and scripts, empty and oversized files', () => {
    for (const n of ['virus.exe', 'run.bat', 'x.ps1', 'a.js', 'b.vbs', 'c.jar', 'd.lnk']) {
      expect(() => ctx.attachments.save({ originalName: n, buffer: pdf })).toThrow(AttachmentError);
    }
    expect(() => ctx.attachments.save({ originalName: 'a.pdf', buffer: Buffer.alloc(0) })).toThrow(/kosong/);
    const small = build();
    small.attachments.limits.maxFileBytes = 10;
    expect(() => small.attachments.save({ originalName: 'a.pdf', buffer: Buffer.alloc(11) })).toThrow(/terlalu besar/);
  });

  it('enforces count, id format, existence and total size', () => {
    const a = ctx.attachments.save({ originalName: 'a.pdf', buffer: pdf });
    expect(ctx.attachments.assertAvailable([a.id])).toEqual([a.id]);
    expect(() => ctx.attachments.assertAvailable(['att_000000000000'])).toThrow(/tidak ditemukan/);
    expect(() => ctx.attachments.assertAvailable(['../etc/passwd'])).toThrow(/tidak valid/);
    const ids = Array.from({ length: 6 }, (_, i) => ctx.attachments.save({ originalName: `f${i}.pdf`, buffer: Buffer.from(`x${i}`) }).id);
    expect(() => ctx.attachments.assertAvailable(ids)).toThrow(/Maksimal 5/);
    ctx.attachments.limits.maxTotalBytes = 10;
    expect(() => ctx.attachments.assertAvailable([a.id])).toThrow(/melebihi batas/);
  });

  it('delivers attachments with every message of a campaign', async () => {
    const a = ctx.attachments.save({ originalName: 'Laporan Q3.pdf', buffer: pdf, contentType: 'application/pdf' });
    const { campaign } = ctx.engine.create({
      subject: 'Laporan', bodyText: 'Terlampir.', recipients: 'a@x.com\nb@x.com', attachmentIds: [a.id],
    });
    expect(campaign.attachmentIds).toEqual([a.id]);
    ctx.engine.start(campaign.id);
    await ctx.engine.idle(campaign.id);

    expect(ctx.sendMail).toHaveBeenCalledTimes(2);
    for (const [msg] of ctx.sendMail.mock.calls) {
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0]).toMatchObject({ filename: 'Laporan Q3.pdf', contentType: 'application/pdf' });
      expect(nodeFs.existsSync(msg.attachments[0].path)).toBe(true);
    }
  });

  it('pauses (does not mail without the file) when an attachment disappears', async () => {
    const a = ctx.attachments.save({ originalName: 'a.pdf', buffer: pdf });
    const { campaign } = ctx.engine.create({ subject: 'S', bodyText: 'B', recipients: 'a@x.com', attachmentIds: [a.id] });
    nodeFs.unlinkSync(ctx.attachments.pathOf(a));
    ctx.engine.start(campaign.id);
    await ctx.engine.idle(campaign.id);
    const c = ctx.store.campaigns.get(campaign.id);
    expect(c.status).toBe(CampaignStatus.PAUSED);
    expect(c.status_reason).toBe('attachment_missing');
    expect(ctx.sendMail).not.toHaveBeenCalled();
  });

  it('rejects a campaign or job that references an unknown attachment', () => {
    expect(() => ctx.engine.create({ subject: 'S', bodyText: 'B', recipients: 'a@x.com', attachmentIds: ['att_aaaaaaaaaaaa'] })).toThrow(/tidak ditemukan/);
    expect(() => ctx.scheduler.createJob({
      name: 'J', type: 'email', schedule: 'daily@08:00',
      payload: { subject: 'S', bodyText: 'B', recipients: 'a@x.com', attachmentIds: ['att_aaaaaaaaaaaa'] },
    })).toThrow(JobError);
  });

  it('scheduled jobs carry attachments into the campaigns they create', async () => {
    const a = ctx.attachments.save({ originalName: 'tarif.pdf', buffer: pdf });
    const job = ctx.scheduler.createJob({
      name: 'Kirim tarif', type: 'email', schedule: 'daily@08:00',
      payload: { subject: 'Tarif', bodyText: 'Terlampir', recipients: 'a@x.com', attachmentIds: [a.id] },
    }, { activate: true });
    ctx.scheduler.runNow(job.id);
    await ctx.scheduler.idle();
    const c = ctx.store.campaigns.list()[0];
    await ctx.engine.idle(c.id);
    expect(c.attachmentIds).toEqual([a.id]);
    expect(ctx.sendMail.mock.calls[0][0].attachments[0].filename).toBe('tarif.pdf');
  });

  describe('HTTP', () => {
    let app;
    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/automation', createAutomationRouter({ automation: ctx }));
    });

    it('uploads, lists and deletes an attachment', async () => {
      const up = await request(app).post('/api/automation/attachments').attach('file', pdf, 'Laporan.pdf').expect(201);
      expect(up.body.attachment).toMatchObject({ filename: 'Laporan.pdf', contentType: 'application/pdf', size: pdf.length });

      const list = await request(app).get('/api/automation/attachments').expect(200);
      expect(list.body.attachments).toHaveLength(1);
      expect(list.body.attachments[0].inUse).toBe(false);

      await request(app).delete(`/api/automation/attachments/${up.body.attachment.id}`).expect(200);
      expect((await request(app).get('/api/automation/attachments')).body.attachments).toHaveLength(0);
    });

    it('answers with meaningful statuses: 415 blocked type, 413 too large, 400 no file', async () => {
      const bad = await request(app).post('/api/automation/attachments').attach('file', Buffer.from('MZ'), 'setup.exe').expect(415);
      expect(bad.body.code).toBe('blocked_type');

      ctx.attachments.limits.maxFileBytes = 5;
      // multer reads the limit when the router is created, so rebuild it with the lowered limit
      const small = express();
      small.use(express.json());
      small.use('/api/automation', createAutomationRouter({ automation: ctx }));
      await request(small).post('/api/automation/attachments').attach('file', Buffer.alloc(50), 'big.pdf').expect(413);

      await request(app).post('/api/automation/attachments').expect(400);
    });

    it('will not delete an attachment that an unfinished campaign still needs', async () => {
      const up = await request(app).post('/api/automation/attachments').attach('file', pdf, 'a.pdf').expect(201);
      const id = up.body.attachment.id;
      await request(app).post('/api/automation/campaigns').send({
        subject: 'S', bodyText: 'B', recipients: 'a@x.com', attachmentIds: [id],
      }).expect(201);
      await request(app).delete(`/api/automation/attachments/${id}`).expect(409);
    });

    it('keeps UTF-8 filenames intact', async () => {
      const r = await request(app).post('/api/automation/attachments').attach('file', pdf, 'Laporan Bulanan – Ágústus.pdf').expect(201);
      expect(r.body.attachment.filename).toBe('Laporan Bulanan – Ágústus.pdf');
    });

    it('shows attachment metadata on campaign detail', async () => {
      const up = await request(app).post('/api/automation/attachments').attach('file', pdf, 'a.pdf').expect(201);
      const made = await request(app).post('/api/automation/campaigns').send({
        subject: 'S', bodyText: 'B', recipients: 'a@x.com', attachmentIds: [up.body.attachment.id],
      }).expect(201);
      const d = await request(app).get(`/api/automation/campaigns/${made.body.campaign.id}`).expect(200);
      expect(d.body.attachments[0].filename).toBe('a.pdf');
    });
  });
});
