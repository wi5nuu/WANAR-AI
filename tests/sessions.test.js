/**
 * Test Suite: session housekeeping + test isolation
 *
 * Regression: automated tests used to write straight into the operator's real
 * data/wanar.db, filling the chat sidebar with junk sessions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';

import * as db from '../src/database.js';
import app from '../src/server.js';

const mk = (title = 'New Chat') => {
  const id = crypto.randomUUID();
  db.createSession(id, title, 'openagentic', 'm');
  return id;
};

describe('test isolation', () => {
  it('uses a private in-memory database, never data/wanar.db', () => {
    expect(db.DB_LOCATION).toBe(':memory:');
  });
});

describe('deleteEmptySessions', () => {
  beforeEach(() => {
    for (const s of db.getSessions(1000)) db.deleteSession(s.id);
  });

  it('removes only sessions that have no messages', () => {
    const empty = mk('kosong');
    const real = mk('obrolan asli');
    db.addMessage(real, 'user', 'halo', 1, 'openagentic', 'm');

    expect(db.deleteEmptySessions(0)).toBe(1);
    const ids = db.getSessions(100).map((s) => s.id);
    expect(ids).toContain(real);
    expect(ids).not.toContain(empty);
  });

  it('protects a session created moments ago when a grace period is given', () => {
    const fresh = mk('baru dibuka');
    expect(db.deleteEmptySessions(5)).toBe(0);
    expect(db.getSessions(100).map((s) => s.id)).toContain(fresh);
  });

  it('exposes msg_count so the UI can hide empty rows', () => {
    const a = mk('a');
    const b = mk('b');
    db.addMessage(b, 'user', 'x', 1, 'p', 'm');
    db.addMessage(b, 'assistant', 'y', 1, 'p', 'm');
    const byId = Object.fromEntries(db.getSessions(100).map((s) => [s.id, s.msg_count]));
    expect(byId[a]).toBe(0);
    expect(byId[b]).toBe(2);
  });

  it('treats an unreadable grace value as the protective default, not as zero', () => {
    const fresh = mk('baru dibuka');
    expect(() => db.deleteEmptySessions("0'; DROP TABLE chat_sessions;--")).not.toThrow();
    expect(db.deleteEmptySessions(undefined)).toBe(0);
    expect(db.getSessions(10).map((s) => s.id)).toContain(fresh);
  });
});

describe('POST /api/sessions/cleanup', () => {
  it('deletes empty sessions and keeps conversations', async () => {
    const empty = mk('kosong');
    const real = mk('asli');
    db.addMessage(real, 'user', 'halo', 1, 'p', 'm');

    const r = await request(app).post('/api/sessions/cleanup').expect(200);
    expect(r.body.success).toBe(true);
    expect(r.body.deleted).toBeGreaterThanOrEqual(1);

    const list = (await request(app).get('/api/sessions').expect(200)).body;
    const ids = list.map((s) => s.id);
    expect(ids).toContain(real);
    expect(ids).not.toContain(empty);
    expect(list.find((s) => s.id === real).msg_count).toBe(1);
  });
});
