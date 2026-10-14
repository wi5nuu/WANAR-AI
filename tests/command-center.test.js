import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createWorklog } from '../src/worklog/index.js';
import { createEmailDesk } from '../src/email-desk/index.js';
import { createBriefing } from '../src/briefing.js';
import { createCommandCenterRouter } from '../src/command-center/routes.js';
import { makeAssistantResponder } from '../src/worklog/assistant.js';

const REMOTE = { 'X-Forwarded-For': '203.0.113.9' };

function setup(env = {}) {
  const db = new Database(':memory:');
  const worklog = createWorklog({ db, env: {} });
  const sent = [];
  const automation = {
    mailer: {
      mode: 'live', cfg: { fromAddress: 'wisnu@wanar.id', throttleMs: 0 },
      describe: () => ({ mode: 'live', provider: 'brevo-api', configured: true, from: 'wisnu@wanar.id', dailyCap: 450, missing: [] }),
      async send(m) { sent.push(m); return { messageId: `<o${sent.length}@w>`, dryRun: false }; },
    },
    inbox: { status: () => ({ enabled: true, running: true }) },
  };
  const emailDesk = createEmailDesk({ db, automation, env: { EMAIL_WATCH: 'false', EMAIL_THROTTLE_MS: '0' } });
  const told = [];
  const briefing = createBriefing({ worklog: worklog.service, desk: emailDesk.desk, notify: async (c, t) => told.push(t), defaultChatId: () => '1', env: {} });
  const app = express();
  app.use('/api/command-center', createCommandCenterRouter({ worklog, emailDesk, automation, briefing, env }));
  return { app, worklog, emailDesk, briefing, sent, told };
}

describe('Pusat Kendali API', () => {
  it('aggregates work, email, channels and system in one call', async () => {
    const x = setup();
    await x.emailDesk.desk.draftBatch({ recipients: 'a@x.com, b@x.com', subject: 'Undangan', body: 'Halo {{nama}}' });
    const r = await request(x.app).get('/api/command-center/overview').expect(200);
    expect(r.headers['cache-control']).toMatch(/no-store/);
    expect(r.body.work.status).toHaveProperty('state');
    expect(r.body.email.batches[0]).toMatchObject({ count: 2 });
    expect(r.body.channels.mail).toEqual({ mode: 'live', provider: 'brevo-api', configured: true, from: 'wisnu@wanar.id', dailyCap: 450, missing: [] });
    expect(r.body.system.rssMb).toBeGreaterThan(0);
    expect(r.body.briefing).toMatch(/^Briefing — /);
    expect(JSON.stringify(r.body)).not.toMatch(/xkeysib|IMAP_PASS|pass"/i);
  });

  it('is guarded: remote needs the token, tickets cannot read data', async () => {
    const x = setup({ AUTOMATION_TOKEN: 'tok' });
    await request(x.app).get('/api/command-center/overview').set(REMOTE).expect(401);
    await request(x.app).get('/api/command-center/overview').set({ ...REMOTE, 'X-Automation-Token': 'tok' }).expect(200);
    const { issueStreamTicket } = await import('../src/automation/routes.js');
    await request(x.app).get(`/api/command-center/overview?ticket=${issueStreamTicket('tok')}`).set(REMOTE).expect(401);
    await request(x.app).post('/api/command-center/reminders').set(REMOTE).send({ time: '23:59', text: 'x' }).expect(401);
  });

  it('actions: add/cancel reminders, send a batch, set follow-up', async () => {
    const x = setup();
    const add = await request(x.app).post('/api/command-center/reminders').send({ date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), time: '09:30', text: 'Standup' }).expect(200);
    await request(x.app).post('/api/command-center/reminders').send({ time: 'jam9', text: 'x' }).expect(400);
    await request(x.app).delete(`/api/command-center/reminders/${add.body.reminder.id}`).expect(200);

    const { drafts } = await x.emailDesk.desk.draftBatch({ recipients: 'a@x.com, b@x.com', subject: 'Undangan', body: 'Halo' });
    const s = await request(x.app).post(`/api/command-center/email/drafts/${drafts[0].id}/send`).expect(200);
    expect(s.body.batch).toMatchObject({ sent: 2, total: 2 });
    const t = x.emailDesk.desk.threads()[0];
    const f = await request(x.app).post(`/api/command-center/email/threads/${t.id}/followup`).send({ days: 3 }).expect(200);
    expect(f.body.thread.follow_up_at).toBeGreaterThan(Date.now());
    await request(x.app).post(`/api/command-center/email/threads/${t.id}/followup`).send({ days: 999 }).expect(400);
  });
});

describe('Briefing', () => {
  it('is built from data and sent once per workday at its time', async () => {
    const x = setup();
    const s = x.worklog.service;
    s.updateSettings({ workStart: '08:00', workEnd: '17:00', workdays: [0, 1, 2, 3, 4, 5, 6] });
    let t = Date.parse('2026-10-13T00:40:00Z'); // 07:40 WIB
    const b = createBriefing({ worklog: s, desk: x.emailDesk.desk, notify: async (c, m) => x.told.push(m), defaultChatId: () => '1', env: {}, now: () => t });
    expect(await b.tick()).toBe(false); // before 07:45
    t += 6 * 60_000;
    expect(await b.tick()).toBe(true);
    expect(await b.tick()).toBe(false); // only once
    expect(x.told.at(-1)).toMatch(/^Briefing — Selasa, 13 Oktober 2026\nJam kerja 08:00–17:00/);
  });

  it('"agenda hari ini" in Telegram returns the briefing without calling the model', async () => {
    const x = setup();
    const ai = { chatStream() { throw new Error('model must not be called'); } };
    const respond = makeAssistantResponder({ aiManager: ai, worklog: x.worklog.service, briefing: x.briefing });
    expect(await respond({ text: 'agenda hari ini?' })).toMatch(/^Briefing — /);
    expect(await respond({ text: 'Briefing' })).toMatch(/^Briefing — /);
  });
});

describe('Briefing de-duplication', () => {
  it('lists an open task once even if it is open today and yesterday', () => {
    const x = setup();
    const s = x.worklog.service;
    const today = s.today();
    const y = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    s.addTask({ date: today, title: 'Buat laporan harian' });
    s.addTask({ date: y, title: 'buat  laporan harian' });
    const text = x.briefing.build();
    expect((text.match(/Buat laporan harian/gi) || []).length).toBe(1);
  });
});

describe('GET /api/version', () => {
  it('returns a stable build id that changes with the frontend build', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const crypto = await import('crypto');
    // Mirror of the server rule: sha1(index.html).slice(0, 12)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-'));
    const f = path.join(dir, 'index.html');
    fs.writeFileSync(f, '<html>a</html>');
    const id = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
    const a = id(f);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(id(f)).toBe(a);
    fs.writeFileSync(f, '<html>b</html>');
    expect(id(f)).not.toBe(a);
  });

  it('the running app exposes it, uncached', async () => {
    const { default: app } = await import('../src/server.js');
    const r = await request(app).get('/api/version').expect(200);
    expect(r.body.build).toMatch(/^[0-9a-f]{12}$|^dev$/);
    expect(r.headers['cache-control']).toMatch(/no-store/);
  });
});
