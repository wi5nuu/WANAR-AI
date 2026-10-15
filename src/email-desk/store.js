/**
 * src/email-desk/store.js
 *
 * Persistence for the Email Desk: conversations (threads) the owner started
 * from Telegram, every message in/out, drafts awaiting confirmation, and a
 * small meta table (IMAP cursor).
 *
 * @author Wisnu Alfian Nur Ashar
 */

import crypto from 'crypto';

const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;

export function createEmailDeskStore(db, { now = () => Date.now() } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ed_threads (
      id TEXT PRIMARY KEY,
      counterpart TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      auto_mode TEXT NOT NULL DEFAULT 'notify',
      auto_instructions TEXT,
      auto_count INTEGER NOT NULL DEFAULT 0,
      last_auto_at INTEGER,
      chat_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ed_threads_cp ON ed_threads(counterpart, status);

    CREATE TABLE IF NOT EXISTS ed_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      message_id TEXT,
      in_reply_to TEXT,
      from_addr TEXT,
      to_addr TEXT,
      subject TEXT,
      body TEXT,
      auto INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ed_msg_mid ON ed_messages(message_id) WHERE message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ed_msg_thread ON ed_messages(thread_id, at);

    CREATE TABLE IF NOT EXISTS ed_drafts (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      thread_id TEXT,
      to_addr TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      in_reply_to TEXT,
      refs TEXT,
      auto_mode TEXT NOT NULL DEFAULT 'notify',
      auto_instructions TEXT,
      origin TEXT NOT NULL DEFAULT 'owner',
      chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ed_drafts_status ON ed_drafts(status, created_at);

    CREATE TABLE IF NOT EXISTS ed_meta (key TEXT PRIMARY KEY, value TEXT);

    -- People the owner told the assistant about ("dia pasangan saya"): drives the tone of replies.
    CREATE TABLE IF NOT EXISTS ed_contacts (
      address TEXT PRIMARY KEY,
      relation TEXT NOT NULL,
      display_name TEXT,
      call_name TEXT,
      notes TEXT,
      auto_reply INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Additive migrations (safe on existing databases).
  const addColumn = (table, col, type) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  addColumn('ed_drafts', 'batch', 'TEXT');
  addColumn('ed_drafts', 'to_name', 'TEXT');
  addColumn('ed_drafts', 'follow_up_days', 'INTEGER');
  addColumn('ed_threads', 'follow_up_at', 'INTEGER');
  addColumn('ed_threads', 'follow_up_notified', 'INTEGER');
  addColumn('ed_threads', 'mode_override', 'TEXT'); // NULL = ikut pengaturan umum
  db.exec('CREATE INDEX IF NOT EXISTS idx_ed_drafts_batch ON ed_drafts(batch, status)');

  const threads = {
    create({ counterpart, subject, autoMode = 'notify', autoInstructions = null, chatId = null }) {
      const tid = id('thr');
      db.prepare(`INSERT INTO ed_threads (id, counterpart, subject, auto_mode, auto_instructions, chat_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(tid, counterpart.toLowerCase(), subject, autoMode, autoInstructions, chatId, now(), now());
      return threads.get(tid);
    },
    get: (tid) => db.prepare('SELECT * FROM ed_threads WHERE id = ?').get(tid) || null,
    list: (limit = 20) => db.prepare('SELECT * FROM ed_threads ORDER BY updated_at DESC LIMIT ?').all(limit),
    openWith: (addr) => db.prepare("SELECT * FROM ed_threads WHERE counterpart = ? AND status = 'open' ORDER BY updated_at DESC").all(String(addr).toLowerCase()),
    touch: (tid) => db.prepare('UPDATE ed_threads SET updated_at = ? WHERE id = ?').run(now(), tid),
    setAuto(tid, { mode, instructions }) {
      db.prepare('UPDATE ed_threads SET auto_mode = ?, auto_instructions = COALESCE(?, auto_instructions), updated_at = ? WHERE id = ?')
        .run(mode, instructions ?? null, now(), tid);
      return threads.get(tid);
    },
    /** Per-conversation exception to the global policy (null = follow the global setting). */
    setOverride(tid, mode) {
      db.prepare('UPDATE ed_threads SET mode_override = ?, updated_at = ? WHERE id = ?').run(mode, now(), tid);
      return threads.get(tid);
    },
    /** Drop every per-conversation exception: the global setting rules again. */
    clearOverrides: () => db.prepare('UPDATE ed_threads SET mode_override = NULL WHERE mode_override IS NOT NULL').run().changes,
    countAuto: (tid) => db.prepare('UPDATE ed_threads SET auto_count = auto_count + 1, last_auto_at = ? WHERE id = ?').run(now(), tid),
    close: (tid) => db.prepare("UPDATE ed_threads SET status = 'closed', updated_at = ? WHERE id = ?").run(now(), tid).changes > 0,
    setFollowUp: (tid, at) => db.prepare('UPDATE ed_threads SET follow_up_at = ?, follow_up_notified = NULL WHERE id = ?').run(at, tid),
    clearFollowUp: (tid) => db.prepare('UPDATE ed_threads SET follow_up_at = NULL, follow_up_notified = NULL WHERE id = ?').run(tid),
    dueFollowUps: (atMs) => db.prepare("SELECT * FROM ed_threads WHERE status = 'open' AND follow_up_at IS NOT NULL AND follow_up_at <= ? AND follow_up_notified IS NULL ORDER BY follow_up_at ASC LIMIT 20").all(atMs),
    markFollowUpNotified: (tid) => db.prepare('UPDATE ed_threads SET follow_up_notified = ? WHERE id = ? AND follow_up_notified IS NULL').run(now(), tid).changes > 0,
  };

  const messages = {
    add({ threadId, direction, messageId = null, inReplyTo = null, from = null, to = null, subject = null, body = '', auto = false, at = now() }) {
      const mid = id('msg');
      db.prepare(`INSERT INTO ed_messages (id, thread_id, direction, message_id, in_reply_to, from_addr, to_addr, subject, body, auto, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(mid, threadId, direction, messageId, inReplyTo, from, to, subject, String(body).slice(0, 20000), auto ? 1 : 0, at);
      threads.touch(threadId);
      return mid;
    },
    byMessageId: (m) => (m ? db.prepare('SELECT * FROM ed_messages WHERE message_id = ?').get(m) || null : null),
    ofThread: (tid, limit = 20) => db.prepare('SELECT * FROM ed_messages WHERE thread_id = ? ORDER BY at DESC LIMIT ?').all(tid, limit).reverse(),
    lastOut: (tid) => db.prepare("SELECT * FROM ed_messages WHERE thread_id = ? AND direction = 'out' ORDER BY at DESC LIMIT 1").get(tid) || null,
    lastIn: (tid) => db.prepare("SELECT * FROM ed_messages WHERE thread_id = ? AND direction = 'in' ORDER BY at DESC LIMIT 1").get(tid) || null,
    autoSentSince: (ms) => db.prepare("SELECT COUNT(*) AS n FROM ed_messages WHERE direction = 'out' AND auto = 1 AND at >= ?").get(ms).n,
    sentSince: (ms) => db.prepare("SELECT COUNT(*) AS n FROM ed_messages WHERE direction = 'out' AND at >= ?").get(ms).n,
    last: (tid) => db.prepare('SELECT * FROM ed_messages WHERE thread_id = ? ORDER BY at DESC LIMIT 1').get(tid) || null,
    recent: (limit = 30) => db.prepare('SELECT m.*, t.counterpart, t.subject AS thread_subject FROM ed_messages m JOIN ed_threads t ON t.id = m.thread_id ORDER BY m.at DESC LIMIT ?').all(limit),
  };

  const drafts = {
    add(d) {
      const did = id('drf');
      const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM ed_drafts').get().m || 0) + 1;
      db.prepare(`INSERT INTO ed_drafts (id, seq, thread_id, to_addr, subject, body, in_reply_to, refs, auto_mode, auto_instructions, origin, chat_id, created_at, batch, to_name, follow_up_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        did, seq, d.threadId || null, d.to.toLowerCase(), d.subject, d.body, d.inReplyTo || null, d.refs || null,
        d.autoMode || 'notify', d.autoInstructions || null, d.origin || 'owner', d.chatId || null, now(),
        d.batch || null, d.toName || null, Number.isFinite(d.followUpDays) ? d.followUpDays : null,
      );
      return drafts.get(did);
    },
    get: (did) => db.prepare('SELECT * FROM ed_drafts WHERE id = ?').get(did) || null,
    bySeq: (seq) => db.prepare('SELECT * FROM ed_drafts WHERE seq = ?').get(Number(seq)) || null,
    pending: (limit = 20) => db.prepare("SELECT * FROM ed_drafts WHERE status = 'pending' ORDER BY created_at ASC, seq ASC LIMIT ?").all(limit),
    pendingBatch: (batch) => db.prepare("SELECT * FROM ed_drafts WHERE batch = ? AND status = 'pending' ORDER BY seq ASC").all(batch),
    ofBatch: (batch) => db.prepare('SELECT * FROM ed_drafts WHERE batch = ? ORDER BY seq ASC').all(batch),
    resolve(did, status, error = null) {
      return db.prepare("UPDATE ed_drafts SET status = ?, error = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(status, error, now(), did).changes > 0;
    },
    /** Final state after a 'sending' claim. */
    finish: (did, status, error = null) => db.prepare("UPDATE ed_drafts SET status = ?, error = ?, resolved_at = ? WHERE id = ? AND status = 'sending'")
      .run(status, error, now(), did),
  };

  const meta = {
    get: (k) => db.prepare('SELECT value FROM ed_meta WHERE key = ?').get(k)?.value ?? null,
    set: (k, v) => db.prepare('INSERT INTO ed_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v)),
  };

  const contacts = {
    get: (addr) => db.prepare('SELECT * FROM ed_contacts WHERE address = ?').get(String(addr || '').toLowerCase()) || null,
    list: () => db.prepare('SELECT * FROM ed_contacts ORDER BY updated_at DESC').all(),
    upsert({ address, relation, displayName = null, callName = null, notes = null, autoReply = true }) {
      const a = String(address).toLowerCase();
      const cur = contacts.get(a);
      if (cur) {
        db.prepare(`UPDATE ed_contacts SET relation = ?, display_name = COALESCE(?, display_name), call_name = COALESCE(?, call_name),
          notes = COALESCE(?, notes), auto_reply = ?, updated_at = ? WHERE address = ?`)
          .run(relation, displayName, callName, notes, autoReply ? 1 : 0, now(), a);
      } else {
        db.prepare(`INSERT INTO ed_contacts (address, relation, display_name, call_name, notes, auto_reply, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a, relation, displayName, callName, notes, autoReply ? 1 : 0, now(), now());
      }
      return contacts.get(a);
    },
    remove: (addr) => db.prepare('DELETE FROM ed_contacts WHERE address = ?').run(String(addr || '').toLowerCase()).changes > 0,
  };

  return { threads, messages, drafts, meta, contacts, newBatchId: () => id('bat') };
}
