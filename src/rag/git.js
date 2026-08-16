import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function runGit(args, cwd = process.cwd()) {
  try {
    const result = execSync(`git ${args} 2>/dev/null`, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 30000 });
    return { success: true, output: result.trim() };
  } catch (error) {
    return { success: false, error: error.stderr?.trim() || error.message };
  }
}

function hasGitRepo(dir) {
  try {
    execSync('git rev-parse --git-dir 2>/dev/null', { cwd: dir, encoding: 'utf8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function hasCommits(dir) {
  try {
    execSync('git rev-parse --verify HEAD 2>/dev/null', { cwd: dir, encoding: 'utf8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export class GitAnalyzer {
  constructor(workspaceDir = process.cwd()) {
    this.workspaceDir = workspaceDir;
    this._isRepo = null;
  }

  isRepo() {
    if (this._isRepo !== null) return this._isRepo;
    const result = runGit('rev-parse --is-inside-work-tree', this.workspaceDir);
    this._isRepo = result.success;
    return this._isRepo;
  }

  getCurrentBranch() {
    const result = runGit('branch --show-current', this.workspaceDir);
    return result.success ? result.output : 'unknown';
  }

  getDiff(options = {}) {
    const base = options.base || 'HEAD';
    const staged = options.staged ? '--staged' : '';
    if (!hasCommits(this.workspaceDir)) return { success: true, branch: this.getCurrentBranch(), files: [], totalFiles: 0, diff: '', summary: '' };
    const result = runGit(`diff ${staged} ${base} --stat`, this.workspaceDir);
    if (!result.success) return { success: true, branch: this.getCurrentBranch(), files: [], totalFiles: 0, diff: '', summary: '' };

    const statLines = result.output.split('\n').filter(l => l.trim());
    const files = statLines.map(line => {
      const match = line.match(/^(.+?)\s+\|\s+(\d+)/);
      return match ? { file: match[1].trim(), changes: parseInt(match[2]) } : { file: line, changes: 0 };
    });

    const detail = runGit(`diff ${staged} ${base}`, this.workspaceDir);

    return {
      success: true,
      branch: this.getCurrentBranch(),
      files,
      totalFiles: files.length,
      diff: detail.success ? detail.output : '',
      summary: statLines.join('\n'),
    };
  }

  getLog(count = 10) {
    if (!hasCommits(this.workspaceDir)) return [];
    const result = runGit(`log --oneline -${count}`, this.workspaceDir);
    if (!result.success) return [];
    return result.output.split('\n').filter(l => l.trim()).map(line => {
      const match = line.match(/^(\w+)\s+(.+)/);
      return match ? { hash: match[1], message: match[2] } : { hash: '', message: line };
    });
  }

  getCommitDiff(hash) {
    const result = runGit(`diff ${hash}^..${hash} --stat`, this.workspaceDir);
    const detail = runGit(`diff ${hash}^..${hash}`, this.workspaceDir);
    if (!result.success) return { success: false, error: result.error };

    return {
      success: true,
      hash,
      message: runGit(`log --format=%s -1 ${hash}`, this.workspaceDir).output,
      author: runGit(`log --format=%an -1 ${hash}`, this.workspaceDir).output,
      date: runGit(`log --format=%ad -1 ${hash}`, this.workspaceDir).output,
      files: result.output.split('\n').filter(l => l.trim()),
      diff: detail.success ? detail.output : '',
    };
  }

  getBranchDiff(targetBranch = 'main') {
    const current = this.getCurrentBranch();
    if (current === targetBranch) {
      return { success: true, branch: current, message: 'Already on target branch', files: [], diff: '' };
    }

    if (!hasCommits(this.workspaceDir)) return { success: true, branch: current, message: 'No commits yet', files: [], diff: '' };

    const mergeBase = runGit(`merge-base ${current} ${targetBranch}`, this.workspaceDir);
    if (!mergeBase.success) {
      return { success: false, error: `Cannot find merge base: ${mergeBase.error}` };
    }

    const result = runGit(`diff ${mergeBase.output}..${current} --stat`, this.workspaceDir);
    const detail = runGit(`diff ${mergeBase.output}..${current}`, this.workspaceDir);

    const statLines = (result.success ? result.output : '').split('\n').filter(l => l.trim());
    const files = statLines.map(line => {
      const match = line.match(/^(.+?)\s+\|\s+(\d+)/);
      return match ? { file: match[1].trim(), changes: parseInt(match[2]) } : null;
    }).filter(Boolean);

    const insertions = detail.success ? (detail.output.match(/^\+/gm) || []).length : 0;
    const deletions = detail.success ? (detail.output.match(/^\-/gm) || []).length : 0;

    return {
      success: true,
      branch: current,
      targetBranch,
      files,
      totalFiles: files.length,
      insertions,
      deletions,
      totalChanges: insertions + deletions,
      diff: detail.success ? detail.output : '',
      summary: result.success ? result.output : '',
      mergeBase: mergeBase.output,
    };
  }

  getFileBlame(filePath) {
    const result = runGit(`blame --line-porcelain "${filePath}"`, this.workspaceDir);
    if (!result.success) return { success: false, error: result.error };

    const annotations = [];
    const lines = result.output.split('\n');
    let current = {};

    for (const line of lines) {
      if (line.startsWith('author ')) current.author = line.slice(7);
      else if (line.startsWith('author-time ')) current.date = new Date(parseInt(line.slice(12)) * 1000).toISOString();
      else if (line.startsWith('summary ')) current.summary = line.slice(8);
      else if (line.startsWith('\t')) {
        current.line = line.slice(1);
        annotations.push(current);
        current = {};
      }
    }

    return { success: true, annotations };
  }

  getChangedFilesSince(hash) {
    const result = runGit(`diff --name-only ${hash}..HEAD`, this.workspaceDir);
    if (!result.success) return [];
    return result.output.split('\n').filter(l => l.trim());
  }

  getRepoInfo() {
    if (!this.isRepo()) return { isRepo: false };
    const repoHasCommits = hasCommits(this.workspaceDir);

    return {
      isRepo: true,
      branch: this.getCurrentBranch(),
      remote: runGit('remote get-url origin', this.workspaceDir).output || 'none',
      lastCommit: repoHasCommits ? (this.getLog(1)[0] || null) : null,
      recentCommits: repoHasCommits ? this.getLog(5) : [],
      hasUncommitted: repoHasCommits ? this.getDiff({ base: 'HEAD' }).totalFiles > 0 : false,
      uncommittedFiles: repoHasCommits ? this.getDiff({ base: 'HEAD' }).files : [],
    };
  }
}

export default GitAnalyzer;
