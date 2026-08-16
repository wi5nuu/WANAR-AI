import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'wanar.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -64000');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 268435456');

try { db.exec('ALTER TABLE token_usage ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL'); } catch {}
try { db.exec('ALTER TABLE chat_sessions ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL'); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New Chat',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

  CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(date);
  CREATE INDEX IF NOT EXISTS idx_token_usage_provider ON token_usage(provider);
  CREATE INDEX IF NOT EXISTS idx_token_usage_provider_model ON token_usage(provider, model);
  CREATE INDEX IF NOT EXISTS idx_token_usage_date_provider ON token_usage(date, provider);
  CREATE INDEX IF NOT EXISTS idx_token_usage_date_provider_model ON token_usage(date, provider, model);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON chat_messages(session_id, id);
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON chat_sessions(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_request_logs_provider ON request_logs(provider);
  CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model);
  CREATE INDEX IF NOT EXISTS idx_request_logs_created_provider ON request_logs(created_at, provider);
  CREATE INDEX IF NOT EXISTS idx_request_logs_created_model ON request_logs(created_at, model);

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

  CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New Chat',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_id);

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

  CREATE INDEX IF NOT EXISTS idx_apply_history_status ON apply_history(status);
  CREATE INDEX IF NOT EXISTS idx_apply_history_applied ON apply_history(applied_at DESC);

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

  CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
  CREATE INDEX IF NOT EXISTS idx_job_queue_created ON job_queue(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_job_review_job ON job_review_queue(job_id);
  CREATE INDEX IF NOT EXISTS idx_job_sessions_status ON job_sessions(status);

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

  CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
  CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_team ON workspaces(team_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_team ON api_keys(team_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

  CREATE TRIGGER IF NOT EXISTS trg_teams_updated AFTER UPDATE ON teams
  BEGIN
    UPDATE teams SET updated_at = datetime('now') WHERE id = NEW.id;
  END;
`);

try { db.exec('ALTER TABLE chat_sessions ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL'); } catch {}
try { db.exec('ALTER TABLE chat_sessions ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL'); } catch {}


try { db.exec('CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace ON chat_sessions(workspace_id)'); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_chat_sessions_team ON chat_sessions(team_id)'); } catch {}

const prepared = {
  getSessions: db.prepare('SELECT id, title, provider, model, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC LIMIT ?'),
  createSession: db.prepare('INSERT INTO chat_sessions (id, title, provider, model) VALUES (?, ?, ?, ?)'),
  updateSessionTitle: db.prepare("UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?"),
  deleteSession: db.prepare('DELETE FROM chat_sessions WHERE id = ?'),
  deleteMessages: db.prepare('DELETE FROM chat_messages WHERE session_id = ?'),
  getMessages: db.prepare('SELECT id, role, content, tokens, provider, model, created_at FROM chat_messages WHERE session_id = ? ORDER BY id ASC'),
  addMessage: db.prepare('INSERT INTO chat_messages (session_id, role, content, tokens, provider, model) VALUES (?, ?, ?, ?, ?, ?)'),
  updateSessionTimestamp: db.prepare("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?"),
  recordTokenUsage: db.prepare('INSERT INTO token_usage (date, provider, model, tokens, cost, user_id) VALUES (?, ?, ?, ?, ?, ?)'),
  getDailyTotal: db.prepare('SELECT COALESCE(SUM(tokens),0) as total, COALESCE(SUM(cost),0) as cost FROM token_usage WHERE date = ?'),
  getDailyProviders: db.prepare('SELECT provider, SUM(tokens) as tokens FROM token_usage WHERE date = ? GROUP BY provider'),
  getDailyModels: db.prepare("SELECT provider || ':' || model as key, SUM(tokens) as tokens FROM token_usage WHERE date = ? GROUP BY provider, model"),
  getUsageHistory: db.prepare('SELECT date, SUM(tokens) as total, SUM(cost) as cost FROM token_usage GROUP BY date ORDER BY date DESC LIMIT ?'),
  getTotalTokensToday: db.prepare("SELECT COALESCE(SUM(tokens),0) as total FROM token_usage WHERE date = ?"),
  logRequest: db.prepare('INSERT INTO request_logs (session_id, provider, model, ip, input_chars, output_chars, total_tokens, response_time_ms, tokens_per_second, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  getAnalyticsTotal: db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(AVG(tokens_per_second),0) as avg_speed, COALESCE(SUM(input_chars),0) as total_input, COALESCE(SUM(output_chars),0) as total_output, COALESCE(AVG(response_time_ms),0) as avg_response FROM request_logs WHERE created_at >= ?'),
  getAnalyticsByProvider: db.prepare('SELECT provider, COUNT(*) as count, SUM(total_tokens) as tokens FROM request_logs WHERE created_at >= ? GROUP BY provider'),
  getAnalyticsByModel: db.prepare('SELECT model, COUNT(*) as count, SUM(total_tokens) as tokens, AVG(tokens_per_second) as avg_speed FROM request_logs WHERE created_at >= ? GROUP BY model ORDER BY count DESC'),
  getAnalyticsUniqueIPs: db.prepare('SELECT COUNT(DISTINCT ip) as count FROM request_logs WHERE created_at >= ? AND ip IS NOT NULL'),
  getAnalyticsRecent: db.prepare('SELECT id, session_id, provider, model, ip, input_chars, output_chars, total_tokens, response_time_ms, tokens_per_second, status, created_at FROM request_logs WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200'),
  getAnalyticsHourly: db.prepare("SELECT substr(created_at,12,3) || 'h' as hour, COUNT(*) as count, SUM(total_tokens) as tokens FROM request_logs WHERE created_at >= ? GROUP BY substr(created_at,1,13) ORDER BY hour ASC"),
};

export function getSessions(limit = 50) {
  return prepared.getSessions.all(limit);
}

export function createSession(id, title, provider, model) {
  prepared.createSession.run(id, title, provider, model);
}

export function updateSessionTitle(id, title) {
  prepared.updateSessionTitle.run(title, id);
}

export function deleteSession(id) {
  prepared.deleteSession.run(id);
}

export function deleteMessages(sessionId) {
  prepared.deleteMessages.run(sessionId);
}

export function getMessages(sessionId) {
  return prepared.getMessages.all(sessionId);
}

export function addMessage(sessionId, role, content, tokens = 0, provider = null, model = null) {
  const result = prepared.addMessage.run(sessionId, role, content, tokens, provider, model);
  prepared.updateSessionTimestamp.run(sessionId);
  return result.lastInsertRowid;
}

export function recordTokenUsage(date, provider, model, tokens, cost = 0, userId = null) {
  prepared.recordTokenUsage.run(date, provider, model, tokens, cost, userId);
}

export function getDailyUsage(date) {
  const row = prepared.getDailyTotal.get(date);
  const providers = prepared.getDailyProviders.all(date);
  const models = prepared.getDailyModels.all(date);
  return {
    total: row.total,
    cost: row.cost,
    providers: Object.fromEntries(providers.map(p => [p.provider, p.tokens])),
    models: Object.fromEntries(models.map(m => [m.key, m.tokens])),
  };
}

export function getUsageHistory(days = 30) {
  return prepared.getUsageHistory.all(days);
}

export function getTotalTokensToday() {
  const today = new Date().toISOString().slice(0, 10);
  const row = prepared.getTotalTokensToday.get(today);
  return row.total;
}

export function logRequest(data) {
  prepared.logRequest.run(
    data.session_id, data.provider, data.model, data.ip,
    data.input_chars || 0, data.output_chars || 0,
    data.total_tokens || 0, data.response_time_ms || 0,
    data.tokens_per_second || 0, data.status || 'ok'
  );
}

export function findOrCreateUser(profile) {
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
    return user;
  }

  const apiKey = 'wanar_' + crypto.randomBytes(16).toString('hex');
  const result = db.prepare('INSERT INTO users (google_id, name, email, avatar, role, api_key) VALUES (?, ?, ?, ?, ?, ?)').run(
    profile.google_id || null, profile.name || 'User', profile.email || null, profile.avatar || null, 'user', apiKey
  );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

export function getUserById(id) {
  return db.prepare('SELECT id, name, email, avatar, role, api_key, daily_token_limit, created_at, last_login FROM users WHERE id = ?').get(id);
}

export function getUserByApiKey(apiKey) {
  return db.prepare('SELECT id, name, email, avatar, role, daily_token_limit FROM users WHERE api_key = ?').get(apiKey);
}

export function getUserTokensToday(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare('SELECT COALESCE(SUM(tokens),0) as total FROM token_usage WHERE user_id = ? AND date = ?').get(userId, today);
  return row.total;
}

export function recordUserTokens(userId, tokens) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO token_usage (date, provider, model, tokens, user_id) VALUES (?, ?, ?, ?, ?)').run(today, 'auth', 'user', tokens, userId);
}

export function getAllUsers() {
  return db.prepare('SELECT id, name, email, avatar, role, daily_token_limit, created_at, last_login FROM users ORDER BY created_at DESC').all();
}

export function updateUserRole(userId, role) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

export function getAnalytics(hours = 24) {
  const since = new Date(Date.now() - hours * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const total = prepared.getAnalyticsTotal.get(since);
  const byProvider = prepared.getAnalyticsByProvider.all(since);
  const byModel = prepared.getAnalyticsByModel.all(since);
  const uniqueIPs = prepared.getAnalyticsUniqueIPs.get(since);
  const recent = prepared.getAnalyticsRecent.all(since);
  const hourly = prepared.getAnalyticsHourly.all(since);
  return {
    total: total.count,
    totalTokens: total.total_tokens,
    avgSpeed: Math.round(total.avg_speed * 100) / 100,
    totalInput: total.total_input,
    totalOutput: total.total_output,
    avgResponse: Math.round(total.avg_response),
    uniqueIPs: uniqueIPs.count,
    providers: byProvider,
    models: byModel,
    recent,
    hourly,
  };
}

// Enhanced analytics untuk dashboard
export function getAnalyticsSummary(days = 14) {
  const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  
  const query = `
    SELECT 
      COUNT(*) as total_requests,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(input_chars), 0) as total_input,
      COALESCE(SUM(output_chars), 0) as total_output,
      COALESCE(AVG(response_time_ms), 0) as avg_response_time
    FROM request_logs
    WHERE DATE(created_at) >= ?
  `;
  
  const result = db.prepare(query).get(startDate);
  
  return {
    totalRequests: result.total_requests || 0,
    totalTokens: result.total_tokens || 0,
    totalCost: 0, // Placeholder for future cost calculation
    avgResponseTime: Math.round(result.avg_response_time || 0),
    dateRange: days
  };
}

export function getAnalyticsDailyUsage(days = 14) {
  const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  
  const query = `
    SELECT 
      DATE(created_at) as date,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens,
      0 as cost
    FROM request_logs
    WHERE DATE(created_at) >= ?
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `;
  
  return db.prepare(query).all(startDate);
}

export function getAnalyticsByModel(days = 14) {
  const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  
  const query = `
    SELECT 
      model,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens,
      0 as cost
    FROM request_logs
    WHERE DATE(created_at) >= ?
    GROUP BY model
    ORDER BY requests DESC
  `;
  
  return db.prepare(query).all(startDate);
}

export function getAnalyticsByProvider(days = 14) {
  const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  
  const query = `
    SELECT 
      provider,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens
    FROM request_logs
    WHERE DATE(created_at) >= ?
    GROUP BY provider
    ORDER BY requests DESC
  `;
  
  return db.prepare(query).all(startDate);
}

export function getAnalyticsLogs(filters = {}) {
  const { 
    startDate, 
    endDate, 
    model, 
    provider,
    limit = 100,
    offset = 0 
  } = filters;
  
  let query = `
    SELECT 
      id,
      provider,
      model,
      total_tokens,
      response_time_ms,
      status,
      created_at
    FROM request_logs
    WHERE 1=1
  `;
  
  const params = [];
  
  if (startDate) {
    query += ` AND DATE(created_at) >= ?`;
    params.push(startDate);
  }
  
  if (endDate) {
    query += ` AND DATE(created_at) <= ?`;
    params.push(endDate);
  }
  
  if (model) {
    query += ` AND model = ?`;
    params.push(model);
  }
  
  if (provider) {
    query += ` AND provider = ?`;
    params.push(provider);
  }
  
  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  
  return db.prepare(query).all(...params);
}

export function getAnalyticsModels() {
  const query = `SELECT DISTINCT model FROM request_logs ORDER BY model`;
  return db.prepare(query).all().map(row => row.model);
}

export function getAnalyticsProviders() {
  const query = `SELECT DISTINCT provider FROM request_logs ORDER BY provider`;
  return db.prepare(query).all().map(row => row.provider);
}

// ==================== USER PROFILE ====================

export function getProfile() {
  return db.prepare('SELECT * FROM user_profile WHERE id = 1').get() || null;
}

export function saveProfile(data) {
  const existing = getProfile();
  const fields = [
    'full_name','email','phone','address','city','province','postal_code',
    'date_of_birth','gender','nationality','university','faculty','major',
    'gpa','graduation_year','student_id','linkedin','portfolio','github',
    'skills','languages','work_experience','cv_text','cv_filename',
    'preference_type','preference_location','preference_field','extra_data'
  ];
  const now = new Date().toISOString();
  if (!existing) {
    const cols = [...fields, 'updated_at'].join(', ');
    const vals = [...fields.map(() => '?'), '?'].join(', ');
    const values = [...fields.map(f => data[f] ?? null), now];
    db.prepare(`INSERT INTO user_profile (${cols}) VALUES (${vals})`).run(...values);
  } else {
    const sets = [...fields.map(f => `${f} = ?`), 'updated_at = ?'].join(', ');
    const values = [...fields.map(f => data[f] ?? existing[f] ?? null), now];
    db.prepare(`UPDATE user_profile SET ${sets} WHERE id = 1`).run(...values);
  }
  return getProfile();
}

// ==================== APPLY HISTORY ====================

export function getApplyHistory(limit = 50) {
  return db.prepare('SELECT * FROM apply_history ORDER BY applied_at DESC LIMIT ?').all(limit);
}

export function addApplyHistory({ company, position, apply_url, status = 'applied', form_data, notes }) {
  const now = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO apply_history (company, position, apply_url, status, form_data, notes, applied_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(company, position, apply_url, status, form_data ? JSON.stringify(form_data) : null, notes || null, now, now);
  return db.prepare('SELECT * FROM apply_history WHERE id = ?').get(result.lastInsertRowid);
}

export function updateApplyStatus(id, status, notes) {
  const now = new Date().toISOString();
  db.prepare('UPDATE apply_history SET status = ?, notes = ?, updated_at = ? WHERE id = ?').run(status, notes || null, now, id);
  return db.prepare('SELECT * FROM apply_history WHERE id = ?').get(id);
}

// ==================== JOB AGENT ====================

export function createJobSession(name, sourceUrl, settings = {}) {
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO job_sessions (name, source_url, status, settings, created_at, updated_at)
     VALUES (?, ?, 'idle', ?, ?, ?)`
  ).run(name, sourceUrl, JSON.stringify(settings), now, now);
  return db.prepare('SELECT * FROM job_sessions WHERE id = ?').get(result.lastInsertRowid);
}

export function getJobSessions() {
  return db.prepare('SELECT * FROM job_sessions ORDER BY created_at DESC LIMIT 50').all();
}

export function getJobSession(id) {
  return db.prepare('SELECT * FROM job_sessions WHERE id = ?').get(id);
}

export function deleteJobSession(id) {
  // job_queue tidak punya session_id FK, hapus berdasarkan source_url dari session
  const session = db.prepare('SELECT source_url FROM job_sessions WHERE id = ?').get(id);
  if (session) {
    db.prepare('DELETE FROM job_review_queue WHERE job_id IN (SELECT id FROM job_queue WHERE source_url = ?)').run(session.source_url);
    db.prepare('DELETE FROM job_queue WHERE source_url = ?').run(session.source_url);
  }
  db.prepare('DELETE FROM job_sessions WHERE id = ?').run(id);
}

export function updateJobSession(id, fields) {
  const now = new Date().toISOString();
  const allowed = ['status','total','submitted','needs_review','skipped','failed_count','started_at','finished_at','name'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
  const vals = Object.keys(fields).filter(k => allowed.includes(k)).map(k => fields[k]);
  if (sets.length === 0) return;
  db.prepare(`UPDATE job_sessions SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now, id);
  return db.prepare('SELECT * FROM job_sessions WHERE id = ?').get(id);
}

export function addJobToQueue(sessionId, company, title, link, sourceUrl) {
  const now = new Date().toISOString();
  try {
    const result = db.prepare(
      `INSERT INTO job_queue (company, title, link, source_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    ).run(company, title, link, sourceUrl || null, now, now);
    // bump session total
    if (sessionId) db.prepare('UPDATE job_sessions SET total = total + 1, updated_at = ? WHERE id = ?').run(now, sessionId);
    return db.prepare('SELECT * FROM job_queue WHERE id = ?').get(result.lastInsertRowid);
  } catch (e) {
    // unique constraint — link already in queue
    return db.prepare('SELECT * FROM job_queue WHERE link = ?').get(link);
  }
}

export function getJobQueue(status = null, limit = 100, offset = 0) {
  if (status) {
    return db.prepare('SELECT * FROM job_queue WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(status, limit, offset);
  }
  return db.prepare('SELECT * FROM job_queue ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
}

export function getJobQueueStats() {
  return db.prepare(`
    SELECT status, COUNT(*) as count FROM job_queue GROUP BY status
  `).all();
}

export function getJobById(id) {
  return db.prepare('SELECT * FROM job_queue WHERE id = ?').get(id);
}

export function updateJobStatus(id, status, extra = {}) {
  const now = new Date().toISOString();
  const { fieldMapping, screenshotPath, coverLetter, notes, confidence, formType, robotsOk } = extra;
  db.prepare(`
    UPDATE job_queue SET
      status = ?,
      field_mapping = COALESCE(?, field_mapping),
      screenshot_path = COALESCE(?, screenshot_path),
      cover_letter = COALESCE(?, cover_letter),
      notes = COALESCE(?, notes),
      confidence = COALESCE(?, confidence),
      form_type = COALESCE(?, form_type),
      robots_ok = COALESCE(?, robots_ok),
      updated_at = ?
    WHERE id = ?
  `).run(
    status,
    fieldMapping ? JSON.stringify(fieldMapping) : null,
    screenshotPath || null,
    coverLetter || null,
    notes || null,
    confidence ?? null,
    formType || null,
    robotsOk ?? null,
    now, id
  );
  return db.prepare('SELECT * FROM job_queue WHERE id = ?').get(id);
}

export function incrementJobRetry(id) {
  db.prepare('UPDATE job_queue SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export function addToReviewQueue(jobId, fieldMapping, screenshotPath, reason) {
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO job_review_queue (job_id, field_mapping, screenshot_path, reason, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(jobId, JSON.stringify(fieldMapping), screenshotPath || null, reason || null, now);
  return db.prepare('SELECT * FROM job_review_queue WHERE id = ?').get(result.lastInsertRowid);
}

export function getReviewQueue(status = 'pending') {
  return db.prepare(`
    SELECT r.*, j.company, j.title, j.link, j.form_type
    FROM job_review_queue r
    JOIN job_queue j ON r.job_id = j.id
    WHERE r.status = ?
    ORDER BY r.created_at DESC
  `).all(status);
}

export function updateReviewItem(id, status, editedMapping = null) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE job_review_queue SET status = ?, edited_mapping = ?, reviewed_at = ? WHERE id = ?
  `).run(status, editedMapping ? JSON.stringify(editedMapping) : null, now, id);
  return db.prepare('SELECT * FROM job_review_queue WHERE id = ?').get(id);
}

export function clearJobQueue() {
  db.prepare('DELETE FROM job_review_queue').run();
  db.prepare('DELETE FROM job_queue').run();
}

export default db;
