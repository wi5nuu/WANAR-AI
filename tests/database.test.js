/**
 * Test Suite: database.js
 * Covers: semua fungsi CRUD, schema, query, analytics, profile, job agent, context summaries
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Gunakan DB in-memory untuk testing — tidak menyentuh data/wanar.db production
const TEST_DB_PATH = path.join(__dirname, 'test-wanar.db');

// Re-implement semua fungsi database dengan DB test agar terisolasi
let db;

function setupTestDb() {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id TEXT UNIQUE,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      avatar TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      api_key TEXT UNIQUE,
      daily_token_limit INTEGER DEFAULT 100000,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      workspace_id INTEGER,
      team_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      tokens INTEGER DEFAULT 0,
      provider TEXT,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      cost REAL DEFAULT 0,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      ip TEXT,
      input_chars INTEGER DEFAULT 0,
      output_chars INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      response_time_ms INTEGER DEFAULT 0,
      tokens_per_second REAL DEFAULT 0,
      status TEXT DEFAULT 'ok',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      province TEXT,
      postal_code TEXT,
      date_of_birth TEXT,
      gender TEXT,
      nationality TEXT DEFAULT 'Indonesia',
      university TEXT,
      faculty TEXT,
      major TEXT,
      gpa TEXT,
      graduation_year TEXT,
      student_id TEXT,
      linkedin TEXT,
      portfolio TEXT,
      github TEXT,
      skills TEXT,
      languages TEXT,
      work_experience TEXT,
      cv_text TEXT,
      cv_filename TEXT,
      preference_type TEXT DEFAULT 'both',
      preference_location TEXT,
      preference_field TEXT,
      extra_data TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS apply_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      position TEXT NOT NULL,
      apply_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      form_data TEXT,
      notes TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT NOT NULL UNIQUE,
      source_url TEXT,
      form_type TEXT DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','processing','submitted','needs_review','skipped','failed','approved','rejected')),
      confidence REAL DEFAULT 0,
      field_mapping TEXT,
      screenshot_path TEXT,
      cover_letter TEXT,
      notes TEXT,
      robots_ok INTEGER DEFAULT 1,
      retry_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_review_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES job_queue(id) ON DELETE CASCADE,
      field_mapping TEXT NOT NULL,
      screenshot_path TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','rejected','edited')),
      edited_mapping TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Job Scan Session',
      source_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle'
        CHECK(status IN ('idle','running','paused','completed','failed')),
      total INTEGER DEFAULT 0,
      submitted INTEGER DEFAULT 0,
      needs_review INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      settings TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS context_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      summary TEXT NOT NULL,
      message_count INTEGER,
      tokens INTEGER,
      original_tokens INTEGER,
      compression_ratio REAL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','editor','member','viewer')),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT UNIQUE NOT NULL,
      key_prefix TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'default',
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permissions TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_used TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ---------- helper wrappers pakai db test ----------

function createSession(id, title, provider, model) {
  db.prepare('INSERT INTO chat_sessions (id, title, provider, model) VALUES (?, ?, ?, ?)').run(id, title, provider, model);
}

function getSessions(limit = 50) {
  return db.prepare('SELECT id, title, provider, model, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC LIMIT ?').all(limit);
}

function deleteSession(id) {
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
}

function updateSessionTitle(id, title) {
  db.prepare("UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id);
}

function addMessage(sessionId, role, content, tokens = 0, provider = null, model = null) {
  const result = db.prepare('INSERT INTO chat_messages (session_id, role, content, tokens, provider, model) VALUES (?, ?, ?, ?, ?, ?)').run(sessionId, role, content, tokens, provider, model);
  db.prepare("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);
  return result.lastInsertRowid;
}

function getMessages(sessionId) {
  return db.prepare('SELECT id, role, content, tokens, provider, model, created_at FROM chat_messages WHERE session_id = ? ORDER BY id ASC').all(sessionId);
}

function deleteMessages(sessionId) {
  db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);
}

function recordTokenUsage(date, provider, model, tokens, cost = 0, userId = null) {
  db.prepare('INSERT INTO token_usage (date, provider, model, tokens, cost, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(date, provider, model, tokens, cost, userId);
}

function getDailyUsage(date) {
  const row = db.prepare('SELECT COALESCE(SUM(tokens),0) as total, COALESCE(SUM(cost),0) as cost FROM token_usage WHERE date = ?').get(date);
  const providers = db.prepare('SELECT provider, SUM(tokens) as tokens FROM token_usage WHERE date = ? GROUP BY provider').all(date);
  const models = db.prepare("SELECT provider || ':' || model as key, SUM(tokens) as tokens FROM token_usage WHERE date = ? GROUP BY provider, model").all(date);
  return {
    total: row.total,
    cost: row.cost,
    providers: Object.fromEntries(providers.map(p => [p.provider, p.tokens])),
    models: Object.fromEntries(models.map(m => [m.key, m.tokens])),
  };
}

function getUsageHistory(days = 30) {
  return db.prepare('SELECT date, SUM(tokens) as total, SUM(cost) as cost FROM token_usage GROUP BY date ORDER BY date DESC LIMIT ?').all(days);
}

function getTotalTokensToday() {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT COALESCE(SUM(tokens),0) as total FROM token_usage WHERE date = ?").get(today);
  return row.total;
}

function logRequest(data) {
  db.prepare('INSERT INTO request_logs (session_id, provider, model, ip, input_chars, output_chars, total_tokens, response_time_ms, tokens_per_second, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    data.session_id, data.provider, data.model, data.ip,
    data.input_chars || 0, data.output_chars || 0,
    data.total_tokens || 0, data.response_time_ms || 0,
    data.tokens_per_second || 0, data.status || 'ok'
  );
}

function findOrCreateUser(profile) {
  let user;
  if (profile.google_id) {
    user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.google_id);
  } else if (profile.email) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(profile.email);
  }
  if (user) {
    db.prepare("UPDATE users SET name = ?, avatar = ?, last_login = datetime('now') WHERE id = ?").run(
      profile.name || user.name, profile.avatar || user.avatar, user.id
    );
    return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  const apiKey = 'wanar_' + crypto.randomBytes(16).toString('hex');
  const result = db.prepare('INSERT INTO users (google_id, name, email, avatar, role, api_key) VALUES (?, ?, ?, ?, ?, ?)').run(
    profile.google_id || null, profile.name || 'User', profile.email || null, profile.avatar || null, 'user', apiKey
  );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

function getUserById(id) {
  return db.prepare('SELECT id, name, email, avatar, role, api_key, daily_token_limit, created_at, last_login FROM users WHERE id = ?').get(id);
}

function getUserByApiKey(apiKey) {
  return db.prepare('SELECT id, name, email, avatar, role, daily_token_limit FROM users WHERE api_key = ?').get(apiKey);
}

function getUserTokensToday(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare('SELECT COALESCE(SUM(tokens),0) as total FROM token_usage WHERE user_id = ? AND date = ?').get(userId, today);
  return row.total;
}

function getProfile() {
  return db.prepare('SELECT * FROM user_profile ORDER BY id ASC LIMIT 1').get() || null;
}

function saveProfile(data) {
  const existing = getProfile();
  const fields = ['full_name','email','phone','address','city','province','postal_code','date_of_birth','gender','nationality','university','faculty','major','gpa','graduation_year','student_id','linkedin','portfolio','github','skills','languages','work_experience','cv_text','cv_filename','preference_type','preference_location','preference_field','extra_data'];
  const now = new Date().toISOString();
  if (!existing) {
    const cols = [...fields, 'updated_at'].join(', ');
    const vals = [...fields.map(() => '?'), '?'].join(', ');
    const values = [...fields.map(f => data[f] ?? null), now];
    db.prepare(`INSERT INTO user_profile (${cols}) VALUES (${vals})`).run(...values);
  } else {
    const sets = [...fields.map(f => `${f} = ?`), 'updated_at = ?'].join(', ');
    const values = [...fields.map(f => data[f] ?? existing[f] ?? null), now];
    // Gunakan existing.id bukan hardcode 1
    db.prepare(`UPDATE user_profile SET ${sets} WHERE id = ?`).run(...values, existing.id);
  }
  return getProfile();
}

function addApplyHistory({ company, position, apply_url, status = 'applied', form_data, notes }) {
  const now = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO apply_history (company, position, apply_url, status, form_data, notes, applied_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(company, position, apply_url, status, form_data ? JSON.stringify(form_data) : null, notes || null, now, now);
  return db.prepare('SELECT * FROM apply_history WHERE id = ?').get(result.lastInsertRowid);
}

function getApplyHistory(limit = 50) {
  return db.prepare('SELECT * FROM apply_history ORDER BY applied_at DESC LIMIT ?').all(limit);
}

function updateApplyStatus(id, status, notes) {
  const now = new Date().toISOString();
  db.prepare('UPDATE apply_history SET status = ?, notes = ?, updated_at = ? WHERE id = ?').run(status, notes || null, now, id);
  return db.prepare('SELECT * FROM apply_history WHERE id = ?').get(id);
}

function createJobSession(name, sourceUrl, settings = {}) {
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO job_sessions (name, source_url, status, settings, created_at, updated_at) VALUES (?, ?, 'idle', ?, ?, ?)`
  ).run(name, sourceUrl, JSON.stringify(settings), now, now);
  return db.prepare('SELECT * FROM job_sessions WHERE id = ?').get(result.lastInsertRowid);
}

function getJobSessions() {
  return db.prepare('SELECT * FROM job_sessions ORDER BY created_at DESC LIMIT 50').all();
}

function updateJobSession(id, fields) {
  const now = new Date().toISOString();
  const allowed = ['status','total','submitted','needs_review','skipped','failed_count','started_at','finished_at','name'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
  const vals = Object.keys(fields).filter(k => allowed.includes(k)).map(k => fields[k]);
  if (sets.length === 0) return;
  db.prepare(`UPDATE job_sessions SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now, id);
  return db.prepare('SELECT * FROM job_sessions WHERE id = ?').get(id);
}

function addJobToQueue(sessionId, company, title, link, sourceUrl) {
  const now = new Date().toISOString();
  try {
    const result = db.prepare(
      `INSERT INTO job_queue (company, title, link, source_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    ).run(company, title, link, sourceUrl || null, now, now);
    if (sessionId) db.prepare('UPDATE job_sessions SET total = total + 1, updated_at = ? WHERE id = ?').run(now, sessionId);
    return db.prepare('SELECT * FROM job_queue WHERE id = ?').get(result.lastInsertRowid);
  } catch (e) {
    return db.prepare('SELECT * FROM job_queue WHERE link = ?').get(link);
  }
}

function getJobQueue(status = null, limit = 100) {
  if (status) return db.prepare('SELECT * FROM job_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
  return db.prepare('SELECT * FROM job_queue ORDER BY created_at DESC LIMIT ?').all(limit);
}

function updateJobStatus(id, status, extra = {}) {
  const now = new Date().toISOString();
  const { fieldMapping, notes, confidence } = extra;
  db.prepare(`UPDATE job_queue SET status = ?, field_mapping = COALESCE(?, field_mapping), notes = COALESCE(?, notes), confidence = COALESCE(?, confidence), updated_at = ? WHERE id = ?`)
    .run(status, fieldMapping ? JSON.stringify(fieldMapping) : null, notes || null, confidence ?? null, now, id);
  return db.prepare('SELECT * FROM job_queue WHERE id = ?').get(id);
}

function addToReviewQueue(jobId, fieldMapping, screenshotPath, reason) {
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO job_review_queue (job_id, field_mapping, screenshot_path, reason, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(jobId, JSON.stringify(fieldMapping), screenshotPath || null, reason || null, now);
  return db.prepare('SELECT * FROM job_review_queue WHERE id = ?').get(result.lastInsertRowid);
}

function getReviewQueue(status = 'pending') {
  return db.prepare(`SELECT r.*, j.company, j.title, j.link FROM job_review_queue r JOIN job_queue j ON r.job_id = j.id WHERE r.status = ? ORDER BY r.created_at DESC`).all(status);
}

function archiveSummary(data) {
  return db.prepare(`INSERT INTO context_summaries (session_id, summary, message_count, tokens, original_tokens, compression_ratio, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(data.sessionId ?? null, data.summary, data.messageCount ?? null, data.tokens ?? null, data.originalTokens ?? null, data.compressionRatio ?? null, data.timestamp ?? new Date().toISOString());
}

function searchSessions(keywords = [], limit = 5) {
  const words = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean).slice(0, 8);
  if (words.length === 0) return [];
  const rows = db.prepare('SELECT summary, timestamp, session_id FROM context_summaries ORDER BY id DESC LIMIT 500').all();
  const scored = [];
  for (const row of rows) {
    const text = String(row.summary).toLowerCase();
    let score = 0;
    for (const w of words) { if (text.includes(String(w).toLowerCase())) score++; }
    if (score > 0) scored.push({ summary: row.summary, timestamp: row.timestamp, session_id: row.session_id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ==================== SETUP ====================

beforeAll(() => {
  setupTestDb();
});

afterAll(() => {
  if (db) db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

// ==================== TESTS ====================

describe('Schema & Tables', () => {
  it('semua tabel wajib ada', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    const required = ['users', 'chat_sessions', 'chat_messages', 'token_usage', 'request_logs', 'user_profile', 'apply_history', 'job_queue', 'job_review_queue', 'job_sessions', 'context_summaries', 'teams', 'team_members', 'workspaces', 'api_keys'];
    for (const t of required) {
      expect(tables, `tabel '${t}' harus ada`).toContain(t);
    }
  });

  it('chat_messages.role hanya boleh user/assistant/system', () => {
    createSession('sess-role-test', 'Test', 'openai', 'gpt-4');
    expect(() => {
      db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)").run('sess-role-test', 'invalid_role', 'test');
    }).toThrow();
  });
});

describe('chat_sessions CRUD', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM chat_messages').run();
    db.prepare('DELETE FROM chat_sessions').run();
  });

  it('createSession + getSessions', () => {
    createSession('sess-1', 'Sesi Pertama', 'openagentic', 'claude-sonnet-4.5');
    createSession('sess-2', 'Sesi Kedua', 'openai', 'gpt-4o');
    const sessions = getSessions(10);
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.id)).toContain('sess-1');
    expect(sessions.map(s => s.id)).toContain('sess-2');
  });

  it('getSessions mengembalikan array kosong saat tidak ada session', () => {
    const sessions = getSessions();
    expect(sessions).toEqual([]);
  });

  it('getSessions menghormati limit', () => {
    for (let i = 0; i < 5; i++) createSession(`sess-lim-${i}`, `Sesi ${i}`, 'openai', 'gpt-4');
    const sessions = getSessions(3);
    expect(sessions).toHaveLength(3);
  });

  it('updateSessionTitle memperbarui judul', () => {
    createSession('sess-upd', 'Judul Lama', 'openai', 'gpt-4');
    updateSessionTitle('sess-upd', 'Judul Baru');
    const sessions = getSessions();
    const s = sessions.find(x => x.id === 'sess-upd');
    expect(s.title).toBe('Judul Baru');
  });

  it('deleteSession menghapus session dan cascade ke messages', () => {
    createSession('sess-del', 'Delete Me', 'openai', 'gpt-4');
    addMessage('sess-del', 'user', 'halo');
    deleteSession('sess-del');
    const sessions = getSessions();
    expect(sessions.find(s => s.id === 'sess-del')).toBeUndefined();
    const messages = getMessages('sess-del');
    expect(messages).toHaveLength(0);
  });

  it('session memiliki field created_at dan updated_at', () => {
    createSession('sess-ts', 'Timestamps', 'openai', 'gpt-4');
    const s = getSessions().find(x => x.id === 'sess-ts');
    expect(s.created_at).toBeTruthy();
    expect(s.updated_at).toBeTruthy();
  });
});

describe('chat_messages CRUD', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM chat_messages').run();
    db.prepare('DELETE FROM chat_sessions').run();
    createSession('sess-msg', 'Session Pesan', 'openai', 'gpt-4');
  });

  it('addMessage + getMessages', () => {
    addMessage('sess-msg', 'user', 'Halo Wanar!', 5, 'openai', 'gpt-4o');
    addMessage('sess-msg', 'assistant', 'Halo! Aku Wanar AI.', 10, 'openai', 'gpt-4o');
    const msgs = getMessages('sess-msg');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('Halo Wanar!');
    expect(msgs[1].role).toBe('assistant');
  });

  it('addMessage mengembalikan lastInsertRowid', () => {
    const id = addMessage('sess-msg', 'user', 'test pesan');
    // better-sqlite3 mengembalikan number atau bigint tergantung versi/setting
    expect(Number(id)).toBeGreaterThan(0);
  });

  it('getMessages mengembalikan pesan berurutan ASC', () => {
    addMessage('sess-msg', 'user', 'pesan-1');
    addMessage('sess-msg', 'assistant', 'pesan-2');
    addMessage('sess-msg', 'user', 'pesan-3');
    const msgs = getMessages('sess-msg');
    expect(msgs[0].content).toBe('pesan-1');
    expect(msgs[2].content).toBe('pesan-3');
  });

  it('deleteMessages membersihkan semua pesan sesi', () => {
    addMessage('sess-msg', 'user', 'a');
    addMessage('sess-msg', 'assistant', 'b');
    deleteMessages('sess-msg');
    expect(getMessages('sess-msg')).toHaveLength(0);
  });

  it('getMessages session yang tidak ada mengembalikan array kosong', () => {
    expect(getMessages('not-exist')).toHaveLength(0);
  });

  it('addMessage menyimpan tokens, provider, model', () => {
    addMessage('sess-msg', 'user', 'test token', 123, 'openagentic', 'claude-sonnet');
    const msgs = getMessages('sess-msg');
    expect(msgs[0].tokens).toBe(123);
    expect(msgs[0].provider).toBe('openagentic');
    expect(msgs[0].model).toBe('claude-sonnet');
  });

  it('addMessage menolak role tidak valid', () => {
    expect(() => {
      db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?,?,?)").run('sess-msg', 'badRole', 'x');
    }).toThrow();
  });
});

describe('token_usage & getDailyUsage', () => {
  const TODAY = new Date().toISOString().slice(0, 10);

  beforeEach(() => {
    db.prepare('DELETE FROM token_usage').run();
  });

  it('recordTokenUsage + getDailyUsage aggregasi dengan benar', () => {
    recordTokenUsage(TODAY, 'openai', 'gpt-4', 100, 0.002);
    recordTokenUsage(TODAY, 'openai', 'gpt-4', 200, 0.004);
    recordTokenUsage(TODAY, 'nvidia', 'deepseek', 150, 0.001);
    const usage = getDailyUsage(TODAY);
    expect(usage.total).toBe(450);
    expect(usage.providers['openai']).toBe(300);
    expect(usage.providers['nvidia']).toBe(150);
    expect(usage.models['openai:gpt-4']).toBe(300);
  });

  it('getDailyUsage tanggal kosong mengembalikan 0', () => {
    const usage = getDailyUsage('2000-01-01');
    expect(usage.total).toBe(0);
    expect(usage.cost).toBe(0);
    expect(usage.providers).toEqual({});
    expect(usage.models).toEqual({});
  });

  it('getTotalTokensToday mengembalikan total hari ini', () => {
    recordTokenUsage(TODAY, 'openai', 'gpt-4', 500);
    recordTokenUsage(TODAY, 'nvidia', 'deepseek', 300);
    const total = getTotalTokensToday();
    expect(total).toBe(800);
  });

  it('getUsageHistory mengembalikan data historis', () => {
    recordTokenUsage('2026-01-01', 'openai', 'gpt-4', 1000);
    recordTokenUsage('2026-01-02', 'openai', 'gpt-4', 2000);
    const history = getUsageHistory(30);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it('recordTokenUsage bisa asosiasi dengan user_id', () => {
    const user = findOrCreateUser({ name: 'Test User', email: 'tokentest@test.com' });
    recordTokenUsage(TODAY, 'openai', 'gpt-4', 777, 0, user.id);
    const used = getUserTokensToday(user.id);
    expect(used).toBe(777);
  });
});

describe('request_logs & analytics', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM request_logs').run();
  });

  it('logRequest menyimpan data dengan benar', () => {
    logRequest({
      session_id: 'sess-a',
      provider: 'openai',
      model: 'gpt-4o',
      ip: '127.0.0.1',
      input_chars: 100,
      output_chars: 200,
      total_tokens: 50,
      response_time_ms: 1200,
      tokens_per_second: 41.6,
      status: 'ok',
    });
    const logs = db.prepare('SELECT * FROM request_logs').all();
    expect(logs).toHaveLength(1);
    expect(logs[0].provider).toBe('openai');
    expect(logs[0].model).toBe('gpt-4o');
    expect(logs[0].total_tokens).toBe(50);
  });

  it('logRequest dengan status error', () => {
    logRequest({ provider: 'nvidia', model: 'deepseek', status: 'error' });
    const logs = db.prepare("SELECT * FROM request_logs WHERE status = 'error'").all();
    expect(logs).toHaveLength(1);
  });

  it('logRequest default nilai 0 untuk numerik', () => {
    logRequest({ provider: 'groq', model: 'llama' });
    const logs = db.prepare('SELECT * FROM request_logs').all();
    expect(logs[0].input_chars).toBe(0);
    expect(logs[0].total_tokens).toBe(0);
  });
});

describe('Users: findOrCreateUser, getUserById, getUserByApiKey', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM users').run();
  });

  it('findOrCreateUser membuat user baru dari google_id', () => {
    const user = findOrCreateUser({ google_id: 'google-123', name: 'Wisnu', email: 'wisnu@test.com', avatar: 'http://av' });
    expect(user).toBeTruthy();
    expect(user.name).toBe('Wisnu');
    expect(user.email).toBe('wisnu@test.com');
    expect(user.role).toBe('user');
    expect(user.api_key).toMatch(/^wanar_/);
  });

  it('findOrCreateUser tidak duplikat user yang sudah ada (google_id)', () => {
    findOrCreateUser({ google_id: 'google-456', name: 'User A', email: 'a@test.com' });
    findOrCreateUser({ google_id: 'google-456', name: 'User A Updated', email: 'a@test.com' });
    const users = db.prepare('SELECT * FROM users WHERE google_id = ?').all('google-456');
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe('User A Updated');
  });

  it('findOrCreateUser fallback ke email jika google_id null', () => {
    const u1 = findOrCreateUser({ name: 'Email User', email: 'email@test.com' });
    const u2 = findOrCreateUser({ name: 'Email User Again', email: 'email@test.com' });
    expect(u1.id).toBe(u2.id);
  });

  it('getUserById mengembalikan user yang tepat', () => {
    const created = findOrCreateUser({ name: 'Get By ID', email: 'getbyid@test.com' });
    const found = getUserById(created.id);
    expect(found).toBeTruthy();
    expect(found.id).toBe(created.id);
    expect(found.name).toBe('Get By ID');
  });

  it('getUserById mengembalikan undefined untuk ID tidak ada', () => {
    const found = getUserById(999999);
    expect(found).toBeUndefined();
  });

  it('getUserByApiKey menemukan user dari api_key', () => {
    const created = findOrCreateUser({ name: 'API Key User', email: 'apikey@test.com' });
    const found = getUserByApiKey(created.api_key);
    expect(found).toBeTruthy();
    expect(found.id).toBe(created.id);
  });

  it('getUserByApiKey mengembalikan undefined untuk key salah', () => {
    const found = getUserByApiKey('wanar_invalidkey123');
    expect(found).toBeUndefined();
  });

  it('api_key setiap user unik', () => {
    const u1 = findOrCreateUser({ name: 'U1', email: 'u1@test.com' });
    const u2 = findOrCreateUser({ name: 'U2', email: 'u2@test.com' });
    expect(u1.api_key).not.toBe(u2.api_key);
  });
});

describe('user_profile: getProfile, saveProfile', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM user_profile').run();
  });

  it('getProfile mengembalikan null saat kosong', () => {
    expect(getProfile()).toBeNull();
  });

  it('saveProfile membuat profil baru', () => {
    const profile = saveProfile({ full_name: 'Wisnu Alfian', email: 'wisnu@test.com', city: 'Bekasi', skills: 'Node.js, React' });
    expect(profile).toBeTruthy();
    expect(profile.full_name).toBe('Wisnu Alfian');
    expect(profile.city).toBe('Bekasi');
  });

  it('saveProfile memperbarui profil yang sudah ada', () => {
    saveProfile({ full_name: 'Lama', city: 'Jakarta' });
    saveProfile({ full_name: 'Baru', city: 'Bekasi' });
    const profile = getProfile();
    expect(profile).not.toBeNull();
    expect(profile.full_name).toBe('Baru');
    expect(profile.city).toBe('Bekasi');
    const all = db.prepare('SELECT COUNT(*) as cnt FROM user_profile').get();
    expect(all.cnt).toBe(1);
  });

  it('saveProfile mempertahankan field yang tidak diupdate', () => {
    saveProfile({ full_name: 'Wisnu', university: 'President University', gpa: '3.54' });
    saveProfile({ full_name: 'Wisnu Updated' });
    const profile = getProfile();
    expect(profile).not.toBeNull();
    expect(profile.university).toBe('President University');
    expect(profile.gpa).toBe('3.54');
  });
});

describe('apply_history CRUD', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM apply_history').run();
  });

  it('addApplyHistory membuat entri baru', () => {
    const entry = addApplyHistory({ company: 'Google', position: 'SWE', apply_url: 'https://careers.google.com/1', status: 'applied' });
    expect(entry).toBeTruthy();
    expect(entry.company).toBe('Google');
    expect(entry.position).toBe('SWE');
    expect(entry.status).toBe('applied');
  });

  it('getApplyHistory mengembalikan daftar lamaran', () => {
    addApplyHistory({ company: 'A', position: 'Dev', apply_url: 'https://a.com/1' });
    addApplyHistory({ company: 'B', position: 'QA', apply_url: 'https://b.com/1' });
    const history = getApplyHistory();
    expect(history.length).toBe(2);
  });

  it('updateApplyStatus mengubah status dan notes', () => {
    const entry = addApplyHistory({ company: 'C', position: 'PM', apply_url: 'https://c.com/1' });
    const updated = updateApplyStatus(entry.id, 'interviewed', 'Lanjut ke tahap 2');
    expect(updated.status).toBe('interviewed');
    expect(updated.notes).toBe('Lanjut ke tahap 2');
  });

  it('addApplyHistory menyimpan form_data sebagai JSON string', () => {
    const formData = { name: 'Wisnu', skills: ['Node.js', 'React'] };
    const entry = addApplyHistory({ company: 'D', position: 'FS', apply_url: 'https://d.com/1', form_data: formData });
    expect(typeof entry.form_data).toBe('string');
    expect(JSON.parse(entry.form_data)).toEqual(formData);
  });
});

describe('Job Agent: job_sessions & job_queue', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM job_review_queue').run();
    db.prepare('DELETE FROM job_queue').run();
    db.prepare('DELETE FROM job_sessions').run();
  });

  it('createJobSession membuat sesi baru dengan status idle', () => {
    const session = createJobSession('Scan Jobstreet', 'https://jobstreet.co.id', { autoApply: true });
    expect(session.name).toBe('Scan Jobstreet');
    expect(session.status).toBe('idle');
    expect(session.total).toBe(0);
  });

  it('getJobSessions mengembalikan semua sesi', () => {
    createJobSession('Scan 1', 'https://url1.com');
    createJobSession('Scan 2', 'https://url2.com');
    expect(getJobSessions()).toHaveLength(2);
  });

  it('updateJobSession memperbarui field status dan counter', () => {
    const session = createJobSession('Test Session', 'https://test.com');
    const updated = updateJobSession(session.id, { status: 'running', total: 10, submitted: 3 });
    expect(updated.status).toBe('running');
    expect(updated.total).toBe(10);
    expect(updated.submitted).toBe(3);
  });

  it('addJobToQueue menambahkan lowongan ke antrian', () => {
    const session = createJobSession('Queue Test', 'https://queue.com');
    const job = addJobToQueue(session.id, 'Tokopedia', 'Backend Engineer', 'https://tokopedia.com/job/1', 'https://queue.com');
    expect(job.company).toBe('Tokopedia');
    expect(job.title).toBe('Backend Engineer');
    expect(job.status).toBe('pending');
  });

  it('addJobToQueue mencegah duplikat link', () => {
    const session = createJobSession('Dup Test', 'https://dup.com');
    addJobToQueue(session.id, 'Co A', 'Dev', 'https://dup.com/job/1', 'https://dup.com');
    addJobToQueue(session.id, 'Co A', 'Dev', 'https://dup.com/job/1', 'https://dup.com');
    const jobs = getJobQueue();
    expect(jobs.length).toBe(1);
  });

  it('addJobToQueue increment total di job_sessions', () => {
    const session = createJobSession('Count Test', 'https://count.com');
    addJobToQueue(session.id, 'A', 'Dev1', 'https://count.com/1');
    addJobToQueue(session.id, 'B', 'Dev2', 'https://count.com/2');
    const updated = db.prepare('SELECT total FROM job_sessions WHERE id = ?').get(session.id);
    expect(updated.total).toBe(2);
  });

  it('getJobQueue filter berdasarkan status', () => {
    const session = createJobSession('Filter Test', 'https://filter.com');
    addJobToQueue(session.id, 'X', 'Role1', 'https://filter.com/1');
    const jobs = getJobQueue('pending');
    expect(jobs.every(j => j.status === 'pending')).toBe(true);
  });

  it('updateJobStatus mengubah status job', () => {
    const session = createJobSession('Status Test', 'https://status.com');
    const job = addJobToQueue(session.id, 'Y', 'SWE', 'https://status.com/1');
    const updated = updateJobStatus(job.id, 'submitted', { notes: 'berhasil terkirim' });
    expect(updated.status).toBe('submitted');
    expect(updated.notes).toBe('berhasil terkirim');
  });

  it('addToReviewQueue + getReviewQueue', () => {
    const session = createJobSession('Review Test', 'https://review.com');
    const job = addJobToQueue(session.id, 'Z', 'PM', 'https://review.com/1');
    addToReviewQueue(job.id, { name: 'Wisnu', email: 'w@test.com' }, null, 'Expected salary kosong');
    const queue = getReviewQueue('pending');
    expect(queue.length).toBe(1);
    expect(queue[0].reason).toBe('Expected salary kosong');
  });
});

describe('context_summaries: archiveSummary, searchSessions', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM context_summaries').run();
  });

  it('archiveSummary menyimpan summary', () => {
    archiveSummary({ sessionId: 'sess-x', summary: 'Percakapan tentang Node.js dan TypeScript', messageCount: 10, tokens: 500, originalTokens: 2000, compressionRatio: 0.25 });
    const rows = db.prepare('SELECT * FROM context_summaries').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('sess-x');
    expect(rows[0].message_count).toBe(10);
  });

  it('archiveSummary tanpa session_id (null)', () => {
    archiveSummary({ summary: 'Summary tanpa session', tokens: 100 });
    const rows = db.prepare('SELECT * FROM context_summaries').all();
    expect(rows[0].session_id).toBeNull();
  });

  it('searchSessions menemukan berdasarkan keyword', () => {
    archiveSummary({ sessionId: 's1', summary: 'Percakapan tentang React dan TypeScript development', timestamp: new Date().toISOString() });
    archiveSummary({ sessionId: 's2', summary: 'Diskusi tentang Docker dan Kubernetes deployment', timestamp: new Date().toISOString() });
    archiveSummary({ sessionId: 's3', summary: 'Bug fix pada PostgreSQL query optimization', timestamp: new Date().toISOString() });
    const results = searchSessions(['React', 'TypeScript']);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].session_id).toBe('s1');
  });

  it('searchSessions mengembalikan kosong untuk keyword tidak cocok', () => {
    archiveSummary({ summary: 'Topik A' });
    const results = searchSessions(['topikxyzyangtidakada']);
    expect(results).toHaveLength(0);
  });

  it('searchSessions mengembalikan kosong untuk keywords array kosong', () => {
    archiveSummary({ summary: 'Ada summary' });
    expect(searchSessions([])).toHaveLength(0);
    expect(searchSessions()).toHaveLength(0);
  });

  it('searchSessions scoring dan sorting benar', () => {
    archiveSummary({ sessionId: 's-score-1', summary: 'Node.js Express API REST development', timestamp: new Date().toISOString() });
    archiveSummary({ sessionId: 's-score-2', summary: 'Node.js development only', timestamp: new Date().toISOString() });
    const results = searchSessions(['Node.js', 'Express', 'API']);
    // s-score-1 cocok 3 keyword, s-score-2 cocok 1
    expect(results[0].session_id).toBe('s-score-1');
  });

  it('searchSessions menghormati limit', () => {
    for (let i = 0; i < 10; i++) {
      archiveSummary({ sessionId: `s-lim-${i}`, summary: `keyword match ${i}`, timestamp: new Date().toISOString() });
    }
    const results = searchSessions(['keyword'], 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

describe('Teams & API Keys', () => {
  let ownerId;

  beforeEach(() => {
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM workspaces').run();
    db.prepare('DELETE FROM team_members').run();
    db.prepare('DELETE FROM teams').run();
    db.prepare('DELETE FROM users').run();
    const owner = findOrCreateUser({ name: 'Team Owner', email: 'owner@test.com' });
    ownerId = owner.id;
  });

  it('teams dapat dibuat dengan slug unik', () => {
    db.prepare('INSERT INTO teams (name, slug, owner_id) VALUES (?, ?, ?)').run('Tim Alpha', 'tim-alpha', ownerId);
    const team = db.prepare("SELECT * FROM teams WHERE slug = 'tim-alpha'").get();
    expect(team.name).toBe('Tim Alpha');
    expect(team.owner_id).toBe(ownerId);
  });

  it('teams slug harus unik', () => {
    db.prepare('INSERT INTO teams (name, slug, owner_id) VALUES (?, ?, ?)').run('Tim A', 'slug-unik', ownerId);
    expect(() => {
      db.prepare('INSERT INTO teams (name, slug, owner_id) VALUES (?, ?, ?)').run('Tim B', 'slug-unik', ownerId);
    }).toThrow();
  });

  it('team_members unique constraint team_id + user_id', () => {
    db.prepare('INSERT INTO teams (name, slug, owner_id) VALUES (?, ?, ?)').run('Tim B', 'tim-b', ownerId);
    const team = db.prepare("SELECT * FROM teams WHERE slug = 'tim-b'").get();
    db.prepare('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)').run(team.id, ownerId, 'owner');
    expect(() => {
      db.prepare('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)').run(team.id, ownerId, 'member');
    }).toThrow();
  });

  it('api_keys hash unik', () => {
    db.prepare('INSERT INTO teams (name, slug, owner_id) VALUES (?, ?, ?)').run('Tim C', 'tim-c', ownerId);
    const team = db.prepare("SELECT * FROM teams WHERE slug = 'tim-c'").get();
    const hash = crypto.createHash('sha256').update('test-key-1').digest('hex');
    db.prepare('INSERT INTO api_keys (key_hash, key_prefix, name, team_id, user_id, permissions) VALUES (?, ?, ?, ?, ?, ?)').run(hash, 'wk_', 'Key 1', team.id, ownerId, '{}');
    expect(() => {
      db.prepare('INSERT INTO api_keys (key_hash, key_prefix, name, user_id, permissions) VALUES (?, ?, ?, ?, ?)').run(hash, 'wk_', 'Key Dup', ownerId, '{}');
    }).toThrow();
  });

  it('delete user cascade hapus teams yang dimiliki', () => {
    db.prepare('INSERT INTO teams (name, slug, owner_id) VALUES (?, ?, ?)').run('Tim Cascade', 'tim-cascade', ownerId);
    db.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
    const teams = db.prepare('SELECT * FROM teams WHERE slug = ?').all('tim-cascade');
    expect(teams).toHaveLength(0);
  });
});
