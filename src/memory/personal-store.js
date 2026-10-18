/**
 * src/memory/personal-store.js
 *
 * Personal memory persistence: small, explicit, owner-controlled facts the AI
 * may rely on — preferences ("kopi tanpa gula"), routines ("shalat Jumat di
 * masjid dekat kantor"), named places, people, and notes the owner asked to
 * remember. Two rules keep this honest:
 *
 *   - nothing is written here by guessing: an item has a `source` and a
 *     `confidence`, and the owner can see/edit/forget every row;
 *   - the prompt builder only ever reads ACTIVE items and redacts anything that
 *     looks like a credential before it reaches a model.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import crypto from 'node:crypto';

const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

export const MEMORY_KINDS = Object.freeze(['preference', 'fact', 'place', 'person', 'routine', 'note']);

export function createPersonalStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      tags TEXT,
      source TEXT NOT NULL DEFAULT 'owner',
      confidence REAL NOT NULL DEFAULT 1,
      times_used INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(kind, key)
    );
    CREATE INDEX IF NOT EXISTS idx_mem_items_kind ON mem_items(kind, active);
    CREATE INDEX IF NOT EXISTS idx_mem_items_updated ON mem_items(updated_at DESC);

    CREATE TABLE IF NOT EXISTS mem_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mem_history_item ON mem_history(item_id, ts DESC);
  `);

  const now = () => Date.now();
  const mapItem = (r) => (r ? { ...r, tags: parse(r.tags, []), active: Boolean(r.active) } : null);

  const items = {
    get: (mid) => mapItem(db.prepare('SELECT * FROM mem_items WHERE id = ?').get(mid)),
    byKey: (kind, key) => mapItem(db.prepare('SELECT * FROM mem_items WHERE kind = ? AND key = ?').get(kind, key)),

    /**
     * Upsert by (kind, key). A changed value is versioned in mem_history, so
     * "what did the AI believe last month" is answerable.
     */
    upsert({ kind, key, value, tags = [], source = 'owner', confidence = 1 }) {
      const existing = items.byKey(kind, key);
      const t = now();
      if (existing) {
        if (existing.value !== value) {
          db.prepare('INSERT INTO mem_history (item_id, ts, action, old_value, new_value) VALUES (?, ?, ?, ?, ?)')
            .run(existing.id, t, 'updated', existing.value, value);
        }
        db.prepare('UPDATE mem_items SET value = ?, tags = ?, source = ?, confidence = ?, active = 1, updated_at = ? WHERE id = ?')
          .run(value, tags?.length ? JSON.stringify(tags) : null, source, Number(confidence) || 1, t, existing.id);
        return items.get(existing.id);
      }
      const mid = id('mem');
      db.prepare('INSERT INTO mem_items (id, kind, key, value, tags, source, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(mid, kind, key, value, tags?.length ? JSON.stringify(tags) : null, source, Number(confidence) || 1, t, t);
      db.prepare('INSERT INTO mem_history (item_id, ts, action, new_value) VALUES (?, ?, ?, ?)').run(mid, t, 'created', value);
      return items.get(mid);
    },

    list({ kind = null, activeOnly = true, limit = 200 } = {}) {
      const parts = [];
      const args = [];
      if (kind) { parts.push('kind = ?'); args.push(kind); }
      if (activeOnly) parts.push('active = 1');
      const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
      args.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));
      return db.prepare(`SELECT * FROM mem_items ${where} ORDER BY updated_at DESC LIMIT ?`).all(...args).map(mapItem);
    },

    search(query, { limit = 10 } = {}) {
      const words = String(query || '').toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => w.length >= 3).slice(0, 6);
      if (!words.length) return [];
      const like = words.map(() => '(LOWER(key) LIKE ? OR LOWER(value) LIKE ? OR LOWER(COALESCE(tags, \'\')) LIKE ?)').join(' OR ');
      const args = [];
      for (const w of words) args.push(`%${w}%`, `%${w}%`, `%${w}%`);
      args.push(Math.min(Math.max(limit, 1), 100));
      return db.prepare(`SELECT * FROM mem_items WHERE active = 1 AND (${like}) ORDER BY updated_at DESC LIMIT ?`).all(...args).map(mapItem);
    },

    touch(mid, ts = now()) {
      db.prepare('UPDATE mem_items SET times_used = times_used + 1, last_used_at = ? WHERE id = ?').run(ts, mid);
    },

    update(mid, patch = {}) {
      const cur = items.get(mid);
      if (!cur) return null;
      const f = { ...cur };
      // undefined means "leave as is" — never let a spread erase a column.
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) f[k] = v;
      if (f.value !== cur.value) {
        db.prepare('INSERT INTO mem_history (item_id, ts, action, old_value, new_value) VALUES (?, ?, ?, ?, ?)')
          .run(mid, now(), 'updated', cur.value, f.value);
      }
      db.prepare('UPDATE mem_items SET kind = ?, key = ?, value = ?, tags = ?, source = ?, confidence = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(f.kind, f.key, f.value, f.tags?.length ? JSON.stringify(f.tags) : null, f.source, Number(f.confidence) || 1, f.active ? 1 : 0, now(), mid);
      return items.get(mid);
    },

    forget(mid) {
      const cur = items.get(mid);
      if (!cur) return false;
      db.prepare('INSERT INTO mem_history (item_id, ts, action, old_value) VALUES (?, ?, ?, ?)').run(mid, now(), 'forgotten', cur.value);
      db.prepare('DELETE FROM mem_items WHERE id = ?').run(mid);
      return true;
    },

    history: (mid, limit = 20) => db.prepare('SELECT * FROM mem_history WHERE item_id = ? ORDER BY ts DESC LIMIT ?').all(mid, limit),

    counts() {
      const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM mem_items WHERE active = 1 GROUP BY kind').all();
      const out = {};
      for (const r of rows) out[r.kind] = r.n;
      return { byKind: out, total: rows.reduce((a, r) => a + r.n, 0) };
    },

    /** Mark used items from a buildPrompt call, in one transaction. */
    touchMany(ids = []) {
      const stmt = db.prepare('UPDATE mem_items SET times_used = times_used + 1, last_used_at = ? WHERE id = ?');
      const t = now();
      db.transaction(() => { for (const mid of ids) stmt.run(t, mid); })();
    },
  };

  return { db, items, now, MEMORY_KINDS };
}
