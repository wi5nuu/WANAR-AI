/**
 * src/career/portfolio.js
 *
 * Reads the owner's portfolio (an Astro project) and turns its `profile.ts` into a plain, validated
 * fact sheet. The portfolio is the one place the owner already maintains his CV, so it is the source
 * of truth: nothing is typed in twice and nothing is invented.
 *
 * Only `src/data/profile*.ts` is read. `.env`, backups and anything else in the folder are never opened.
 * The object literal is evaluated in an empty sandbox (no require, no process, no network).
 *
 * @author Wisnu Alfian Nur Ashar
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/** Returns the `{ ... }` literal that follows `export const <name>` (brace matching aware of strings/comments). */
export function extractLiteral(source, name = 'profile') {
  const m = new RegExp(`export\\s+const\\s+${name}\\b[^=]*=\\s*`).exec(source);
  if (!m) throw new Error(`export const ${name} tidak ditemukan`);
  let i = m.index + m[0].length;
  if (source[i] !== '{') throw new Error('literal objek tidak dimulai dengan {');
  const start = i;
  let depth = 0;
  let str = null;
  for (; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (str) {
      if (c === '\\') { i += 1; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === '/' && next === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && next === '*') { i = source.indexOf('*/', i + 2); if (i < 0) break; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('kurung kurawal tidak seimbang');
}

/** Evaluates the literal in an empty context: data only. */
export function evalLiteral(literal) {
  return vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
}

export function parseProfileTs(source) {
  return evalLiteral(extractLiteral(source));
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => String(v ?? '').trim();

/** Keeps only the parts of the profile the agent may use, in one stable shape. */
export function normalizeProfile(p) {
  const pi = p.personalInfo || {};
  const sk = p.skills || {};
  const group = (g) => arr(sk[g]).map((s) => str(s.name)).filter(Boolean);
  const exp = (e) => ({
    role: str(e.role), company: str(e.company), type: str(e.type), duration: str(e.duration),
    location: str(e.location), description: str(e.description), skills: arr(e.skills).map(str).filter(Boolean),
  });
  return {
    personalInfo: {
      name: str(pi.name), role: str(pi.role), location: str(pi.location), tagline: str(pi.tagline), summary: str(pi.summary),
      email: str(pi.email), phone: str(pi.phone), linkedin: str(pi.linkedin), github: str(pi.github), website: str(pi.website),
    },
    skills: {
      programming: group('programming'), webTech: group('webTech'), aiMl: group('aiMl'),
      securityCloud: group('securityCloud'), tools: group('tools'), soft: group('soft'),
    },
    experience: arr(p.experience).map(exp),
    organizationalExperience: arr(p.organizationalExperience).map(exp),
    projects: arr(p.projects).map((x) => ({
      title: str(x.title), role: str(x.role), status: str(x.status), link: str(x.link), github: str(x.github),
      description: str(x.description), techStack: arr(x.techStack).map(str).filter(Boolean),
    })),
    education: {
      institution: str(p.education?.institution), degree: str(p.education?.degree), duration: str(p.education?.duration),
      location: str(p.education?.location), focus: str(p.education?.focus),
    },
    educationHistory: arr(p.educationHistory).map(str).filter(Boolean),
    certifications: arr(p.certifications).map((c) => ({ name: str(c.name), issuer: str(c.issuer), date: str(c.date), id: str(c.id), description: str(c.description) })),
    competitions: arr(p.competitions).map((c) => ({ name: str(c.name), issuer: str(c.issuer), date: str(c.date), category: str(c.category), description: str(c.description) })),
    openSource: arr(p.openSource).map((o) => ({ organization: str(o.organization), project: str(o.project), language: str(o.language), impact: str(o.impact), category: str(o.category) })),
  };
}

/**
 * Reads `<dir>/src/data/profile.ts` (English) and `profile_id.ts` (Indonesian, optional).
 * @returns {{version:1, importedAt:string, source:{folder:string, website:string}, en:object, id:object|null}}
 */
export function importPortfolio(dir, { now = new Date() } = {}) {
  const read = (file) => {
    const p = path.join(dir, 'src', 'data', file);
    return fs.existsSync(p) ? normalizeProfile(parseProfileTs(fs.readFileSync(p, 'utf8'))) : null;
  };
  const en = read('profile.ts');
  if (!en) throw new Error(`profile.ts tidak ditemukan di ${path.join(dir, 'src', 'data')}`);
  return {
    version: 1,
    importedAt: now.toISOString(),
    source: { folder: path.basename(dir), website: en.personalInfo.website },
    en,
    id: read('profile_id.ts'),
  };
}
