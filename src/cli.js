#!/usr/bin/env node
/**
 * Wanar AI CLI v1.0.1
 * by Wisnu Alfian Nur Ashar & Siti Nurfadhila Az Zahra Syam
 */
import readline from 'readline';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import AIManager from './ai-manager.js';
import config from '../config/config.js';
import * as db from './database.js';

// ── Terminal Styles ──────────────────────────────────────────────
const re = '\x1b[31m', gr = '\x1b[32m', yl = '\x1b[33m';
const bl = '\x1b[34m', mg = '\x1b[35m', cy = '\x1b[36m';
const gy = '\x1b[90m', rs = '\x1b[0m', bd = '\x1b[1m', dim = '\x1b[2m';
const c256 = (n) => `\x1b[38;5;${n}m`;
const barBlue = c256(39);
const bgSoft = '\x1b[48;5;236m';
const bgReset = '\x1b[49m';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const COMMANDS = [
  { cmd: '/help',      desc: 'tampilkan semua perintah' },
  { cmd: '/model',     desc: 'lihat & ganti model AI' },
  { cmd: '/provider',  desc: 'lihat & ganti provider' },
  { cmd: '/clear',     desc: 'hapus history percakapan' },
  { cmd: '/info',      desc: 'info sistem & token usage' },
  { cmd: '/context',   desc: 'atur max context turns' },
  { cmd: '/sessions',  desc: 'lihat sesi tersimpan' },
  { cmd: '/session',   desc: 'load sesi sebelumnya' },
  { cmd: '/exit',      desc: 'keluar dari CLI' },
];

function visLen(s) {
  if (!s) return 0;
  return s.replace(/\x1b\[[\d;]*m/g, '').length;
}

function tw() {
  return Math.min(Math.max(process.stdout.columns || 80, 50), 100);
}

function wrapText(text, max) {
  if (!text) return [''];
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const wd of words) {
    if (visLen(cur) + wd.length + 1 > max) {
      if (cur) lines.push(cur);
      cur = wd;
    } else {
      cur = cur ? `${cur} ${wd}` : wd;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function fmtTime() {
  return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Markdown Stripper untuk terminal output ──────────────────────
// Convert markdown ke plain text yang rapi di terminal
function stripMarkdown(text) {
  return text
    // Hapus emoji unicode (range umum)
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    // Bold/italic: **text** atau *text* atau __text__ atau _text_
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/___(.+?)___/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    // Inline code: `code`
    .replace(/`([^`]+)`/g, '$1')
    // Code block: ```lang\n...\n```
    .replace(/```[\w]*\n([\s\S]*?)```/g, '$1')
    // Headers: # H1, ## H2, dst
    .replace(/^#{1,6}\s+/gm, '')
    // Horizontal rule
    .replace(/^[-*_]{3,}$/gm, '─'.repeat(40))
    // Bullet points: - item atau * item → •
    .replace(/^[\s]*[-*+]\s+/gm, '  • ')
    // Numbered list: 1. item → tetap
    .replace(/^[\s]*(\d+)\.\s+/gm, '  $1. ')
    // Blockquote: > text
    .replace(/^>\s+/gm, '  │ ')
    // Hapus trailing whitespace
    .replace(/[ \t]+$/gm, '')
    // Trim leading/trailing blank lines berlebihan
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Interactive Arrow-Key Menu dengan Search ─────────────────────
// items: [{ label, desc, value, isSep }]
// Ketik huruf untuk filter real-time, ↑↓ navigasi, Enter pilih, Esc batal
function interactiveMenu(rl, title, items, currentValue = null) {
  return new Promise((resolve) => {
    if (!items.length) { resolve(null); return; }

    const MAX_VISIBLE = 12;
    let searchQuery = '';
    let filteredItems = items.slice();
    let selected = filteredItems.findIndex(i => !i.isSep && i.value === currentValue);
    if (selected < 0) selected = filteredItems.findIndex(i => !i.isSep);
    if (selected < 0) selected = 0;
    let scrollOffset = 0;

    rl.pause();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function applyFilter(query) {
      if (!query) {
        filteredItems = items.slice();
      } else {
        const q = query.toLowerCase();
        const matchedValues = new Set(
          items.filter(i => !i.isSep && i.label.toLowerCase().includes(q)).map(i => i.value)
        );
        const result = [];
        for (let i = 0; i < items.length; i++) {
          if (items[i].isSep) {
            let hasChild = false;
            for (let j = i + 1; j < items.length && !items[j].isSep; j++) {
              if (matchedValues.has(items[j].value)) { hasChild = true; break; }
            }
            if (hasChild) result.push(items[i]);
          } else if (matchedValues.has(items[i].value)) {
            result.push(items[i]);
          }
        }
        filteredItems = result;
      }
      selected = filteredItems.findIndex(i => !i.isSep);
      if (selected < 0) selected = 0;
      scrollOffset = 0;
    }

    function clampScroll() {
      const vis = Math.min(MAX_VISIBLE, filteredItems.length);
      if (selected < scrollOffset) scrollOffset = selected;
      if (selected >= scrollOffset + vis) scrollOffset = selected - vis + 1;
      if (scrollOffset < 0) scrollOffset = 0;
    }

    function render() {
      if (render._lines > 0) process.stdout.write(`\x1b[${render._lines}A\x1b[0J`);
      const lines = [];
      const total = items.filter(i => !i.isSep).length;
      const shown = filteredItems.filter(i => !i.isSep).length;
      const countStr = searchQuery ? `${shown}/${total}` : `${total}`;
      lines.push(`  ${gy}┌─ ${bd}${title}${rs}  ${gy}${countStr}${rs}`);
      // Search bar
      if (searchQuery) {
        lines.push(`  ${gy}│${rs} ${yl}❯${rs} ${cy}${searchQuery}${gr}█${rs}`);
      } else {
        lines.push(`  ${gy}│${rs} ${dim}ketik untuk cari...${rs}`);
      }
      lines.push(`  ${gy}│${rs}`);

      if (filteredItems.length === 0) {
        lines.push(`  ${gy}│  ${re}tidak ada hasil untuk "${searchQuery}"${rs}`);
      } else {
        const vis = Math.min(MAX_VISIBLE, filteredItems.length);
        filteredItems.slice(scrollOffset, scrollOffset + vis).forEach((item, vi) => {
          const idx = vi + scrollOffset;
          if (item.isSep) {
            lines.push(`  ${gy}│  ── ${item.label}${rs}`);
            return;
          }
          const isSelected = idx === selected;
          const isCurrent = item.value === currentValue;
          const cursor = isSelected ? `${gr}▶${rs}` : ` `;
          const activeMark = isCurrent ? ` ${yl}✦${rs}` : '';
          const labelColor = isSelected ? `${bd}${gr}` : cy;
          // Highlight match
          let labelStr = item.label;
          if (searchQuery) {
            const qi = item.label.toLowerCase().indexOf(searchQuery.toLowerCase());
            if (qi >= 0) {
              const pre = item.label.slice(0, qi);
              const match = item.label.slice(qi, qi + searchQuery.length);
              const post = item.label.slice(qi + searchQuery.length);
              labelStr = `${pre}${yl}${match}${rs}${isSelected ? `${bd}${gr}` : cy}${post}`;
            }
          }
          const desc = item.desc ? ` ${gy}${item.desc.slice(0, 26)}${rs}` : '';
          lines.push(`  ${gy}│${rs} ${cursor} ${labelColor}${labelStr}${rs}${activeMark}${desc}`);
        });
        if (filteredItems.length > MAX_VISIBLE) {
          const pct = Math.round((scrollOffset / Math.max(1, filteredItems.length - MAX_VISIBLE)) * 100);
          lines.push(`  ${gy}│  ${dim}${scrollOffset + 1}-${Math.min(scrollOffset + MAX_VISIBLE, filteredItems.length)}/${filteredItems.length}  ${pct}%${rs}`);
        }
      }
      lines.push(`  ${gy}└─ ${dim}↑↓ navigasi  Enter pilih  Esc batal  Backspace hapus${rs}`);
      process.stdout.write(lines.join('\n') + '\n');
      render._lines = lines.length;
    }
    render._lines = 0;

    function cleanup(result) {
      process.stdin.setRawMode(false);
      process.stdin.removeListener('data', onKey);
      if (render._lines > 0) process.stdout.write(`\x1b[${render._lines}A\x1b[0J`);
      rl.resume();
      resolve(result);
    }

    function nextSelectable(from, dir) {
      const len = filteredItems.length;
      let i = from;
      for (let s = 0; s < len; s++) {
        i = (i + dir + len) % len;
        if (!filteredItems[i]?.isSep) return i;
      }
      return from;
    }

    function onKey(key) {
      if (key === '\x1b[A') {                              // Up
        selected = nextSelectable(selected, -1);
        clampScroll(); render();
      } else if (key === '\x1b[B') {                       // Down
        selected = nextSelectable(selected, 1);
        clampScroll(); render();
      } else if (key === '\r' || key === '\n') {           // Enter
        const item = filteredItems[selected];
        if (item && !item.isSep) cleanup(item.value);
      } else if (key === '\x1b') {                         // Esc
        cleanup(null);
      } else if (key === '\x7f' || key === '\b') {         // Backspace
        if (searchQuery.length > 0) {
          searchQuery = searchQuery.slice(0, -1);
          applyFilter(searchQuery);
          render();
        } else {
          cleanup(null);
        }
      } else if (key === '\x03') {                         // Ctrl+C
        cleanup(null);
        process.exit(0);
      } else if (key.length === 1 && key >= ' ') {         // Printable — search
        searchQuery += key;
        applyFilter(searchQuery);
        render();
      }
    }

    process.stdin.on('data', onKey);
    console.log();
    applyFilter('');
    render();
  });
}
// completer statis hanya dipakai sebelum instance CLI dibuat
// Instance CLI akan override ini dengan _completer() method yang dinamis
function completer(line) {
  const cmdList = COMMANDS.map(c => c.cmd);
  if (!line || line === '/') return [cmdList, line];
  const hits = cmdList.filter(c => c.startsWith(line.toLowerCase()));
  return [hits.length ? hits : cmdList, line];
}

// ── Logo (clean, compact, fast) ─────────────────────────────────
const LOGO = [
  ``,
  `  ${c256(39)}█${rs}${c256(33)}█${rs}${c256(45)}█${rs}  ${c256(39)}█${rs}${c256(33)}█${rs}${c256(45)}█${rs}  ${c256(39)}█${rs}${c256(33)}█${rs}${c256(45)}█${rs}  ${c256(39)}█${rs}${c256(33)}█${rs}  ${c256(39)}█${rs}${c256(33)}█${rs}  ${c256(45)}█${rs}${c256(39)}█${rs}${c256(33)}█${rs}${c256(45)}█${rs}  ${c256(33)}█${rs}${c256(39)}█${rs}`,
  `  ${c256(39)}█${rs}${gy}▀${rs}${c256(39)}█${rs}  ${c256(39)}█${rs}  ${gy}▀${rs}  ${c256(39)}█${rs}${gy}▀${rs}${c256(39)}█${rs}  ${c256(39)}█${rs}${gy}▀${rs}${c256(39)}█${rs}  ${c256(39)}█${rs}  ${c256(39)}█${rs}  ${gy}▀${rs}  ${c256(39)}█${rs}${gy}▀${rs}${c256(39)}█${rs}  ${c256(33)}█${rs}`,
  `  ${c256(45)}▀${rs}${c256(39)}▀${rs}${c256(33)}▀${rs}  ${c256(45)}▀${rs}     ${c256(45)}▀${rs}${c256(39)}▀${rs}${c256(33)}▀${rs}  ${c256(45)}▀${rs}  ${c256(39)}▀${rs}  ${c256(45)}▀${rs}${c256(39)}▀${rs}${c256(33)}▀${rs}     ${c256(45)}▀${rs}${c256(39)}▀${rs}${c256(33)}▀${rs}  ${c256(33)}▀${rs}`,
  ``,
];

// ASCII art full block WANAR AI
const LOGO_LINES = [
  ``,
  `  ${c256(39)}██╗    ██╗ █████╗ ███╗   ██╗ █████╗ ██████╗      █████╗ ██╗${rs}`,
  `  ${c256(39)}██║    ██║██╔══██╗████╗  ██║██╔══██╗██╔══██╗    ██╔══██╗██║${rs}`,
  `  ${c256(45)}██║ █╗ ██║███████║██╔██╗ ██║███████║██████╔╝    ███████║██║${rs}`,
  `  ${c256(33)}██║███╗██║██╔══██║██║╚██╗██║██╔══██║██╔══██╗    ██╔══██║██║${rs}`,
  `  ${c256(39)}╚███╔███╔╝██║  ██║██║ ╚████║██║  ██║██║  ██║    ██║  ██║██║${rs}`,
  `  ${c256(39)} ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═╝    ╚═╝  ╚═╝╚═╝${rs}`,
  ``,
  `  ${dim}by Wisnu Alfian Nur Ashar & Siti Nurfadhila Az Zahra Syam${rs}`,
  `  ${gy}Professional Multi-Provider AI Agent  ${c256(39)}v1.0.1${rs}`,
  ``,
];

// ── Status Bar Helpers ───────────────────────────────────────────
function formatProviderStatus(aiManager) {
  const providers = aiManager.getAvailableProviders();
  const current = aiManager.getProvider();
  const keyCount = providers.length;
  return providers.map(p => p === current ? `${gr}●${rs} ${p}` : `${gy}○${rs} ${p}`).join('  ');
}

// ── Main CLI Class ───────────────────────────────────────────────
class WanarCLI {
  constructor() {
    this.aiManager = new AIManager();
    // Set default model dari provider aktif (OpenAgentic default: claude-sonnet-4-5)
    this.currentModel = this.aiManager.getDefaultModel();
    this.sessionId = `ses_${crypto.randomBytes(8).toString('hex')}`;
    this.sessionName = 'New Chat';
    // Gunakan bound completer agar punya akses ke model & provider list secara dinamis
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '',
      completer: this._completer.bind(this),
    });
  }

  // ── Smart Autocomplete ──────────────────────────────────────────
  _completer(line) {
    const cmdList = COMMANDS.map(c => c.cmd);

    // Belum ketik apa-apa atau baru ketik '/' — tampilkan semua command + deskripsi
    if (!line || line === '/') {
      return [cmdList, line];
    }

    // Masih di bagian command (belum ada spasi) — filter by prefix
    if (!line.includes(' ')) {
      const hits = cmdList.filter(c => c.startsWith(line.toLowerCase()));
      return [hits.length ? hits : cmdList, line];
    }

    // Sudah ada spasi — kita di bagian argumen, tawarkan subcommand suggestions
    const parts = line.split(' ');
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    if (cmd === '/model') {
      // Tawarkan daftar model dari provider aktif
      const models = this.aiManager.getAvailableModels().map(m => m.id || m);
      const hits = models.filter(m => m.startsWith(arg));
      const suggestions = (hits.length ? hits : models).map(m => `${cmd} ${m}`);
      return [suggestions, line];
    }

    if (cmd === '/provider') {
      // Tawarkan daftar provider yang tersedia
      const providers = this.aiManager.getAvailableProviders();
      const hits = providers.filter(p => p.startsWith(arg));
      const suggestions = (hits.length ? hits : providers).map(p => `${cmd} ${p}`);
      return [suggestions, line];
    }

    if (cmd === '/session') {
      // Tawarkan nomor sesi 1-5
      const nums = ['1', '2', '3', '4', '5'];
      const hits = nums.filter(n => n.startsWith(arg));
      const suggestions = (hits.length ? hits : nums).map(n => `${cmd} ${n}`);
      return [suggestions, line];
    }

    if (cmd === '/context') {
      // Tawarkan beberapa nilai umum untuk max turns
      const vals = ['10', '20', '30', '50', '100'];
      const hits = vals.filter(v => v.startsWith(arg));
      const suggestions = (hits.length ? hits : vals).map(v => `${cmd} ${v}`);
      return [suggestions, line];
    }

    return [[], line];
  }

  _saveSession() {
    // Format ID readable: ses_ + timestamp base36 + random suffix
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    this.sessionId = `ses_${ts}${rand}`;
    const hist = this.aiManager.contextManager.history;
    const title = hist.length > 0 ? hist[0].content.slice(0, 60) : this.sessionName;
    db.createSession(this.sessionId, title, this.aiManager.getProvider(), this.currentModel || '');
    db.deleteMessages(this.sessionId);
    for (const m of hist) {
      db.addMessage(this.sessionId, m.role, m.content, 0, this.aiManager.getProvider(), this.currentModel || '');
    }
  }

  _loadSession(sessionId) {
    const msgs = db.getMessages(sessionId);
    this.aiManager.clearContext();
    for (const m of msgs) {
      if (m.role === 'system') { this.aiManager.setSystemPrompt(m.content); continue; }
      this.aiManager.contextManager.addTurn(m.role, m.content);
    }
    this.sessionId = sessionId;
    const sessions = db.getSessions(1);
    const s = sessions.find(x => x.id === sessionId);
    this.sessionName = s ? s.title : 'Loaded Chat';
  }

  // ── Start ──────────────────────────────────────────────────────
  async start(resumeSessionId = null) {
    // Display logo
    for (const line of LOGO_LINES) {
      console.log(line);
      await sleep(25);
    }
    console.log();

    // Resume session dari argumen -s <id>
    if (resumeSessionId) {
      const sessions = db.getSessions(50);
      const target = sessions.find(s => s.id === resumeSessionId);
      if (target) {
        this._loadSession(resumeSessionId);
        const msgs = this.aiManager.contextManager.getHistoryLength();
        console.log(`  ${gy}│${rs} ${gr}●${rs} ${bd}${target.title.slice(0, 50)}${rs}`);
        console.log(`  ${gy}│${rs}  ${dim}${msgs} pesan  ${target.provider}  ${target.updated_at?.slice(0, 16) || ''}${rs}`);
        console.log(`  ${gy}│${rs}`);
      } else {
        console.log(`  ${gy}│${rs} ${re}Session tidak ditemukan:${rs} ${resumeSessionId}`);
        console.log(`  ${gy}│${rs}`);
      }
    } else {
      // Auto-resume session terakhir seamless
      const sessions = db.getSessions(1);
      if (sessions.length > 0) {
        const last = sessions[0];
        this._loadSession(last.id);
        const msgs = this.aiManager.contextManager.getHistoryLength();
        const updatedAt = last.updated_at?.slice(0, 16) || '';
        console.log(`  ${gy}│${rs} ${gr}●${rs} ${bd}${last.title.slice(0, 50)}${rs}`);
        console.log(`  ${gy}│${rs}  ${dim}${msgs} pesan  ${last.provider}  ${updatedAt}${rs}`);
        console.log(`  ${gy}│${rs}  ${dim}wanarai --new  untuk mulai sesi baru${rs}`);
        console.log(`  ${gy}│${rs}`);
      }
    }

    this._printStatusBar();
    console.log(`  ${dim}/help untuk perintah  ·  Ctrl+C untuk keluar${rs}\n`);
    this.promptUser();
  }

  _printStatusBar() {
    const provider = this.aiManager.getProvider();
    const model = this.currentModel || '-';
    const histLen = this.aiManager.contextManager.getHistoryLength();
    const estTokens = this.aiManager.contextManager.getEstimatedTokens();
    const right = `${estTokens} tok  ${histLen} msgs  ${provider}/${model}`;
    const left = `Wanar AI v2.0`;
    console.log(`  ${gy}│${rs} ${bl}WANAR${rs} ${gy}·${rs} ${cy}${model}${rs} ${' '.repeat(Math.max(2, tw() - visLen(left) - visLen(right) - 10))}${gy}${right}${rs}`);
  }

  promptUser() {
    const prefix = `${barBlue}│${rs} ${gr}❯${rs} `;
    this.rl.question(`\n${prefix}`, async (input) => {
      const t = input.trim();
      if (!t) { this.promptUser(); return; }
      if (t.startsWith('/')) { await this.handleCommand(t); }
      else { await this.handleChat(t); }
    });
  }

  // ── Commands ───────────────────────────────────────────────────
  async handleCommand(cmd) {
    const parts = cmd.split(' ');
    const c = parts[0].toLowerCase();

    switch (c) {
      case '/help':
        console.log(`\n  ${bd}Commands${rs}`);
        console.log(`  ${gy}/provider <name>${rs}   switch provider`);
        console.log(`  ${gy}/model${rs}             list & select model`);
        console.log(`  ${gy}/context [N]${rs}        show/set max conversation turns`);
        console.log(`  ${gy}/sessions${rs}           list saved sessions`);
        console.log(`  ${gy}/session <N>${rs}        load a session`);
        console.log(`  ${gy}/clear${rs}              clear conversation`);
        console.log(`  ${gy}/info${rs}               system details`);
        console.log(`  ${gy}/exit${rs}               exit`);
        console.log(`  ${dim}Tip: Tab for autocomplete${rs}`);
        break;

      case '/provider': {
        if (parts[1]) {
          // Langsung set jika ada argumen
          try {
            this.aiManager.setProvider(parts[1]);
            this.currentModel = this.aiManager.getDefaultModel();
            console.log(`\n  ${gr}✓${rs} Provider: ${cy}${parts[1]}${rs}  model: ${cy}${this.currentModel || '-'}${rs}`);
          } catch (e) {
            console.log(`\n  ${re}✗${rs} ${e.message}`);
          }
        } else {
          // Tampilkan interactive menu
          const current = this.aiManager.getProvider();
          const configured = this.aiManager.getConfiguredProviders();
          const all = this.aiManager.getAvailableProviders();
          const items = all.map(p => ({
            label: p,
            desc: configured.includes(p) ? 'configured ✓' : 'no API key',
            value: p,
          }));
          const chosen = await interactiveMenu(this.rl, `Pilih Provider`, items, current);
          if (chosen && chosen !== current) {
            try {
              this.aiManager.setProvider(chosen);
              this.currentModel = this.aiManager.getDefaultModel();
              console.log(`  ${gr}✓${rs} Provider: ${cy}${chosen}${rs}  model: ${cy}${this.currentModel || '-'}${rs}`);
            } catch (e) {
              console.log(`  ${re}✗${rs} ${e.message}`);
            }
          } else if (!chosen) {
            console.log(`  ${gy}Dibatalkan${rs}`);
          }
        }
        break;
      }

      case '/model': {
        const models = this.aiManager.getAvailableModels();
        if (models.length === 0) {
          console.log(`\n  ${gy}Tidak ada model tersedia untuk provider ini.${rs}`);
          break;
        }

        if (parts[1]) {
          // Langsung set jika ada argumen (nomor atau id)
          const allIds = models.map(m => m.id || m);
          let chosen = null;
          const idx = parseInt(parts[1]);
          if (!isNaN(idx) && idx >= 1 && idx <= allIds.length) {
            chosen = allIds[idx - 1];
          } else if (allIds.includes(parts[1])) {
            chosen = parts[1];
          }
          if (chosen) {
            this.currentModel = chosen;
            console.log(`\n  ${gr}✓${rs} Model aktif: ${cy}${chosen}${rs}`);
          } else {
            console.log(`\n  ${re}✗${rs} Model tidak ditemukan: ${parts[1]}`);
          }
        } else {
          // Ambil model yang pernah dipakai dari history sessions
          const recentSessions = db.getSessions(20);
          const usedModelMap = new Map(); // model -> last used timestamp
          for (const s of recentSessions) {
            if (s.model && !usedModelMap.has(s.model)) {
              usedModelMap.set(s.model, s.updated_at || s.created_at);
            }
          }
          // Sort by most recent
          const recentModels = [...usedModelMap.entries()]
            .sort((a, b) => (b[1] > a[1] ? 1 : -1))
            .map(([id]) => id)
            .filter(id => id !== this.currentModel)
            .slice(0, 3); // max 3 last used

          const allIds = models.map(m => m.id || m);
          const currentModel = this.currentModel;

          // Helper buat item dari model id
          const makeItem = (id, prefix = '') => {
            const m = models.find(x => (x.id || x) === id);
            const family = m?.family || '';
            const tags = m?.tags?.length ? m.tags.slice(0, 2).join(' · ') : '';
            const rec = m?.rec ? '★ ' : '';
            const desc = prefix || [rec + family, tags].filter(Boolean).join('  ');
            return { label: id, desc, value: id };
          };

          const items = [];

          // ── Separator helper ─────────────────────────────────────
          const sep = (label) => ({ label: `── ${label} `, desc: '', value: `__sep__${label}`, isSep: true });

          // 1. Last Used
          if (recentModels.length > 0) {
            items.push(sep('Last Used'));
            for (const id of recentModels) {
              if (allIds.includes(id)) items.push(makeItem(id, 'recent'));
            }
          }

          // 2. Current
          if (currentModel && allIds.includes(currentModel)) {
            items.push(sep('Current'));
            items.push(makeItem(currentModel, 'aktif sekarang'));
          }

          // 3. Recommended / New
          const recModels = models.filter(m => m.rec && (m.id || m) !== currentModel && !recentModels.includes(m.id || m));
          if (recModels.length > 0) {
            items.push(sep('Recommended'));
            for (const m of recModels.slice(0, 4)) {
              items.push(makeItem(m.id || m, `★ ${m.family || ''}`));
            }
          }

          // 4. All others grouped by family
          const shownIds = new Set([...recentModels, currentModel, ...recModels.map(m => m.id || m)]);
          const families = {};
          for (const m of models) {
            const id = m.id || m;
            if (shownIds.has(id)) continue;
            const fam = m.family || 'Other';
            if (!families[fam]) families[fam] = [];
            families[fam].push(m);
          }
          for (const [fam, fmodels] of Object.entries(families)) {
            items.push(sep(fam));
            for (const m of fmodels) items.push(makeItem(m.id || m));
          }

          // Filter separator di awal/berturutan & buat non-selectable
          const chosen = await interactiveMenu(this.rl,
            `Model — ${this.aiManager.getProvider()} (${models.length})`,
            items,
            currentModel
          );
          if (chosen && !chosen.startsWith('__sep__')) {
            this.currentModel = chosen;
            console.log(`  ${gr}✓${rs} Model aktif: ${cy}${chosen}${rs}`);
          } else if (!chosen) {
            console.log(`  ${gy}Dibatalkan${rs}`);
          }
        }
        break;
      }

      case '/context':
        if (parts[1]) {
          const n = parseInt(parts[1]);
          if (n >= 2 && n <= 100) {
            this.aiManager.contextManager.setMaxTurns(n);
            console.log(`\n  ${gr}✓${rs} Max turns set to ${cy}${n}${rs}`);
          } else {
            console.log(`\n  ${re}✗${rs} Value must be 2-100`);
          }
        } else {
          console.log(`\n  ${bd}Context${rs}`);
          console.log(`  ${gy}Turns${rs}   ${cy}${this.aiManager.contextManager.maxTurns}${rs}`);
          console.log(`  ${gy}History${rs} ${cy}${this.aiManager.contextManager.getHistoryLength()} messages${rs}`);
          console.log(`  ${gy}Tokens${rs}  ${cy}${this.aiManager.contextManager.getEstimatedTokens()}${rs}`);
        }
        break;

      case '/sessions': {
        const allSessions = db.getSessions(20);
        console.log(`\n  ${bd}Saved Sessions${rs} ${gy}(${allSessions.length})${rs}\n`);
        allSessions.forEach((s, i) => {
          const active = s.id === this.sessionId ? ` ${gr}●${rs}` : '';
          console.log(`  ${gy}${i + 1}.${rs}${active} ${cy}${s.title.slice(0, 45)}${rs}`);
          console.log(`      ${gy}${s.provider}${rs} ${dim}${s.updated_at}${rs}`);
        });
        break;
      }

      case '/session': {
        const n = parseInt(parts[1]);
        if (isNaN(n) || n < 1) { console.log(`\n  ${re}✗${rs} Enter session number`); break; }
        const allSessions = db.getSessions(20);
        if (n > allSessions.length) { console.log(`\n  ${re}✗${rs} Session not found`); break; }
        const target = allSessions[n - 1];
        this._loadSession(target.id);
        console.log(`\n  ${gr}✓${rs} Loaded: ${cy}${target.title}${rs} ${gy}(${this.aiManager.contextManager.getHistoryLength()} messages)${rs}`);
        break;
      }

      case '/clear':
        this.aiManager.clearContext();
        if (this.sessionId) db.deleteMessages(this.sessionId);
        console.log(`\n  ${gr}✓${rs} Conversation cleared`);
        break;

      case '/info':
        this.showInfo();
        break;

      case '/exit':
        this._saveSession();
        console.log(`\n  ${gr}◈${rs} ${bd}Wanar AI${rs} ${yl}✦${rs} ${gy}Sampai jumpa!${rs}\n`);
        this.rl.close();
        process.exit(0);
        return;

      default:
        console.log(`\n  ${re}✗${rs} Unknown command: ${c} — type ${cy}/help${rs}`);
    }
    this.promptUser();
  }

  // ── Chat ───────────────────────────────────────────────────────
  async handleChat(text) {
    if (this.aiManager.contextManager.getHistoryLength() === 0) {
      this.sessionName = text.length > 32 ? `${text.slice(0, 32)}...` : text;
    }

    this.rl.pause();

    // Save message to history
    const currentHistory = this.aiManager.contextManager.history;

    // Simple loading indicator
    const startTime = Date.now();
    let loadingInterval;

    const showLoader = () => {
      const dots = ['.', '..', '...'];
      let i = 0;
      loadingInterval = setInterval(() => {
        process.stdout.write(`\r  ${gy}│${rs} ${yl}Processing${rs}${gy}${dots[i % 3]}${rs} `);
        i++;
      }, 300);
    };
    showLoader();

    let hasError = false;
    let fullContent = '';
    let thoughtMs = 0;
    let started = false;
    let printedThought = false;

    try {
      const stream = this.aiManager.chatWithTools(
        [...currentHistory, { role: 'user', content: text }],
        { provider: this.aiManager.getProvider(), model: this.currentModel }
      );

      for await (const chunk of stream) {
        if (!started) {
          started = true;
          thoughtMs = Date.now() - startTime;
          clearInterval(loadingInterval);
          process.stdout.write('\r\x1b[2K');
          // Print user message
          console.log(`  ${gr}┌ User${rs}`);
          for (const line of wrapText(text, tw() - 8)) {
            console.log(`  ${gr}│${rs} ${gy}${line}${rs}`);
          }
          console.log(`  ${gr}└${rs}`);
        }

        if (chunk.type === 'content') {
          if (!printedThought) {
            printedThought = true;
            console.log(`  ${yl}┌ Wanar AI${rs} ${dim}(${thoughtMs}ms)${rs}`);
          }
          fullContent += chunk.content;
          // Stream real-time — strip markdown inline per karakter yang aman
          // (markdown yang span multi-chunk akan di-clean lagi saat final flush)
          process.stdout.write(chunk.content
            .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*([^ *][^*]*?[^ *])\*/g, '$1')
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
            .replace(/[\u{2600}-\u{27BF}]/gu, '')
            .replace(/[\u{2700}-\u{27BF}]/gu, '')
          );
        } else if (chunk.type === 'tool_start') {
          // Flush content yang sudah terkumpul sebelum tool call
          if (fullContent && !printedThought) {
            printedThought = true;
            console.log(`  ${yl}┌ Wanar AI${rs} ${dim}(${thoughtMs}ms)${rs}`);
            process.stdout.write(stripMarkdown(fullContent));
            process.stdout.write('\n');
            fullContent = '';
          } else if (fullContent && printedThought) {
            process.stdout.write(stripMarkdown(fullContent));
            process.stdout.write('\n');
            fullContent = '';
          }
          if (!printedThought) {
            printedThought = true;
            console.log(`  ${yl}┌ Wanar AI${rs} ${dim}(${thoughtMs}ms)${rs}`);
          }
          const f = chunk.args?.path || chunk.args?.pattern || chunk.args?.command || '';
          const short = f ? ` ${dim}${f.slice(0, tw() - 20)}${rs}` : '';
          const icon = chunk.name === 'read_file' ? `${bl}■${rs}` :
            chunk.name === 'write_file' || chunk.name === 'edit_file' ? `${mg}■${rs}` :
            chunk.name === 'bash' ? `${gy}$${rs}` : `${gy}•${rs}`;
          console.log(`  ${gy}│${rs} ${icon} ${gy}${chunk.name}${rs}${short}`);
        } else if (chunk.type === 'tool_result') {
          // Tampilkan ringkasan hasil tool ke user
          if (chunk.result) {
            const res = chunk.result;
            // Hanya tampilkan ringkasan singkat, bukan full output
            if (res.error) {
              console.log(`  ${gy}│${rs}   ${re}✗${rs} ${dim}${String(res.error).slice(0, 80)}${rs}`);
            } else if (res.stdout || res.content) {
              const out = (res.stdout || res.content || '').trim();
              const lines = out.split('\n').slice(0, 3);
              for (const l of lines) {
                if (l.trim()) console.log(`  ${gy}│${rs}   ${dim}${l.slice(0, tw() - 10)}${rs}`);
              }
              if (out.split('\n').length > 3) console.log(`  ${gy}│${rs}   ${dim}... (${out.split('\n').length} lines)${rs}`);
            } else if (res.success) {
              console.log(`  ${gy}│${rs}   ${gr}✓${rs} ${dim}done${rs}`);
            }
          }
        } else if (chunk.type === 'error') {
          hasError = true;
          console.log(`\n  ${re}│ Error: ${chunk.content}${rs}`);
        } else if (chunk.type === 'done') {
          break;
        }
      }
    } catch (e) {
      hasError = true;
      clearInterval(loadingInterval);
      process.stdout.write('\r\x1b[2K');
      console.log(`  ${re}│ Error: ${e.message}${rs}`);
    }

    if (!started) {
      clearInterval(loadingInterval);
      process.stdout.write('\r\x1b[2K');
    }

    // Flush sisa content yang belum dicetak — render sekaligus dengan stripMarkdown
    const savedContent = fullContent; // simpan sebelum di-reset
    if (fullContent && !hasError) {
      if (!printedThought) {
        console.log(`  ${yl}┌ Wanar AI${rs} ${dim}(${thoughtMs}ms)${rs}`);
      }
      // Render dengan indentasi per baris
      const cleanText = stripMarkdown(fullContent);
      for (const line of cleanText.split('\n')) {
        console.log(`  ${gy}│${rs} ${line}`);
      }
      fullContent = '';
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const model = this.currentModel || '-';

    if (!hasError && savedContent) {
      const tokCount = this.aiManager.contextManager.getEstimatedTokens();
      console.log(`\n  ${gy}└─ ${dim}${model} · ${elapsed}s · ~${tokCount} tok${rs}`);
      this.aiManager.addTurn('user', text);
      this.aiManager.addTurn('assistant', savedContent);
      if (this.aiManager.contextManager.getHistoryLength() > this.aiManager.contextManager.maxTurns * 2) {
        await this.aiManager.contextManager.generateSummary(model);
      }
      this._saveSession();
    }

    this.rl.resume();
    this.promptUser();
  }

  // ── Info ───────────────────────────────────────────────────────
  showInfo() {
    const info = this.aiManager.getProviderInfo();
    console.log(`\n  ${bd}Wanar AI - System Information${rs}\n`);
    console.log(`  ${bd}Active Provider${rs}  ${cy}${info.current}${rs}`);
    for (const [k, v] of Object.entries(info.providers)) {
      const s = v.available ? `${gr}●${rs}` : `${re}○${rs}`;
      const keyInfo = v.keyCount ? ` ${gy}keys:${rs}${cy}${v.keyCount}${rs}` : '';
      console.log(`  ${s} ${bd}${k}${rs}${keyInfo}`);
      console.log(`    ${gy}model:${rs} ${cy}${v.defaultModel || '-'}${rs}`);
    }
    console.log(`\n  ${bd}Context${rs}`);
    console.log(`  ${gy}history:${rs} ${cy}${info.context.historyLength} messages${rs}`);
    console.log(`  ${gy}tokens:${rs}  ${cy}${info.context.estimatedTokens}${rs}`);
    console.log(`  ${gy}turns:${rs}   ${cy}${info.context.maxTurns}${rs}`);
  }
}

// ── Bootstrap ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const sessionFlagIdx = args.indexOf('-s');
const resumeSessionId = sessionFlagIdx !== -1 ? args[sessionFlagIdx + 1] : null;
const isNewSession = args.includes('--new') || args.includes('-n');

// ── Setup Wizard ─────────────────────────────────────────────────
async function runSetupWizard() {
  const configDir = path.join(os.homedir(), '.wanar-ai');
  const envFile = path.join(configDir, '.env');

  console.log(`\n  ${barBlue}┌─────────────────────────────────────┐${rs}`);
  console.log(`  ${barBlue}│${rs}  ${bd}Wanar AI — First Time Setup${rs}         ${barBlue}│${rs}`);
  console.log(`  ${barBlue}│${rs}  ${dim}by Wisnu & Zahra${rs}                     ${barBlue}│${rs}`);
  console.log(`  ${barBlue}└─────────────────────────────────────┘${rs}\n`);
  console.log(`  ${gy}Config akan disimpan ke:${rs} ${cy}${envFile}${rs}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log(`  ${bd}Masukkan OpenAgentic API Key kamu:${rs}`);
  console.log(`  ${dim}Dapatkan di: https://openagentic.id${rs}\n`);
  const apiKey = await ask(`  ${cy}API Key${rs}: `);

  if (!apiKey || apiKey.trim().length < 10) {
    console.log(`\n  ${re}API Key tidak valid. Jalankan ulang wanarai untuk setup.${rs}\n`);
    rl.close();
    process.exit(1);
  }

  // Buat folder ~/.wanar-ai jika belum ada
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  // Tulis .env ke home directory
  const envContent = `# Wanar AI Configuration
# Generated by setup wizard
OPENAGENTIC_API_KEY=${apiKey.trim()}
OPENAGENTIC_BASE_URL=https://openagentic.id/api/v1
OPENAGENTIC_DEFAULT_MODEL=claude-sonnet-4-5
DEFAULT_PROVIDER=openagentic
PORT=3000
`;
  fs.writeFileSync(envFile, envContent, 'utf8');
  rl.close();

  console.log(`\n  ${gr}✓${rs} API Key tersimpan di ${cy}${envFile}${rs}`);
  console.log(`  ${gr}✓${rs} Wanar AI siap digunakan!\n`);
  console.log(`  ${dim}Jalankan ${cy}wanarai${rs} ${dim}untuk mulai chat.${rs}\n`);
  process.exit(0);
}

// Cek apakah API key tersedia
const hasApiKey = !!(process.env.OPENAGENTIC_API_KEY ||
  (() => {
    try {
      const envPath = path.join(os.homedir(), '.wanar-ai', '.env');
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        return content.includes('OPENAGENTIC_API_KEY=') &&
          !content.includes('OPENAGENTIC_API_KEY=sk-your');
      }
    } catch (_) {}
    return false;
  })());

if (!hasApiKey || args.includes('--setup')) {
  runSetupWizard().catch(e => {
    console.error(`\n  ${re}Setup error: ${e.message}${rs}`);
    process.exit(1);
  });
} else {
  const cli = new WanarCLI();
  cli.start(isNewSession ? '__new__' : resumeSessionId).catch(err => {
    console.error(`\n  ${re}Fatal: ${err.message}${rs}`);
    process.exit(1);
  });
}
