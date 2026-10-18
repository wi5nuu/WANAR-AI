/**
 * src/memory/personal.js
 *
 * The personal memory service: one place where preferences, routines, places,
 * people and notes are remembered, retrieved for prompts, and forgotten on
 * request. Other modules (tracking, emergency, vehicle) feed it through the
 * `ingest(event)` hook — the owner can always see where a memory came from.
 *
 * What this deliberately does NOT do:
 *   - it never infers facts from silence or from a single guess;
 *   - it never stores a credential it saw in a chat (the prompt builder redacts);
 *   - it never hides a memory from its owner: every item is listed, editable and
 *     deletable in the Memori tab, and `forget` is a hard delete with history.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import { createPersonalStore } from './personal-store.js';
import { redact } from './owner-context.js';

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const KIND_LABEL = {
  preference: 'Kesukaan/kebiasaan',
  fact: 'Fakta',
  place: 'Tempat',
  person: 'Orang',
  routine: 'Rutinitas',
  note: 'Catatan',
};

export class PersonalError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'PersonalError';
    this.code = code;
  }
}

export class PersonalMemory extends EventEmitter {
  constructor({ store, now = () => Date.now(), maxContextChars = 900 }) {
    super();
    this.store = store;
    this.now = now;
    this.maxContextChars = maxContextChars;
  }

  // ------------------------------------------------------------- write path

  remember({ kind = 'fact', key, value, tags = [], source = 'owner', confidence = 1, note = null } = {}) {
    if (!key || !String(key).trim()) throw new PersonalError('Memori butuh kata kunci (key).', 'bad_request');
    if (value == null || !String(value).trim()) throw new PersonalError('Memori butuh isi (value).', 'bad_request');
    const kinds = this.store.MEMORY_KINDS;
    if (!kinds.includes(kind)) throw new PersonalError(`Jenis memori harus salah satu dari: ${kinds.join(', ')}.`, 'bad_request');
    const item = this.store.items.upsert({
      kind,
      key: clip(key, 120),
      value: clip(value, 1000),
      tags: Array.isArray(tags) ? tags.slice(0, 8).map((t) => clip(t, 40)) : [],
      source,
      confidence,
    });
    if (note) {
      this.store.db.prepare('INSERT INTO mem_history (item_id, ts, action, new_value, note) VALUES (?, ?, ?, ?, ?)')
        .run(item.id, this.now(), 'noted', item.value, clip(note, 200));
    }
    this.emit('change', { kind: 'remembered', itemId: item.id, ts: this.now() });
    return item;
  }

  update(id, patch) {
    if (patch.kind !== undefined && !this.store.MEMORY_KINDS.includes(patch.kind)) {
      throw new PersonalError(`Jenis memori harus salah satu dari: ${this.store.MEMORY_KINDS.join(', ')}.`, 'bad_request');
    }
    let item;
    try {
      const clean = {};
      if (patch.value !== undefined) clean.value = clip(patch.value, 1000);
      if (patch.key !== undefined) clean.key = clip(patch.key, 120);
      if (patch.kind !== undefined) clean.kind = patch.kind;
      if (patch.tags !== undefined) clean.tags = patch.tags;
      if (patch.confidence !== undefined) clean.confidence = patch.confidence;
      if (patch.active !== undefined) clean.active = patch.active;
      item = this.store.items.update(id, clean);
    } catch (e) {
      if (/UNIQUE/i.test(e?.message || '')) {
        throw new PersonalError('Sudah ada memori dengan jenis + kata kunci yang sama. Hapus atau ubah yang lama dulu.', 'bad_request');
      }
      throw e;
    }
    if (!item) throw new PersonalError('Memori tidak ditemukan.', 'not_found');
    this.emit('change', { kind: 'updated', itemId: id, ts: this.now() });
    return item;
  }

  /** Hard delete, with the old value kept in history (audit, not a shadow copy). */
  forget(id) {
    const ok = this.store.items.forget(id);
    if (!ok) throw new PersonalError('Memori tidak ditemukan.', 'not_found');
    this.emit('change', { kind: 'forgotten', itemId: id, ts: this.now() });
    return true;
  }

  /** Forget by phrase: "lupakan kopi saya". Refuses to delete everything at once unless `all` is explicit. */
  forgetByText(text, { all = false } = {}) {
    if (all) {
      const rows = this.store.items.list({ activeOnly: true, limit: 1000 });
      for (const r of rows) this.store.items.forget(r.id);
      this.emit('change', { kind: 'forgotten_all', ts: this.now() });
      return rows.length;
    }
    const hits = this.store.items.search(text, { limit: 10 });
    for (const h of hits) this.store.items.forget(h.id);
    if (hits.length) this.emit('change', { kind: 'forgotten', itemIds: hits.map((h) => h.id), ts: this.now() });
    return hits.length;
  }

  /**
   * Events from other modules become memory items, each with a stable key so a
   * repeated event never floods the list.
   */
  ingest(event = {}) {
    const at = this.now();
    try {
      switch (event.kind) {
        case 'place_correction': {
          const name = event.place?.name || event.stop?.corrected_label || event.stop?.label;
          if (!name) return null;
          const coords = event.place
            ? { lat: event.place.lat, lon: event.place.lon, radiusM: event.place.radius_m }
            : { lat: event.stop?.lat, lon: event.stop?.lon };
          return this.remember({
            kind: 'place',
            key: `place:${name}`,
            value: `${name} — koordinat ${Number(coords.lat).toFixed(5)}, ${Number(coords.lon).toFixed(5)}${coords.radiusM ? `, radius ${coords.radiusM} m` : ''}`,
            tags: ['lokasi', event.stop?.corrected_kind || event.place?.kind || 'tempat'],
            source: 'owner',
            confidence: 1,
            note: event.note || 'diberi nama oleh pemilik',
          });
        }
        case 'emergency_false_positive':
          return this.remember({
            kind: 'note',
            key: `deteksi:${new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' })}:dibatalkan`,
            value: `Deteksi darurat dibatalkan pemilik (aman) pada ${new Date(at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}. Pemicu: ${clip(event.trigger?.summary || 'tidak tercatat', 160)}`,
            tags: ['darurat', 'evaluasi-deteksi'],
            source: 'system',
            confidence: 0.9,
          });
        case 'fuel_calibration':
          return this.remember({
            kind: 'fact',
            key: 'motor:konsumsi-acuan',
            value: `Konsumsi bahan bakar acuan diperbarui ke ${event.proposed} km/L (sebelumnya ${event.current}) dari ${event.samples} pengisian penuh.`,
            tags: ['motor', 'bahan-bakar'],
            source: 'system',
            confidence: 1,
          });
        case 'service_record':
          return this.remember({
            kind: 'note',
            key: `motor:servis:${event.itemKey || 'umum'}:${new Date(Number(event.ts) || at).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' })}`,
            value: `Servis ${event.itemKey || 'umum'} dicatat pada odometer ${event.odoKm != null ? `${Math.round(event.odoKm)} km` : 'tidak dicatat'}${event.workshop ? ` di ${event.workshop}` : ''}.`,
            tags: ['motor', 'servis'],
            source: 'owner',
            confidence: 1,
          });
        default:
          return null;
      }
    } catch {
      return null; // memory is a bonus: a failed hook must never break the caller
    }
  }

  // -------------------------------------------------------------- read path

  search(query, opts = {}) { return this.store.items.search(query, opts); }

  overview() {
    return {
      counts: this.store.items.counts(),
      items: this.store.items.list({ activeOnly: true, limit: 100 }),
      kinds: this.store.MEMORY_KINDS,
      note: 'Semua memori bisa Anda ubah atau hapus; AI hanya membaca yang aktif.',
    };
  }

  /**
   * The block injected into prompts: relevant items for this question plus the
   * most recent ones, redacted, bounded.
   * @returns {{text:string, ids:string[]}}
   */
  buildPromptBlock({ text = '', limit = 12 } = {}) {
    const relevant = text ? this.store.items.search(text, { limit }) : [];
    const recent = this.store.items.list({ activeOnly: true, limit });
    const seen = new Set();
    const picked = [];
    for (const item of [...relevant, ...recent]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      picked.push(item);
      if (picked.length >= limit) break;
    }
    if (!picked.length) return { text: '', ids: [] };
    const lines = ['MEMORI PRIBADI PEMILIK (data yang dia sendiri minta diingat; gunakan bila relevan, jangan sebut sebagai "sistem"):'];
    for (const it of picked) {
      lines.push(`- [${KIND_LABEL[it.kind] || it.kind}${it.source === 'owner' ? '' : `, sumber ${it.source}`}] ${clip(redact(it.key), 60)}: ${clip(redact(it.value), 220)}`);
    }
    let out = lines.join('\n');
    if (out.length > this.maxContextChars) out = `${out.slice(0, this.maxContextChars - 1)}…`;
    this.store.items.touchMany(picked.map((p) => p.id));
    return { text: out, ids: picked.map((p) => p.id) };
  }

  /** A compact line for chat answers: "saya ingat N hal tentang X". */
  summaryLine() {
    const counts = this.store.items.counts();
    if (!counts.total) return 'Memori pribadi masih kosong.';
    const parts = Object.entries(counts.byKind).map(([k, n]) => `${n} ${KIND_LABEL[k] || k}`);
    return `Memori pribadi: ${counts.total} item aktif (${parts.join(', ')}).`;
  }
}

export { KIND_LABEL as MEMORY_KIND_LABELS };

/** Composition entry used by src/memory/index.js. */
export function createPersonalMemory({ db, now } = {}) {
  const store = createPersonalStore(db);
  return new PersonalMemory({ store, now });
}
