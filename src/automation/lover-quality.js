/**
 * src/automation/lover-quality.js
 *
 * Deterministic guards for the romantic Telegram persona. The model is asked
 * to follow a style contract, but prompt instructions alone are not trusted:
 *
 *   - status claims are checked against the verified BUSY/AVAILABLE/UNKNOWN state
 *   - unverified first-person experiences are held for owner review
 *   - explicit AI questions/denials are answered truthfully
 *   - reply length follows the incoming message, within sensible limits
 *   - emoji and vocative pet names have a small budget
 *
 * This module has no I/O and no model calls, so it is safe to unit test.
 *
 * @author Wisnu Alfian Nur Ashar
 */

const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;
const PET_NAME_RE = /\b(sayang|beb|bebs|cintaku|sayangku|ayang)\b/gi;
const SERIOUS_RE = /\b(capek|lelah|sedih|nangis|insecure|bad\s*mood|stres|stress|kecewa|marah|maaf|sakit|cemas|takut|overthinking|berat|masalah|konflik|pusing|sendirian|kesepian)\b/i;

// First-person claims that only make sense when the owner's status is known.
const CLAIM_BUSY = new RegExp(
  String.raw`\b(?:aku|mas|wisnu)\s+(?:kan\s+)?(?:lagi\s+|sedang\s+|masih\s+|udah\s+|sudah\s+)?` +
  String.raw`(?:sibuk|kerja|bekerja|rapat|meeting|kelas|kampus|kantor|toko|dinas|shift|deadline|urusan|proyek|acara)\b`,
  'i',
);
const CLAIM_AVAILABLE = new RegExp(
  String.raw`\b(?:aku|mas|wisnu)\s+(?:kan\s+)?(?:lagi\s+|sedang\s+)?` +
  String.raw`(?:luang|free|kosong|nganggur|nggak\s+sibuk|tidak\s+sibuk|gak\s+sibuk)\b`,
  'i',
);
const CLAIM_ACTIVITY = new RegExp(
  String.raw`\b(?:aku|mas|wisnu)\s+(?:lagi\s+|sedang\s+|masih\s+)?` +
  String.raw`(?:tidur|istirahat|makan|nyetir|nyupir|di\s+jalan|di\s+luar|di\s+rumah|di\s+kantor|di\s+toko|di\s+kampus|di\s+sekolah|mandi|masak|nonton|main|belajar|bangun)\b`,
  'i',
);
const CLAIM_EXPERIENCE = new RegExp(
  String.raw`\b(?:aku|mas|wisnu)\s+(?:baru|habis|udah|sudah|tadi|kemarin)\s+` +
  String.raw`(?:makan|mandi|bangun|sampai|pulang|selesai|kerja|rapat|ketemu|pergi|datang|nyampe|tidur|nonton|beli|jalan)\b`,
  'i',
);
const CLAIM_MEMORY = new RegExp(
  String.raw`\b(?:aku|kita|kami)\s+(?:masih\s+)?(?:inget|ingat)\s+(?:waktu|saat|dulu|kemarin|terakhir)\b`,
  'i',
);

const AI_WORD = String.raw`(?:ai|bot|robot|chatbot|mesin|asisten)`;

function wordsOf(text) {
  return String(text || '')
    .replace(EMOJI_RE, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function wordCount(text) {
  return wordsOf(text).length;
}

export function emojiCount(text) {
  return String(text || '').match(EMOJI_RE)?.length || 0;
}

/**
 * Default length budget. Serious topics keep at least two sentences so the
 * reply does not feel dismissive; ordinary short messages stay short.
 */
export function planLength(incoming, { aiQuestion = false } = {}) {
  const words = wordCount(incoming);
  const serious = SERIOUS_RE.test(String(incoming || ''));
  let maxSentences = words <= 8 ? 1 : words <= 25 ? 2 : 4;
  if (serious) maxSentences = Math.max(maxSentences, 2);
  if (aiQuestion) maxSentences = Math.max(maxSentences, 2);
  const target = maxSentences === 1
    ? 'satu kalimat pendek'
    : maxSentences === 2
      ? 'satu atau dua kalimat'
      : 'dua sampai empat kalimat';
  return { words, maxSentences, serious, target };
}

export function splitSentences(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  return t
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function capSentences(text, max) {
  const limit = Math.max(1, Number(max) || 1);
  const parts = splitSentences(text);
  if (parts.length <= limit) return String(text || '').trim();
  return parts.slice(0, limit).join(' ').trim();
}

export function limitEmojis(text, max = 2) {
  const limit = Math.max(0, Math.min(10, Number.isFinite(Number(max)) ? Number(max) : 2));
  let seen = 0;
  return String(text || '')
    .replace(EMOJI_RE, (m) => {
      seen += 1;
      return seen <= limit ? m : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

/**
 * Keep at most one pet name. Only repeated vocatives (start/end/comma
 * surrounded) are removed; "aku sayang kamu" is not treated as a vocative.
 */
export function limitPetNames(text, max = 1) {
  const limit = Math.max(0, Number(max) || 0);
  let seen = 0;
  return String(text || '')
    .replace(PET_NAME_RE, (m, _word, offset, source) => {
      seen += 1;
      if (seen <= limit) return m;
      const before = source[offset - 1] || '';
      const after = source[offset + m.length] || '';
      const vocative = /[,.!?\s]/.test(before) && /[,.!?\s]/.test(after);
      return vocative ? '' : m;
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

/** Explicit question about whether the recipient is talking to an AI. */
export function asksAboutAI(text) {
  const t = String(text || '');
  if (new RegExp(String.raw`\b(?:kamu|ini|yang\s+(?:balas|chat|ketik))\b[^?]{0,60}\b${AI_WORD}\b`, 'i').test(t)) return true;
  if (new RegExp(String.raw`\b${AI_WORD}\b[^?]{0,40}\b(?:ya|kah|kan|bukan|beneran|asli)\b`, 'i').test(t)) return true;
  if (/\b(?:beneran|asli)\s+(?:kamu\s+)?(?:wisnu|manusia)\b/i.test(t)) return true;
  if (/\b(?:kamu|ini)\s+(?:beneran|asli)\s+(?:wisnu|manusia)\b/i.test(t)) return true;
  return false;
}

export function deniesAI(text) {
  const t = String(text || '');
  return (
    /\b(?:aku|ini)\s+(?:bukan|bukanlah)\s+(?:ai|bot|robot|chatbot|mesin)\b/i.test(t)
    || /\baku\s+(?:manusia|orang)\s+asli\b/i.test(t)
    || /\baku\s+beneran\s+(?:wisnu|manusia)\b/i.test(t)
    || /\bbukan\s+(?:ai|bot|robot|chatbot)\b/i.test(t)
  );
}

function mentionsAI(text) {
  return new RegExp(String.raw`\b${AI_WORD}\b|dibantu\s+ai|bantuan\s+ai`, 'i').test(String(text || ''));
}

export function truthfulAIText(first = 'Wisnu') {
  return `iya, ini AI milik ${first} yang bantu balas chat. kalau kamu nggak nyaman, bilang aja ya.`;
}

export function statusFallback(status) {
  if (status === 'sibuk') return 'aku lagi sibuk sekarang, nanti aku balas lagi ya.';
  if (status === 'luang') return 'aku lagi luang kok, kamu mau cerita?';
  return 'aku belum bisa mastiin sekarang, nanti aku kabarin ya.';
}

export function reviewHoldText() {
  return 'sebentar ya, aku belum bisa jawab itu sekarang. nanti aku kabarin ya.';
}

/** Return the first first-person status/activity/experience claim, if any. */
export function detectStatusClaim(text) {
  const t = String(text || '');
  if (CLAIM_EXPERIENCE.test(t)) return { kind: 'experience', text: t.match(CLAIM_EXPERIENCE)[0] };
  if (CLAIM_MEMORY.test(t)) return { kind: 'memory', text: t.match(CLAIM_MEMORY)[0] };
  if (CLAIM_AVAILABLE.test(t)) return { kind: 'available', text: t.match(CLAIM_AVAILABLE)[0] };
  if (CLAIM_BUSY.test(t)) return { kind: 'busy', text: t.match(CLAIM_BUSY)[0] };
  if (CLAIM_ACTIVITY.test(t)) return { kind: 'activity', text: t.match(CLAIM_ACTIVITY)[0] };
  return null;
}

function noteAllows(claim, note) {
  const n = String(note || '').toLowerCase().trim();
  if (!n) return false;
  const words = String(claim || '').toLowerCase().match(/[a-z]{4,}/g) || [];
  return words.some((w) => !['aku', 'lagi', 'sedang', 'masih', 'udah', 'sudah'].includes(w) && n.includes(w));
}

function claimAllowed(claim, status, note) {
  if (claim.kind === 'busy') {
    if (status !== 'sibuk') return false;
    // "sibuk" itself is verified by the state; a specific reason must exist in
    // the owner's note (e.g. "rapat" only when the note says rapat).
    if (/\bsibuk\b/i.test(claim.text)) return true;
    return noteAllows(claim.text, note);
  }
  if (claim.kind === 'available') return status === 'luang';
  if (claim.kind === 'activity') {
    if (status !== 'sibuk') return false;
    return noteAllows(claim.text, note);
  }
  return false;
}

/**
 * Clean a generated reply before delivery.
 * @returns {{text:string, issues:string[], needsReview:boolean}}
 */
export function sanitizeReply({
  text,
  incoming = '',
  status = 'unknown',
  note = '',
  emojiMax = 2,
  first = 'Wisnu',
} = {}) {
  let out = String(text || '').trim();
  const issues = [];
  if (!out) return { text: '', issues: ['empty'], needsReview: false };

  const aiQuestion = asksAboutAI(incoming);
  if (deniesAI(out) || (aiQuestion && !mentionsAI(out))) {
    out = truthfulAIText(first);
    issues.push(aiQuestion ? 'ai_question' : 'ai_denial');
  }

  const claim = detectStatusClaim(out);
  if (claim) {
    if (claim.kind === 'experience' || claim.kind === 'memory') {
      issues.push(`unverified_${claim.kind}`);
      return { text: out, issues, needsReview: true };
    }
    if (!claimAllowed(claim, status, note)) {
      out = statusFallback(status);
      issues.push(`status_${claim.kind}`);
    }
  }

  const plan = planLength(incoming, { aiQuestion });
  const capped = capSentences(out, plan.maxSentences);
  if (capped !== out) {
    out = capped;
    issues.push('length_capped');
  }

  const limited = limitEmojis(out, emojiMax);
  if (limited !== out) {
    out = limited;
    issues.push('emoji_limited');
  }

  const petLimited = limitPetNames(out, 1);
  if (petLimited !== out) {
    out = petLimited;
    issues.push('pet_name_limited');
  }

  out = out.replace(/[ \t]{2,}/g, ' ').trim();
  if (!out) out = statusFallback(status);
  return { text: out, issues, needsReview: false };
}
