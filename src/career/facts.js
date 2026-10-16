/**
 * src/career/facts.js
 *
 * The owner's fact sheet (imported from the portfolio, see portfolio.js) as the agent uses it at run
 * time: loaded from a JSON file, validated, cached by modification time, and turned into the things
 * the rest of the engine needs (skill list for scoring, honest experience length for answers).
 *
 * The file lives in data/ (git-ignored): it holds personal details and must never be committed.
 * A missing or broken file only means "no facts yet": nothing else depends on it.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import fs from 'node:fs';

const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  januari: 0, februari: 1, maret: 2, mei: 4, juni: 5, juli: 6, agustus: 7, oktober: 9, desember: 11 };

/** Not skills: filler that would match any job text. */
const NOISE = new Set(['sdlc', 'qa/uat', 'agile', 'cdn', 'jwt', 'teamwork', 'communication', 'leadership', 'creativity', 'problem-solving', 'event management']);

export function validateFacts(f) {
  const errors = [];
  if (!f || typeof f !== 'object') return { ok: false, errors: ['bukan objek'] };
  if (f.version !== 1) errors.push('version harus 1');
  if (!f.en?.personalInfo?.name) errors.push('en.personalInfo.name kosong');
  if (!Array.isArray(f.en?.experience)) errors.push('en.experience bukan daftar');
  if (!Array.isArray(f.en?.projects)) errors.push('en.projects bukan daftar');
  const skills = f.en?.skills || {};
  if (!['programming', 'webTech'].some((g) => Array.isArray(skills[g]) && skills[g].length)) errors.push('daftar keahlian kosong');
  return { ok: errors.length === 0, errors };
}

const cache = new Map(); // file -> { mtimeMs, facts }

/** @returns {object|null} validated facts, or null when the file is absent/invalid */
export function loadFacts(file) {
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.facts;
    const facts = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = validateFacts(facts);
    const out = v.ok ? facts : null;
    cache.set(file, { mtimeMs: st.mtimeMs, facts: out });
    return out;
  } catch {
    return null;
  }
}

/** "Next.js 16" -> "next.js", "Cloudflare (WAF, DNS & SSL)" -> "cloudflare", "Go (Golang)" -> "golang" */
export function cleanSkill(raw) {
  let s = String(raw || '').toLowerCase().trim();
  const golang = /\(golang\)/.test(s);
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\s+v?\d+(\.\d+)*\+?$/, '').replace(/\s+/g, ' ').trim();
  if (golang) s = 'golang';
  return s;
}

/** Skill names the scorer can match against job text (lower-case, de-duplicated, no filler). */
export function skillsFromFacts(facts) {
  if (!facts?.en) return [];
  const raw = [];
  const sk = facts.en.skills || {};
  for (const g of ['programming', 'webTech', 'aiMl', 'securityCloud', 'tools']) raw.push(...(sk[g] || []));
  for (const p of facts.en.projects || []) raw.push(...(p.techStack || []));
  for (const e of facts.en.experience || []) raw.push(...(e.skills || []));
  const out = new Set();
  for (const r of raw) {
    // Clean first (drops "(WAF, DNS & SSL)" whole), only then split "RAG & LLM Integration" into two skills.
    for (const part of cleanSkill(r).split(/\s*&\s*/)) {
      const s = part.trim();
      if (s.length < 2 || s.length > 30 || NOISE.has(s)) continue;
      out.add(s);
      if (s.endsWith('.js')) out.add(s.slice(0, -3) + 'js'); // next.js / nextjs
    }
  }
  return [...out];
}

function parseMonth(text, fallbackNow) {
  const t = String(text || '').trim().toLowerCase();
  if (/^(present|sekarang|now|saat ini)$/.test(t)) return fallbackNow;
  const m = /([a-z]+)\s+(\d{4})/.exec(t);
  if (!m || !(m[1] in MONTHS)) return null;
  return Date.UTC(Number(m[2]), MONTHS[m[1]], 1);
}

/**
 * Months of paid/professional work in `experience` (internships and self-employment count, student
 * organisations do not). Overlapping roles are merged, and a role never counts past `now`.
 */
export function experienceMonths(facts, now = Date.now()) {
  const spans = [];
  for (const e of facts?.en?.experience || []) {
    const [a, b] = String(e.duration || '').split(/\s+[-–]\s+/);
    const s = parseMonth(a, now);
    const f = parseMonth(b, now);
    if (s == null || f == null) continue;
    const end = Math.min(f, now);
    if (end > s) spans.push([s, end]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const sp of spans) {
    if (!cur) cur = [...sp];
    else if (sp[0] <= cur[1]) cur[1] = Math.max(cur[1], sp[1]);
    else { total += cur[1] - cur[0]; cur = [...sp]; }
  }
  if (cur) total += cur[1] - cur[0];
  return Math.round(total / (30.44 * 86_400_000));
}

/** Counts only, no personal values: safe to show in logs and chat. */
export function factSummary(facts, now = Date.now()) {
  if (!facts?.en) return null;
  const e = facts.en;
  return {
    importedAt: facts.importedAt,
    skills: skillsFromFacts(facts).length,
    experience: e.experience.length,
    organizations: e.organizationalExperience?.length || 0,
    projects: e.projects.length,
    certifications: e.certifications?.length || 0,
    competitions: e.competitions?.length || 0,
    openSource: e.openSource?.length || 0,
    professionalMonths: experienceMonths(facts, now),
    hasIndonesian: Boolean(facts.id),
  };
}
