/**
 * src/career/kit.js
 *
 * The application kit: everything the owner needs to apply to one posting in two minutes. A cover
 * letter, the answers every form asks for, the CV, and the questions only the owner can answer.
 *
 * The cover letter is assembled, not improvised: each sentence is a fixed template filled ONLY with
 * values taken from the owner's fact sheet (skills he really lists, projects he really built, roles
 * he really held, months he really worked). Nothing can be claimed that the portfolio does not say,
 * which is what keeps an application from becoming a lie that surfaces at the interview.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { hasSkill } from './scoring.js';
import { cleanSkill, skillsFromFacts, experienceMonths } from './facts.js';
import { detectLanguage } from '../sales/qualify.js';

const MAX_SKILLS = 5;
const MAX_PROJECTS = 2;

/** Sites that put a bot check in front of the posting: opened by hand, never by a script. */
const BOT_PROTECTED = /(^|\.)weworkremotely\.com$/i;

const firstSentence = (s) => String(s || '').split(/(?<=[.!?])\s+/)[0].trim();

/** token -> the way the owner writes it ("next.js" -> "Next.js") */
function displayNames(facts) {
  const m = new Map();
  const sk = facts.en.skills || {};
  const raw = [];
  for (const g of ['programming', 'webTech', 'aiMl', 'securityCloud', 'tools']) raw.push(...(sk[g] || []));
  for (const p of facts.en.projects || []) raw.push(...(p.techStack || []));
  for (const e of facts.en.experience || []) raw.push(...(e.skills || []));
  for (const r of raw) { const t = cleanSkill(r); if (t && !m.has(t)) m.set(t, String(r).replace(/\s*\([^)]*\)/g, '').replace(/\s+v?\d+(\.\d+)*\+?$/, '').trim()); }
  return m;
}

/** Skills the owner lists that the posting actually asks for, title/tags first. */
export function matchedFactSkills(job, facts) {
  const title = `${job.title || ''}\n${(job.tags || []).join(' ')}`;
  const body = `${title}\n${job.description || ''}`;
  const names = displayNames(facts);
  const inTitle = []; const inBody = [];
  for (const t of skillsFromFacts(facts)) {
    if (t.endsWith('js') && !t.includes('.') && skillsFromFacts(facts).includes(`${t.slice(0, -2)}.js`)) continue; // nextjs duplicate
    if (t.length < 3) continue;
    if (hasSkill(title, t)) inTitle.push(t);
    else if (hasSkill(body, t)) inBody.push(t);
  }
  return [...inTitle, ...inBody].slice(0, MAX_SKILLS).map((t) => names.get(t) || t);
}

function pickProjects(facts, skillNames, lang) {
  const wanted = new Set(skillNames.map((s) => cleanSkill(s)));
  const src = (lang === 'id' && facts.id ? facts.id : facts.en).projects || [];
  const en = facts.en.projects || [];
  const scored = en.map((p, i) => {
    const overlap = (p.techStack || []).filter((t) => wanted.has(cleanSkill(t))).length;
    return { i, overlap, prod: /production/i.test(p.status) ? 1 : 0, p: src[i] || p };
  }).filter((x) => x.overlap > 0);
  scored.sort((a, b) => b.overlap - a.overlap || b.prod - a.prod || a.i - b.i);
  return scored.slice(0, MAX_PROJECTS).map((x) => x.p);
}

/** Past roles whose own skill list overlaps what the posting asks for: quoted from the owner's description. */
function pickExperience(facts, skillNames, lang) {
  const wanted = new Set(skillNames.map((s) => cleanSkill(s)));
  const en = facts.en.experience || [];
  const src = (lang === 'id' && facts.id ? facts.id : facts.en).experience || [];
  return en.map((e, i) => ({ i, overlap: (e.skills || []).filter((t) => wanted.has(cleanSkill(t))).length, e: src[i] || e }))
    .filter((x) => x.overlap > 0 && firstSentence(x.e.description).length > 20)
    .sort((a, b) => b.overlap - a.overlap || a.i - b.i)
    .slice(0, 1)
    .map((x) => x.e);
}

const T = {
  en: {
    greet: (c) => `Dear ${c ? `${c} ` : ''}Hiring Team,`,
    apply: (title) => `I am applying for the ${title} position.`,
    who: (role, loc) => `I am a ${role} based in ${loc}.`,
    exp: (months, parts) => `I have about ${months} months of hands-on professional experience${parts ? ` (${parts})` : ''}.`,
    current: (r, c) => `My most recent role is ${r} at ${c}.`,
    skills: (list) => `Your posting asks for ${list}, which I list among my skills and have used in my projects.`,
    experience: 'Relevant experience:',
    projects: 'Relevant work:',
    remote: 'I work remotely from Indonesia (UTC+7).',
    links: (l) => `More of my work: ${l}`,
    thanks: 'Thank you for your time and consideration.',
    sign: 'Sincerely,',
  },
  id: {
    greet: (c) => `Yth. Tim Rekrutmen${c ? ` ${c}` : ''},`,
    apply: (title) => `Saya melamar untuk posisi ${title}.`,
    who: (role, loc) => `Saya ${role} yang berdomisili di ${loc}.`,
    exp: (months, parts) => `Saya memiliki sekitar ${months} bulan pengalaman kerja langsung${parts ? ` (${parts})` : ''}.`,
    current: (r, c) => `Peran terakhir saya adalah ${r} di ${c}.`,
    skills: (list) => `Lowongan Anda membutuhkan ${list}, yang tercantum dalam keahlian saya dan telah saya pakai dalam proyek.`,
    experience: 'Pengalaman yang relevan:',
    projects: 'Karya yang relevan:',
    remote: 'Saya bekerja jarak jauh dari Indonesia (UTC+7).',
    links: (l) => `Karya saya yang lain: ${l}`,
    thanks: 'Terima kasih atas waktu dan pertimbangan Anda.',
    sign: 'Hormat saya,',
  },
};

const list = (a, lang) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} ${lang === 'id' ? 'dan' : 'and'} ${a.at(-1)}`);

/** @returns {{lang:string, text:string, skills:string[], projects:string[]}} */
export function coverLetter(job, facts, { now = Date.now(), lang = null } = {}) {
  const l = lang || (detectLanguage(`${job.title} ${job.description || ''}`.slice(0, 1500)) === 'id' && facts.id ? 'id' : 'en');
  const t = T[l];
  const f = l === 'id' && facts.id ? facts.id : facts.en;
  const pi = f.personalInfo;
  const months = experienceMonths(facts, now);
  const skills = matchedFactSkills(job, facts);
  const projects = pickProjects(facts, skills, l);
  const roles = pickExperience(facts, skills, l);
  const exp = facts.en.experience || [];
  const hasIntern = exp.some((e) => /intern/i.test(e.type));
  const hasSelf = exp.some((e) => /self/i.test(e.type));
  const parts = [hasIntern ? (l === 'id' ? 'magang' : 'internships') : null, hasSelf ? (l === 'id' ? 'pekerjaan mandiri' : 'self-employed full-stack work') : null].filter(Boolean).join(l === 'id' ? ' dan ' : ' and ');
  const latest = (f.experience || [])[0];

  const body = [t.greet(job.company), '', t.apply(job.title), `${t.who(pi.role || 'Full-Stack Engineer', pi.location)} ${months > 0 ? t.exp(months, parts) : ''}`.trim()];
  if (latest?.role && latest?.company) body.push(t.current(latest.role, latest.company));
  if (skills.length) body.push('', t.skills(list(skills, l)));
  if (roles.length) body.push(t.experience, ...roles.map((e) => `- ${e.role}, ${e.company}: ${firstSentence(e.description)}`));
  if (projects.length) body.push(t.projects, ...projects.map((p) => `- ${p.title}${p.status ? ` (${p.status})` : ''}: ${firstSentence(p.description)}`));
  body.push('', t.remote);
  const links = [pi.website, pi.github, pi.linkedin].filter(Boolean).join(' | ');
  if (links) body.push(t.links(links));
  body.push('', t.thanks, '', t.sign, pi.name);
  return { lang: l, text: body.join('\n').replace(/\n{3,}/g, '\n\n').trim(), skills, projects: projects.map((p) => p.title) };
}

/**
 * @param {object} job   a stored posting (with description)
 * @param {object} facts the fact sheet
 * @param {{now?: number, email?: string|null, resumeFile?: string|null}} opts
 */
export function buildKit(job, facts, { now = Date.now(), email = null, resumeFile = null } = {}) {
  if (!facts?.en) return { ok: false, error: 'Lembar fakta portofolio belum ada.' };
  const pi = facts.en.personalInfo;
  const letter = coverLetter(job, facts, { now });
  const [first, ...rest] = String(pi.name || '').split(/\s+/);
  const country = String(pi.location || '').split(',').pop().trim();
  const edu = facts.en.education || {};
  const exp = (facts.en.experience || [])[0];
  const months = experienceMonths(facts, now);

  const answers = [
    ['Full name', pi.name], ['First name', first], ['Last name', rest.join(' ')],
    ['Email', email || pi.email], ['Phone', pi.phone], ['Location', pi.location], ['Country', country],
    ['LinkedIn', pi.linkedin], ['GitHub', pi.github], ['Website / portfolio', pi.website],
    ['Current role', exp ? `${exp.role}, ${exp.company}` : null],
    ['Professional experience', months ? `about ${months} months (${(facts.en.experience || []).map((e) => e.type).filter(Boolean).join(', ')})` : null],
    ['Education', [edu.degree, edu.institution, edu.focus].filter(Boolean).join(', ')],
    ['Matching skills', letter.skills.join(', ')],
  ].filter(([, v]) => v).map(([label, value]) => ({ label, value: String(value) }));

  // Only the owner can answer these; guessing them is how an application turns into a false statement.
  const needsOwner = [
    { label: 'Izin kerja / sponsor visa', why: 'Jawabannya mengikat secara hukum dan berbeda tiap negara.' },
    { label: 'Ekspektasi gaji', why: 'Keputusan Mas.' },
    { label: 'Tanggal mulai / masa pemberitahuan', why: 'Magang di PT Grahabuana berjalan sampai Desember 2026.' },
    { label: 'Alasan tertarik pada perusahaan ini', why: 'Harus berasal dari minat Mas, bukan karangan.' },
  ];

  let host = '';
  try { host = new URL(job.url).hostname; } catch { /* keep empty */ }
  const warnings = [];
  if (BOT_PROTECTED.test(host)) warnings.push('Halaman ini dilindungi pemeriksaan bot. Buka sendiri di browser, lalu tempel isi paket ini.');
  if (job.eligibility === 'maybe') warnings.push('Kelayakan dari Indonesia belum pasti. Baca syarat lokasi/izin kerja di halaman aslinya sebelum melamar.');
  if (!letter.skills.length) warnings.push('Tidak ada keahlian di portofolio yang disebut jelas oleh lowongan ini; surat tidak menyebut keahlian.');

  return {
    ok: true,
    job: { id: job.id, title: job.title, company: job.company, url: job.url, location: job.location, score: job.score },
    lang: letter.lang, coverLetter: letter.text, subject: `Application: ${job.title}${pi.name ? ` - ${pi.name}` : ''}`,
    answers, needsOwner, resume: resumeFile ? { file: resumeFile } : null, warnings,
  };
}

/** The kit as one Telegram-sized message. */
export function kitMessage(kit) {
  if (!kit.ok) return kit.error;
  const l = [`Paket lamaran: ${kit.job.title} - ${kit.job.company || 'perusahaan tidak disebut'} (skor ${kit.job.score})`, `Buka: ${kit.job.url}`, ''];
  if (kit.warnings.length) l.push(...kit.warnings.map((w) => `Catatan: ${w}`), '');
  l.push('SURAT LAMARAN', kit.coverLetter, '', 'JAWABAN STANDAR');
  for (const a of kit.answers.filter((x) => ['Email', 'Phone', 'Location', 'LinkedIn', 'GitHub', 'Website / portfolio'].includes(x.label))) l.push(`${a.label}: ${a.value}`);
  l.push('', 'Perlu jawaban Mas sendiri:', ...kit.needsOwner.map((n) => `- ${n.label}`));
  return l.join('\n');
}
