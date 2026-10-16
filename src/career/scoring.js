/**
 * src/career/scoring.js
 *
 * Decides, deterministically, whether a posting is worth the owner's time. No model is asked:
 * a score that can be wrong in a new way every run is useless for "never make a mistake", so
 * every number here comes from a rule that is written down and tested, and every verdict ships
 * with the reasons behind it.
 *
 *   verdict  apply  – good fit AND the owner can legally/practically work from Indonesia
 *            maybe  – plausible but something is unknown (years, location, seniority)
 *            skip   – wrong role, too senior, region-locked, or clearly a bad fit
 *
 * @author Wisnu Alfian Nur Ashar
 */

const ROLE_GOOD = [
  [/full[\s-]?stack/i, 30, 'full-stack'],
  [/back[\s-]?end/i, 28, 'backend'],
  [/software\s+(engineer|developer)/i, 26, 'software engineer'],
  [/web\s+(developer|engineer)/i, 26, 'web developer'],
  [/(node(\.js)?|react|next\.?js|typescript|javascript|python|golang|\bgo\b|php|laravel|java)\s+(developer|engineer)/i, 26, 'developer'],
  [/\b(developer|engineer)\b/i, 14, 'developer/engineer'],
  [/front[\s-]?end/i, 18, 'frontend'],
  [/\b(devops|sre|platform)\b/i, 10, 'devops'],
];

// Anything that is plainly not a software job; checked against the TITLE only.
// Stems may run on ("recruit" -> "Recruiter"), hence no closing \b except where a short word needs one.
const NOT_SOFTWARE = /\b(sales|account (executive|manager)|marketing|recruit|talent|accountant|bookkeep|finance|legal|counsel|paralegal|designer|writer|editor|copywrit|customer (support|success|service)|support (specialist|agent)|community|operations manager|office|assistant|nurse|teacher|tutor|payroll|hr\b|human resources|content creator|social media|seo\b|business development)/i;

const SENIOR_TITLE = /\b(senior|sr\.?|lead|principal|staff|head of|director|vp\b|vice president|architect|manager|distinguished|fellow|chief)\b/i;
const JUNIOR_TITLE = /\b(junior|jr\.?|entry[\s-]?level|graduate|associate|trainee|intern(ship)?|fresher|new grad|early career)\b/i;

const REGION_OK = /(worldwide|anywhere|global|any location|all locations|world[\s-]?wide|asia|apac|south[\s-]?east|indonesia|jakarta|gmt\+?[5-9]\b|utc\+?[5-9]\b|international)/i;
const REGION_BLOCK = /(\b(us|usa|u\.s\.a?\.?|united states|america)\b[\s,/-]*(only|based|residents?|citizens?)?|\b(canada|uk|united kingdom|europe|european union|eu|emea|germany|france|spain|netherlands|brazil|latam|latin america|australia|new zealand|india|mexico|colombia|argentina|poland|portugal|ireland|italy|israel|turkey|nigeria|kenya|south africa)\b)/i;
const RESIDENCY_BLOCK = /(must (be )?(located|based|reside|live) in|must reside|right to work|work authori[sz]ation|authori[sz]ed to work|eligible to work in|us citizens?|security clearance|visa sponsorship (is )?not|no visa sponsorship|only (accept|consider)ing? (candidates|applicants) (from|in|located))/i;

const YEARS_RE = /(\d{1,2})\s*(?:\+|plus)?\s*(?:[-–]|to)?\s*(\d{1,2})?\s*\+?\s*(?:years?|yrs?|tahun)\b/gi;

const DEFAULTS = { maxYears: 2, minApply: 62, minMaybe: 42 };

const norm = (s) => String(s || '').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Python, C++, Next.js" -> ['python','c++','next.js'] */
export function parseSkills(raw) {
  return [...new Set(String(raw || '').split(/[,;\n|]/).map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2 && s.length <= 30))];
}

/** Whole-word match that also copes with C++, Node.js, .NET. */
function hasSkill(text, skill) {
  const e = esc(skill);
  return new RegExp(`(^|[^a-z0-9+#])${e}([^a-z0-9+#]|$)`, 'i').test(text);
}

/** Highest "N years" requirement that sits next to experience wording, or null. */
export function requiredYears(text) {
  const t = String(text || '');
  let best = null;
  let m;
  YEARS_RE.lastIndex = 0;
  while ((m = YEARS_RE.exec(t))) {
    const lo = Number(m[1]);
    if (!Number.isFinite(lo) || lo > 20) continue;
    const ctx = t.slice(Math.max(0, m.index - 70), m.index + m[0].length + 70);
    if (!/(experience|pengalaman|exp\b|background|professional|industry|working|hands-on)/i.test(ctx)) continue;
    // "founded 10 years ago", "over the past 5 years": about the company, not about the candidate.
    if (/(founded|in business|years? (ago|old)|over the (last|past)|for the (last|past)|since \d{4})/i.test(ctx)) continue;
    if (best == null || lo > best) best = lo;
  }
  return best;
}

/**
 * Can someone in Indonesia (UTC+7) actually take this job?  yes | maybe | no  + a reason.
 */
export function eligibility(job) {
  const regions = (job.regions || []).join(' ');
  const loc = `${job.location || ''} ${regions}`.trim();
  const desc = String(job.description || '').slice(0, 3000);
  const open = REGION_OK.test(loc);

  if (job.timezones?.length && !job.timezones.includes(7)) {
    return { value: 'no', reason: 'zona waktu yang diminta tidak mencakup WIB' };
  }
  if (job.remote === false) return { value: 'no', reason: 'bukan posisi remote' };
  if (open) {
    if (RESIDENCY_BLOCK.test(desc) && !/(worldwide|anywhere in the world|any country)/i.test(desc)) {
      return { value: 'maybe', reason: 'tertulis "remote/global" tetapi deskripsi menyebut syarat domisili/izin kerja' };
    }
    return { value: 'yes', reason: 'terbuka untuk worldwide / Asia' };
  }
  if (loc && REGION_BLOCK.test(loc)) return { value: 'no', reason: `dibatasi wilayah: ${loc.slice(0, 60)}` };
  if (RESIDENCY_BLOCK.test(desc)) return { value: 'no', reason: 'deskripsi mensyaratkan domisili/izin kerja negara tertentu' };
  if (!loc) return { value: 'maybe', reason: 'wilayah tidak disebutkan' };
  return { value: 'maybe', reason: `wilayah tidak jelas: ${loc.slice(0, 60)}` };
}

/**
 * @param {object} job   normalised job (see sources.js)
 * @param {{skills?: string[], maxYears?: number, minApply?: number, minMaybe?: number, now?: number}} profile
 * @returns {{score:number, verdict:'apply'|'maybe'|'skip', eligibility:string, reasons:string[], warnings:string[], yearsRequired:number|null, matchedSkills:string[]}}
 */
export function scoreJob(job, profile = {}) {
  const cfg = { ...DEFAULTS, ...profile };
  const skills = (profile.skills || []).map((s) => s.toLowerCase());
  const now = profile.now || Date.now();
  const title = String(job.title || '');
  const body = `${title}\n${(job.tags || []).join(' ')}\n${job.description || ''}`;
  const reasons = [];
  const warnings = [];

  // 1) Is it a software job at all?
  if (NOT_SOFTWARE.test(title) && !/(developer|engineer|programmer)/i.test(title)) {
    return { score: 0, verdict: 'skip', eligibility: 'n/a', reasons: ['bukan peran software'], warnings, yearsRequired: null, matchedSkills: [] };
  }
  let score = 0;
  let roleHit = null;
  for (const [re, pts, label] of ROLE_GOOD) {
    if (re.test(title)) { roleHit = label; score += pts; break; }
  }
  if (!roleHit) {
    // Tags only: a weak signal, not enough to apply blindly.
    if (/(developer|engineer|programmer|software)/i.test((job.tags || []).join(' '))) { score += 8; roleHit = 'tag developer'; }
    else return { score: 0, verdict: 'skip', eligibility: 'n/a', reasons: ['judul tidak menunjukkan peran software'], warnings, yearsRequired: null, matchedSkills: [] };
  }
  reasons.push(`peran: ${roleHit}`);

  // 2) Skills overlap with the owner's real stack.
  const matched = skills.filter((s) => hasSkill(body, s));
  const inTitle = skills.filter((s) => hasSkill(title, s));
  const skillPts = Math.min(36, matched.length * 6 + inTitle.length * 6);
  score += skillPts;
  if (matched.length) reasons.push(`keahlian cocok: ${matched.slice(0, 6).join(', ')}`);
  else warnings.push('tidak ada keahlian di profil yang disebut');

  // 3) Seniority and years of experience.
  const years = requiredYears(`${title}\n${job.description || ''}`);
  const seniorTitle = SENIOR_TITLE.test(title);
  const juniorTitle = JUNIOR_TITLE.test(title);
  const levelText = norm(job.seniority);
  if (juniorTitle || /junior|entry|intern|graduate/.test(levelText)) { score += 14; reasons.push('level junior / entry'); }
  if (seniorTitle || /senior|lead|principal|staff|expert|director/.test(levelText)) {
    score -= 45; warnings.push('level senior ke atas');
  } else if (/mid/.test(levelText) && !juniorTitle) { score -= 6; warnings.push('level mid: biasanya 3+ tahun'); }
  if (years != null) {
    if (years > cfg.maxYears + 1) { score -= 40; warnings.push(`butuh ${years}+ tahun pengalaman`); }
    else if (years > cfg.maxYears) { score -= 14; warnings.push(`butuh ${years} tahun (di atas ${cfg.maxYears})`); }
    else reasons.push(`syarat pengalaman ${years} tahun`);
  } else if (!seniorTitle) {
    warnings.push('syarat tahun pengalaman tidak disebut');
  }

  // 4) Can an Indonesian actually take it?
  const el = eligibility(job);
  if (el.value === 'yes') { score += 14; reasons.push(el.reason); }
  else if (el.value === 'maybe') { score -= 6; warnings.push(el.reason); }
  else { score -= 60; warnings.push(el.reason); }

  // 5) Freshness: a posting nobody has touched for weeks is a dead end.
  if (job.postedAt) {
    const days = (now - job.postedAt) / 86_400_000;
    if (days <= 3) { score += 6; reasons.push('baru diposting'); }
    else if (days > 30) { score -= 12; warnings.push(`sudah ${Math.round(days)} hari`); }
  }
  if (job.salaryMin || job.salaryText) reasons.push('gaji dicantumkan');

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict = 'skip';
  const tooSenior = seniorTitle || (years != null && years > cfg.maxYears + 1);
  if (el.value !== 'no' && !tooSenior) {
    if (score >= cfg.minApply && el.value === 'yes') verdict = 'apply';
    else if (score >= cfg.minMaybe) verdict = 'maybe';
  }
  // Applying blindly needs real evidence: with no stated years and fewer than two matching skills it stays "maybe".
  if (verdict === 'apply' && years == null && matched.length < 2) verdict = 'maybe';

  return { score, verdict, eligibility: el.value, reasons, warnings, yearsRequired: years, matchedSkills: matched };
}

export const SCORING_DEFAULTS = DEFAULTS;
