/**
 * Wanar AI CLI v2.0 — Professional Enterprise Terminal Interface
 * by Wisnu Alfian Nur Ashar
 */
import readline from 'readline';
import crypto from 'crypto';
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
const commands = ['/help', '/provider', '/model', '/clear', '/info', '/context', '/sessions', '/session', '/exit'];

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

function completer(line) {
  const hits = commands.filter(c => c.startsWith(line.toLowerCase()));
  return [hits.length ? hits : commands, line];
}

// ── Logo (clean, compact, fast) ─────────────────────────────────
const LOGO = [
  `${c256(39)}┌───────────────────────────────┐${rs}`,
  `${c256(39)}│ ${bd}${c256(45)}W${c256(39)}A${c256(33)}N${c256(45)}A${c256(39)}R ${c256(33)}AI${rs} ${dim}v2.0${rs}${' '.repeat(8)}${c256(39)}│${rs}`,
  `${c256(39)}│ ${gy}Enterprise Multi-Provider AI${rs}        ${c256(39)}│${rs}`,
  `${c256(39)}└───────────────────────────────┘${rs}`,
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
    this.currentModel = null;
    this.sessionId = `ses_${crypto.randomBytes(8).toString('hex')}`;
    this.sessionName = 'New Chat';
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '', completer });
  }

  _saveSession() {
    this.sessionId = `ses_${crypto.randomBytes(8).toString('hex')}`;
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
  async start() {
    // Display logo
    for (const line of LOGO) {
      console.log(`  ${line}`);
      await sleep(15);
    }
    console.log();

    // Load recent session
    const sessions = db.getSessions(5);
    if (sessions.length > 0) {
      console.log(`  ${gy}│${rs} ${bd}Recent Sessions${rs}`);
      sessions.forEach((s, i) => {
        const active = s.id === this.sessionId ? ` ${gr}●${rs}` : '';
        console.log(`  ${gy}│${rs}  ${gy}${i + 1}.${rs}${active} ${cy}${s.title.slice(0, 40)}${rs} ${gy}${s.provider}${rs}`);
      });
      console.log(`  ${gy}│${rs}  ${dim}Type /session <number> to load${rs}`);
      this._loadSession(sessions[0].id);
      console.log(`  ${gy}│${rs}`);
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

      case '/provider':
        if (parts[1]) {
          try {
            this.aiManager.setProvider(parts[1]);
            this.currentModel = null;
            console.log(`\n  ${gr}✓${rs} Provider switched to ${cy}${parts[1]}${rs}`);
          } catch (e) {
            console.log(`\n  ${re}✗${rs} ${e.message}`);
          }
        } else {
          const current = this.aiManager.getProvider();
          const avail = this.aiManager.getAvailableProviders();
          console.log(`\n  ${bd}Current${rs}  ${cy}${current}${rs}`);
          console.log(`  ${bd}Available${rs} ${gy}${avail.join(' · ')}${rs}`);
        }
        break;

      case '/model': {
        const models = this.aiManager.getAvailableModels();
        const p = this.aiManager.getProvider();
        console.log(`\n  ${bd}${p} Models${rs}\n`);
        const ids = (models || []).map(m => m.id || m);
        ids.forEach((id, i) => {
          const star = id === this.currentModel ? ` ${gr}●${rs}` : '';
          const rec = i === 0 ? `${gr}★${rs} ` : '  ';
          console.log(`  ${gy}${i + 1}.${rs} ${rec}${cy}${id}${rs}${star}`);
        });
        console.log(`\n  ${gy}Enter number or 0 to cancel${rs}`);
        this.rl.question(`  ${gr}Select${rs} ❯ `, ans => {
          const n = parseInt(ans.trim());
          if (n > 0 && n <= ids.length) {
            this.currentModel = ids[n - 1];
            console.log(`  ${gr}✓${rs} ${cy}${this.currentModel}${rs}`);
          } else if (n !== 0) {
            console.log(`  ${re}✗${rs} Invalid`);
          }
          this.promptUser();
        });
        return;
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
          process.stdout.write(chunk.content);
        } else if (chunk.type === 'tool_start') {
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

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const model = this.currentModel || '-';

    if (!hasError && fullContent) {
      // Insert a blank with the model info
      const tokCount = this.aiManager.contextManager.getEstimatedTokens();
      console.log(`\n  ${gy}└─ ${dim}${model} · ${elapsed}s · ~${tokCount} tok${rs}`);
      this.aiManager.addTurn('user', text);
      this.aiManager.addTurn('assistant', fullContent);
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
const cli = new WanarCLI();
cli.start().catch(err => {
  console.error(`\n  ${re}Fatal: ${err.message}${rs}`);
  process.exit(1);
});
