/**
 * Wanar AI - Full-Stack Project Generator Engine
 * Generates complete runnable projects file-by-file using any configured AI provider.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';

const GEN_ROOT = path.join(process.cwd(), 'data', 'generated');
const MAX_FILES_HARD_CAP = 80;

const PLAN_SYSTEM = `You are Wanar CodeGen Planner, an expert software architect.
Given a project specification, output ONLY a JSON object (no markdown fences, no commentary):
{
  "name": "kebab-case-project-name",
  "summary": "one sentence",
  "stack": ["tech", "..."],
  "files": ["relative/path/file.ext", "..."]
}
Rules:
- Plan EVERY file needed for a COMPLETE, RUNNABLE full-stack application (config, backend, frontend UI, components, styles, README).
- Order files logically: config/package manifests first, entry points, then backend, then frontend components, then styles, README last.
- Include a README.md with exact local run instructions.
- Keep total file count reasonable (15-60 files typical).
- Paths must be relative, use forward slashes, never start with "/" or "..".`;

const FILE_SYSTEM = `You are Wanar CodeGen, an expert full-stack engineer.
You will be given a project spec, the file plan, files already written, and ONE target file path.
Output ONLY a JSON object (no markdown fences, no commentary):
{ "path": "<the target path exactly as given>", "content": "<full file content>" }
Rules:
- Write PRODUCTION-QUALITY, COMPLETE code. No placeholders like "// TODO" or "...".
- All UI must be fully interactive: buttons work, forms submit, navigation routes, state management functional.
- The project must run after: extract, install deps, run command from README.
- Escape all newlines and quotes properly inside the JSON "content" string.
- Match imports exactly to the planned file paths.`;

function safeJoin(root, relPath) {
  const clean = String(relPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(p => p && p !== '.' && p !== '..')
    .join('/');
  if (!clean) throw new Error('Invalid file path');
  return path.join(root, clean);
}

function extractJSON(text) {
  if (!text) throw new Error('Empty AI response');
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in AI response');
  return JSON.parse(t.slice(start, end + 1));
}

class WanarGenerator {
  constructor() {
    this.projects = new Map(); // id -> project state (with .emitter)
  }

  get(id) {
    return this.projects.get(id) || null;
  }

  list() {
    return [...this.projects.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ emitter, stopFlag, ...rest }) => rest);
  }

  stop(id) {
    const p = this.projects.get(id);
    if (!p) return false;
    if (p.status === 'running') {
      p.stopFlag = true;
      p.status = 'stopping';
      this._emit(p, { type: 'info', message: 'Stop requested...' });
    }
    return true;
  }

  remove(id) {
    const p = this.projects.get(id);
    if (!p) return false;
    if (p.status === 'running') this.stop(id);
    try { fs.rmSync(p.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    this.projects.delete(id);
    return true;
  }

  _emit(p, event) {
    p.lastEvent = event;
    p.emitter.emit('event', event);
  }

  readFile(p, relPath) {
    const abs = safeJoin(p.dir, relPath);
    if (!abs.startsWith(p.dir)) throw new Error('Invalid path');
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs, 'utf8');
  }

  async makeZip(p) {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(abs, rel);
        else zip.file(rel, fs.readFileSync(abs));
      }
    };
    walk(p.dir);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  /** Kick off a new generation. Returns project id immediately. */
  start(spec, ai) {
    const id = `gen_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(GEN_ROOT, id);
    fs.mkdirSync(dir, { recursive: true });

    const project = {
      id,
      dir,
      name: spec.projectName || 'generated-project',
      framework: spec.framework,
      appType: spec.appType,
      description: spec.description,
      provider: spec.provider || ai.getProvider(),
      model: spec.model || ai.getDefaultModel(),
      maxFiles: Math.min(Math.max(parseInt(spec.maxFiles, 10) || 40, 5), MAX_FILES_HARD_CAP),
      status: 'queued',
      phase: 'planning',
      plan: [],
      files: [],       // {path, size, ok}
      failed: [],
      createdAt: Date.now(),
      finishedAt: null,
      error: null,
      emitter: new EventEmitter(),
      stopFlag: false,
    };
    this.projects.set(id, project);
    this._run(project, ai).catch(err => {
      project.status = 'error';
      project.error = err.message;
      project.finishedAt = Date.now();
      this._emit(project, { type: 'error', message: err.message });
    });
    return id;
  }

  async _chat(ai, p, system, userPrompt) {
    const providerName = p.provider;
    const provider = ai.providers[providerName];
    if (!provider) throw new Error(`Provider "${providerName}" not available`);
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ];
    const res = await provider.chat(messages, {
      model: p.model,
      temperature: 0.3,
      maxTokens: 16384,
      timeout: 300000, // 5 menit per file — model reasoning besar butuh waktu
    });
    if (res && res.success === false) throw new Error(res.error || 'AI call failed');
    return typeof res === 'string' ? res : (res.content || '');
  }

  async _run(p, ai) {
    p.status = 'running';
    this._emit(p, { type: 'start', name: p.name, framework: p.framework });

    // ── Phase 1: Plan ──────────────────────────────────────────
    p.phase = 'planning';
    this._emit(p, { type: 'phase', phase: 'planning' });

    const specText = [
      `Project type: ${p.appType}`,
      `Framework/Stack: ${p.framework}`,
      `Description: ${p.description}`,
      p.extra ? `Extra requirements: ${p.extra}` : '',
      `Max files: ${p.maxFiles}`,
    ].filter(Boolean).join('\n');

    let planData = null;
    for (let attempt = 1; attempt <= 3 && !planData; attempt++) {
      try {
        const raw = await this._chat(ai, p, PLAN_SYSTEM, specText);
        planData = extractJSON(raw);
      } catch (e) {
        this._emit(p, { type: 'info', message: `Plan attempt ${attempt} failed: ${e.message}` });
        if (attempt === 3) throw new Error(`Planning failed: ${e.message}`);
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }

    const seen = new Set();
    p.plan = (planData.files || [])
      .map(f => String(f).replace(/\\/g, '/').replace(/^\/+/, ''))
      .filter(f => !f.includes('..') && !seen.has(f) && seen.add(f))
      .slice(0, p.maxFiles);
    if (!p.plan.length) throw new Error('AI produced an empty file plan');
    p.name = (planData.name || p.name).toLowerCase().replace(/[^a-z0-9-_]/g, '-').slice(0, 50);

    // Ensure README exists in plan
    if (!p.plan.some(f => /^readme\.md$/i.test(f))) p.plan.push('README.md');

    this._emit(p, {
      type: 'plan',
      name: p.name,
      summary: planData.summary || '',
      stack: planData.stack || [],
      total: p.plan.length,
      files: p.plan,
    });

    // ── Phase 2: Generate each file ────────────────────────────
    p.phase = 'generating';
    this._emit(p, { type: 'phase', phase: 'generating' });

    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    for (let i = 0; i < p.plan.length; i++) {
      if (p.stopFlag) break;
      const filePath = p.plan[i];
      this._emit(p, { type: 'file_start', path: filePath, index: i + 1, total: p.plan.length });

      const writtenList = p.files.filter(f => f.ok).map(f => `- ${f.path}`).join('\n') || '(none yet)';
      const userPrompt = [
        '## PROJECT SPECIFICATION',
        specText,
        '',
        '## FULL FILE PLAN (order matters)',
        p.plan.map((f, idx) => `${idx + 1}. ${f}`).join('\n'),
        '',
        '## FILES ALREADY WRITTEN (imports must match these paths)',
        writtenList,
        '',
        `## TASK`,
        `Write the complete content for file ${i + 1} of ${p.plan.length}: "${filePath}"`,
        'Respond with the JSON object only.',
      ].join('\n');

      let saved = false;
      for (let attempt = 1; attempt <= 3 && !saved && !p.stopFlag; attempt++) {
        try {
          const raw = await this._chat(ai, p, FILE_SYSTEM, userPrompt);
          const data = extractJSON(raw);
          const finalPath = (data.path && typeof data.path === 'string') ? data.path : filePath;
          const abs = safeJoin(p.dir, finalPath);
          if (!abs.startsWith(p.dir)) throw new Error('Unsafe path returned by AI');
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, String(data.content ?? ''), 'utf8');
          p.files.push({ path: finalPath.replace(/\\/g, '/'), size: Buffer.byteLength(String(data.content ?? '')), ok: true });
          consecutiveFailures = 0;
          this._emit(p, { type: 'file_done', path: finalPath, index: i + 1, total: p.plan.length, size: p.files[p.files.length - 1].size });
          saved = true;
        } catch (e) {
          // Deteksi error kuota/provider agar langsung abort (jangan buang kuota)
          const msg = String(e.message || '');
          if (/quota|401|402|403|429|payment|billing|suspended/i.test(msg)) {
            throw new Error(`Provider "${p.provider}" bermasalah: ${msg} — Ganti provider/model di form lalu jalankan ulang.`);
          }
          this._emit(p, { type: 'info', message: `"${filePath}" attempt ${attempt}/3 failed: ${msg}` });
          if (attempt < 3) await new Promise(r => setTimeout(r, 1200 * attempt));
        }
      }
      if (!saved && !p.stopFlag) {
        p.failed.push(filePath);
        consecutiveFailures++;
        this._emit(p, { type: 'file_failed', path: filePath });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          throw new Error(`${consecutiveFailures} file berturut-turut gagal — generation dihentikan untuk menghemat kuota. Cek provider/model lalu jalankan ulang.`);
        }
      }
    }

    p.phase = 'done-phase';
    p.finishedAt = Date.now();
    p.status = p.stopFlag ? 'stopped' : 'done';
    this._emit(p, {
      type: 'complete',
      status: p.status,
      filesDone: p.files.length,
      failed: p.failed.length ? p.failed : undefined,
      downloadUrl: `/api/generator/${p.id}/download`,
    });
  }
}

export const generator = new WanarGenerator();
export default generator;
