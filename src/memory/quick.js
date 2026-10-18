/**
 * src/memory/quick.js
 *
 * Deterministic personal-memory intents: "ingat ya, kopi saya tanpa gula",
 * "lupakan kopi", "kamu ingat apa soal warung Bu Yati?". Answered by code, so
 * remembering and forgetting never depends on a model call.
 *
 * @author Wisnu Alfian Nur Ashar
 */

const REMEMBER = /\b(ingat|hafalkan|hafal)\b.{0,3}(ya|dong|yak)?\b[.,:]?\s+(.{3,300})$/i;
const REMEMBER2 = /^\s*(?:tolong\s+)?(?:catat|simpan|masukkan ke memori)\b[.,:]?\s+(.{3,300})$/i;
const FORGET = /\b(lupakan|lupa|cabut|hapus)\b\s+(?:ingatan|memori|catatan)?\s*(?:soal|tentang|tentang hal)?\s*(.{3,120})$/i;
const ASK_ABOUT = /\b(kamu|kalian|sistem)\b.{0,20}\b(ingat|tahu|catat)\b.{0,20}\b(tentang|soal|akan)\b\s*(.{2,120})/i;
const ASK_ALL = /\b(apa saja|apa aja)\b.{0,20}\b(kamu|kalian)\b.{0,12}\b(ingat|tahu|catat)\b/i;

/** Cheap, honest classification: explicit words choose the kind, otherwise "note". */
export function kindFor(text) {
  const t = String(text).toLowerCase();
  if (/\b(rumah|kantor|warung|tempat|kos|kontrakan|bengkel|kampus)\b/.test(t)) return 'place';
  if (/\b(ibu|bapak|mas|mbak|istri|suami|temanku|kakak|adik|saudara|tetangga|nama saya)\b/.test(t)) return 'person';
  if (/\b(suka|tidak suka|gak suka|favorit|kesukaan|preferensi|lebih baik|selalu pesan)\b/.test(t)) return 'preference';
  if (/\b(setiap|biasanya|rutin|selalu|tiap (hari|minggu|pagi|malam))\b/.test(t)) return 'routine';
  return 'fact';
}

/** A short key from the remembered sentence, so repeats upsert instead of piling up. */
export function keyFor(text) {
  const words = String(text).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 4);
  return words.join('-') || 'catatan';
}

/**
 * @param {object} memory  memory module ({ service })
 * @param {string} text
 * @returns {string|null}
 */
export function quickMemory(memory, text) {
  const svc = memory?.service;
  if (!svc) return null;
  const t = String(text || '').trim();
  if (!t || t.length > 400) return null;

  const forget = FORGET.exec(t);
  if (forget && !/^\s*(hapus|matikan)\b/i.test(t)) {
    const q = forget[2].trim().replace(/[.?!]+$/, '');
    const n = svc.forgetByText(q);
    return n
      ? `✓ Saya lupakan ${n} memori yang berkaitan dengan "${q}". Sisanya tetap tersimpan.`
      : `Tidak ada memori yang cocok dengan "${q}". Kalau ingin menghapus semua, buka halaman Memori.`;
  }

  if (ASK_ALL.test(t)) {
    const o = svc.overview();
    if (!o.counts.total) return 'Belum ada yang Anda minta saya ingat.';
    const lines = o.items.slice(0, 10).map((i) => `• ${i.key}: ${i.value}`);
    return [`Saya menyimpan ${o.counts.total} hal:`, ...lines].join('\n');
  }

  const ask = ASK_ABOUT.exec(t);
  if (ask) {
    const q = ask[4].trim().replace(/[.?!]+$/, '');
    const items = svc.search(q, { limit: 6 });
    if (!items.length) return `Tidak ada di memori saya soal "${q}". Kalau mau saya ingat, tulis misalnya "ingat ya: ${q.toLowerCase()} ...".`;
    return ['Yang saya ingat:', ...items.map((i) => `• ${i.key}: ${i.value}`)].join('\n');
  }

  const remember = REMEMBER2.exec(t) || REMEMBER.exec(t);
  if (remember) {
    const raw = remember[remember.length - 1].trim().replace(/[.?!]+$/, '');
    if (raw.length < 3) return null;
    const item = svc.remember({ kind: kindFor(raw), key: keyFor(raw), value: raw, tags: ['dari-chat'], source: 'owner' });
    return `✓ Saya ingat: "${raw}". (Tersimpan sebagai ${item.kind} dengan kata kunci "${item.key}" — bisa diubah atau dihapus kapan saja di halaman Memori.)`;
  }

  return null;
}
