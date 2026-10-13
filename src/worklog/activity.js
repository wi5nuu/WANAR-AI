/**
 * src/worklog/activity.js
 *
 * "What did I actually touch today?" — evidence for the journal, collected
 * from three READ-ONLY sources:
 *
 *   1. Folders you register (project folders, an SSD/drive): files whose
 *      modification time falls on the day. Only metadata (name, size, mtime)
 *      is read — never file contents.
 *   2. Git repositories inside those folders: `git log` for the day.
 *   3. GitHub: your public (or, with GITHUB_TOKEN, private) event feed.
 *
 * Guard rails
 *   - Only folders the operator registered; system folders are refused.
 *   - Directory walks are capped by entries, depth and wall-clock time, and
 *     skip dependency/build/VCS folders, so registering "D:\" stays cheap.
 *   - git runs via execFile with an argument array (no shell), with
 *     core.fsmonitor disabled so a hostile repo cannot run code on log.
 *   - The GitHub token lives only in .env and is never returned.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { dayBounds } from './time.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.turbo',
  'vendor', '__pycache__', '.venv', 'venv', 'env', '.idea', '.vscode', 'target', 'bin', 'obj',
  'coverage', '.pytest_cache', '.gradle', 'Pods', '$RECYCLE.BIN', 'System Volume Information',
  'AppData', '.npm', '.yarn', '.pnpm-store',
]);

const BLOCKED_ROOTS = [
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i,
  /^[a-z]:\\\$recycle\.bin(\\|$)/i,
  /^[a-z]:\\system volume information(\\|$)/i,
  /^\/(etc|proc|sys|dev|boot|bin|sbin|usr|var|lib|lib64|run)(\/|$)/,
];

export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceError';
  }
}

/** Validates a folder the operator wants to connect. Returns the normalised path. */
export function validateFolder(raw) {
  const input = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!input) throw new SourceError('Path folder kosong');
  if (input.includes('\0')) throw new SourceError('Path tidak valid');
  if (!path.isAbsolute(input)) throw new SourceError('Gunakan path lengkap, mis. D:\\Proyek atau /home/anda/proyek');
  const full = path.resolve(input);
  if (BLOCKED_ROOTS.some((re) => re.test(full))) throw new SourceError('Folder sistem tidak boleh dihubungkan');
  let st;
  try { st = fs.statSync(full); } catch { throw new SourceError(`Folder tidak ditemukan: ${full}`); }
  if (!st.isDirectory()) throw new SourceError('Path bukan folder');
  return full;
}

/** Walks a folder and counts files modified within [from, to). */
export function scanFolder(root, from, to, { maxEntries = 40_000, maxDepth = 7, budgetMs = 4000 } = {}) {
  const started = Date.now();
  const top = [];
  const byExt = {};
  let changed = 0;
  let seen = 0;
  let truncated = false;
  const stack = [[root, 0]];

  while (stack.length) {
    if (seen >= maxEntries || Date.now() - started > budgetMs) { truncated = true; break; }
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      if (e.isSymbolicLink()) continue; // never follow links out of the registered tree
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push([p, depth + 1]);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs >= from && st.mtimeMs < to) {
        changed++;
        const ext = path.extname(e.name).slice(1).toLowerCase() || '(tanpa)';
        byExt[ext] = (byExt[ext] || 0) + 1;
        top.push({ file: path.relative(root, p), mtime: st.mtimeMs, size: st.size });
      }
    }
  }

  top.sort((a, b) => b.mtime - a.mtime);
  return {
    filesChanged: changed,
    scanned: seen,
    truncated,
    byExt: Object.fromEntries(Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 8)),
    recent: top.slice(0, 15),
    ms: Date.now() - started,
  };
}

/** Git repositories at the folder itself and up to two levels below. */
export function findRepos(root, { maxRepos = 30 } = {}) {
  const repos = [];
  const visit = (dir, depth) => {
    if (repos.length >= maxRepos) return;
    if (fs.existsSync(path.join(dir, '.git'))) { repos.push(dir); return; }
    if (depth >= 2) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        visit(path.join(dir, e.name), depth + 1);
      }
    }
  };
  visit(root, 0);
  return repos;
}

function runGit(execFileImpl, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFileImpl('git', args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? { ok: false, error: err.message } : { ok: true, stdout: String(stdout || '') });
    });
  });
}

/** Commits in a repo for the day, optionally filtered by author (name or email). */
export async function repoCommits(repo, from, to, { author = '', execFileImpl = execFile } = {}) {
  const args = [
    '-c', 'core.fsmonitor=false', '-C', repo, 'log', '--all', '--no-merges',
    `--since=${new Date(from).toISOString()}`, `--until=${new Date(to - 1).toISOString()}`,
    '--pretty=format:%H%x1f%an%x1f%ae%x1f%ct%x1f%s',
  ];
  const r = await runGit(execFileImpl, args);
  if (!r.ok) return { repo, commits: 0, messages: [], error: r.error.split('\n')[0].slice(0, 160) };
  const wanted = author.trim().toLowerCase();
  const rows = r.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, name, email, ct, subject] = l.split('\x1f');
    return { hash: hash?.slice(0, 8), name, email, at: Number(ct) * 1000, subject: (subject || '').slice(0, 140) };
  }).filter((c) => c.at >= from && c.at < to)
    .filter((c) => !wanted || c.name?.toLowerCase().includes(wanted) || c.email?.toLowerCase().includes(wanted));
  return { repo, commits: rows.length, messages: rows.slice(0, 15) };
}

const GH_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** GitHub activity for the day from the user's event feed. */
export async function githubActivity(username, from, to, { token = '', repos = [], fetchImpl = globalThis.fetch } = {}) {
  if (!GH_USER.test(String(username || ''))) return { username, error: 'Username GitHub tidak valid' };
  const out = { username, commits: 0, pushes: 0, prs: 0, reviews: 0, issues: 0, repos: {}, events: [], error: null };
  const wantRepos = new Set((repos || []).map((r) => String(r).toLowerCase()));
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'wanar-ai-worklog',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  for (let page = 1; page <= 3; page++) {
    let res;
    try {
      res = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(username)}/events?per_page=100&page=${page}`, {
        headers, signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      out.error = `Gagal menghubungi GitHub: ${e.message}`;
      break;
    }
    if (res.status === 404) { out.error = 'User GitHub tidak ditemukan'; break; }
    if (res.status === 401) { out.error = 'GITHUB_TOKEN ditolak'; break; }
    if (res.status === 403 || res.status === 429) { out.error = 'Batas API GitHub tercapai — isi GITHUB_TOKEN untuk batas lebih tinggi'; break; }
    if (!res.ok) { out.error = `GitHub HTTP ${res.status}`; break; }

    const events = await res.json();
    if (!Array.isArray(events) || !events.length) break;
    let older = false;
    for (const ev of events) {
      const at = Date.parse(ev.created_at);
      if (at < from) { older = true; continue; }
      if (at >= to) continue;
      const repo = ev.repo?.name || '';
      if (wantRepos.size && !wantRepos.has(repo.toLowerCase())) continue;
      out.repos[repo] = (out.repos[repo] || 0) + 1;
      let summary = ev.type.replace(/Event$/, '');
      if (ev.type === 'PushEvent') {
        const n = ev.payload?.distinct_size ?? ev.payload?.size ?? ev.payload?.commits?.length ?? 0;
        out.commits += n;
        out.pushes++;
        summary = `push ${n} commit`;
      } else if (ev.type === 'PullRequestEvent') {
        out.prs++;
        summary = `PR ${ev.payload?.action || ''} #${ev.payload?.number ?? ''}`.trim();
      } else if (ev.type === 'PullRequestReviewEvent') {
        out.reviews++;
      } else if (ev.type === 'IssuesEvent') {
        out.issues++;
        summary = `issue ${ev.payload?.action || ''}`.trim();
      }
      if (out.events.length < 20) out.events.push({ at, repo, type: ev.type, summary });
    }
    if (older || events.length < 100) break;
  }
  return out;
}

/**
 * Collects everything for one local date.
 * @param {string} date
 * @param {object} settings  worklog settings (sources)
 */
export async function collectActivity(date, settings, { env = process.env, fetchImpl = globalThis.fetch, execFileImpl = execFile } = {}) {
  const [from, to] = dayBounds(date);
  const result = { date, filesChanged: 0, folders: [], localCommits: 0, repos: [], github: null, errors: [] };
  const folders = settings.sources?.folders || [];

  for (const f of folders) {
    let full;
    try { full = validateFolder(f.path); } catch (e) { result.errors.push(`${f.path}: ${e.message}`); continue; }
    const scan = scanFolder(full, from, to);
    result.filesChanged += scan.filesChanged;
    result.folders.push({ path: full, label: f.label || path.basename(full) || full, ...scan });

    for (const repo of findRepos(full)) {
      if (result.repos.some((r) => r.repo === repo)) continue;
      const c = await repoCommits(repo, from, to, { author: settings.sources?.gitAuthor || '', execFileImpl });
      if (c.error && !/not a git repository/i.test(c.error)) result.errors.push(`${path.basename(repo)}: ${c.error}`);
      if (c.commits) result.repos.push({ ...c, name: path.basename(repo) });
      result.localCommits += c.commits;
    }
  }

  const gh = settings.sources?.github;
  if (gh?.username) {
    result.github = await githubActivity(gh.username, from, to, {
      token: env.GITHUB_TOKEN || '', repos: gh.repos, fetchImpl,
    });
    if (result.github.error) result.errors.push(`GitHub: ${result.github.error}`);
  }
  return result;
}
