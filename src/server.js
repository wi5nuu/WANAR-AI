import express from 'express';
import path from 'path';
import fs from 'fs';
import helmet from 'helmet';
import cors from 'cors';
import multer from 'multer';
import { createRateLimiters } from './middleware/rate-limit.js';
import contextCache from './context-cache.js';
import * as enterprise from './enterprise-auth.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const pdfParse = _require('pdf-parse');

import config from '../config/config.js';
import AIManager, { WANAR_SYSTEM_PROMPT, WANAR_SYSTEM_PROMPT_WEB } from './ai-manager.js';
import * as db from './database.js';
import { getToolDefinitions, executeTool } from './tools/registry.js';
import * as providerRegistry from './providers/registry.js';
import * as auth from './auth.js';
import ContextManager from './context-manager.js';
import ragEngine from './rag/index.js';
import graphStore from './rag/graph-store.js';
import { DistributedCoordinator } from './distributed.js';
import * as securityScanner from './security-scanner.js';
import * as jobAgent from './tools/job-agent.js';
import { agentEvents } from './tools/job-agent.js';

const coordinator = new DistributedCoordinator();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = config.server.port;
const aiManager = new AIManager();

// ==================== MULTER FILE UPLOAD CONFIG ====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
});

/**
 * Extract text content from uploaded file buffer
 */
async function extractFileContent(buffer, mimetype, originalname) {
  const ext = originalname.split('.').pop().toLowerCase();

  // Plain text / code files
  const textTypes = [
    'text/', 'application/json', 'application/xml',
    'application/javascript', 'application/typescript',
    'application/x-yaml', 'application/x-sh',
  ];
  const textExts = [
    'txt','md','csv','json','xml','yaml','yml','js','jsx','ts','tsx',
    'py','java','cpp','c','cs','html','css','scss','sql','sh','bat',
    'env','gitignore','toml','ini','cfg','conf','log','rs','go','rb',
    'php','swift','kt','r','m','h','hpp','vue','svelte',
  ];

  if (textTypes.some(t => mimetype.startsWith(t)) || textExts.includes(ext)) {
    const text = buffer.toString('utf8');
    // Limit to 100K chars to avoid token overflow
    return text.length > 100000 ? text.slice(0, 100000) + '\n...[truncated]' : text;
  }

  // Images - return base64 data URL for vision models
  if (mimetype.startsWith('image/')) {
    const b64 = buffer.toString('base64');
    // Limit image size hint
    return `[Image file: ${originalname}, size: ${(buffer.length / 1024).toFixed(1)}KB, type: ${mimetype}]\nBase64 data available for vision models.`;
  }

  // PDF - extract text using pdf-parse
  if (mimetype === 'application/pdf' || ext === 'pdf') {
    try {
      const data = await pdfParse(buffer);
      const text = data.text || '';
      if (text.trim().length > 50) {
        return text.length > 80000 ? text.slice(0, 80000) + '\n...[truncated]' : text;
      }
    } catch (e) {
      // fall through to fallback
    }
    return `[PDF file: ${originalname}, ${(buffer.length / 1024).toFixed(1)}KB. Could not extract text automatically.]`;
  }

  // Office formats - DOCX/PPTX/XLSX are ZIP-based XML
  if (['docx','pptx','xlsx'].includes(ext) ||
      mimetype.includes('wordprocessingml') ||
      mimetype.includes('presentationml') ||
      mimetype.includes('spreadsheetml')) {
    // Try to extract XML text content from Office Open XML
    const raw = buffer.toString('latin1');
    const xmlTexts = [];
    const wTRegex = /<w:t[^>]*>(.*?)<\/w:t>/g;
    const aTRegex = /<a:t[^>]*>(.*?)<\/a:t>/g;
    let m;
    while ((m = wTRegex.exec(raw)) !== null) if (m[1].trim()) xmlTexts.push(m[1]);
    while ((m = aTRegex.exec(raw)) !== null) if (m[1].trim()) xmlTexts.push(m[1]);
    if (xmlTexts.length > 0) {
      const text = xmlTexts.join(' ');
      return text.length > 80000 ? text.slice(0, 80000) + '\n...[truncated]' : text;
    }
    return `[Office file: ${originalname}, ${(buffer.length / 1024).toFixed(1)}KB. Binary format — please convert to text/PDF for full analysis.]`;
  }

  // ZIP / archives
  if (['zip','tar','gz','rar','7z'].includes(ext)) {
    return `[Archive file: ${originalname}, ${(buffer.length / 1024).toFixed(1)}KB. Cannot extract archive contents directly.]`;
  }

  // Fallback
  return `[File: ${originalname}, type: ${mimetype}, size: ${(buffer.length / 1024).toFixed(1)}KB. Binary format — content not extractable as text.]`;
}

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
}));

app.use(express.json({ limit: '2mb' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Request body too large. Max 2MB.' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid JSON in request body.' });
  }
  next(err);
});

const rateLimiters = createRateLimiters();
app.use(rateLimiters.global);

const clientDist = path.join(__dirname, '../client/dist');
app.use(express.static(clientDist, { maxAge: '1h', etag: true }));

const ctxManager = new ContextManager({
  maxTurns: config.context?.maxTurns || 20,
  maxContextTokens: config.context?.maxContextTokens || 131072,
});

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').slice(0, 50000);
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function validateChatBody(body) {
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { valid: false, error: 'messages array is required' };
  }
  if (body.messages.length > 100) {
    return { valid: false, error: 'Too many messages. Max 100.' };
  }
  for (const msg of body.messages) {
    if (!msg.role || !['user', 'assistant', 'system'].includes(msg.role)) {
      return { valid: false, error: 'Invalid message role' };
    }
    if (typeof msg.content !== 'string' || msg.content.length > 50000) {
      return { valid: false, error: 'Message content too long (max 50000 chars)' };
    }
  }
  const validProviders = ['openagentic', 'nvidia', 'puter', 'vector'];
  if (body.provider && !validProviders.includes(body.provider)) {
    return { valid: false, error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` };
  }
  return { valid: true };
}

function checkTokenLimit() {
  const today = new Date().toISOString().slice(0, 10);
  const usage = db.getDailyUsage(today);
  if (usage.total >= config.tokens.dailyLimit) {
    return { blocked: true, usage };
  }
  return { blocked: false, usage };
}

const ESTIMATED_COST_PER_TOKEN = {
  nvidia: 1.0 / 1e6,
  puter: 0,
};

function estimateCost(provider, tokens) {
  return tokens * (ESTIMATED_COST_PER_TOKEN[provider] || 0);
}

async function saveMessagesToDb(sessionId, messages, newAssistantContent, tokens, provider, model) {
  const existing = db.getMessages(sessionId);
  const existingCount = existing.length;

  const newMessages = messages.slice(existingCount);

  for (const msg of newMessages) {
    db.addMessage(sessionId, msg.role, msg.content, 0, provider, model);
  }

  db.addMessage(sessionId, 'assistant', newAssistantContent, tokens, provider, model);
}

// ==================== FILE UPLOAD ENDPOINT ====================

app.post('/api/upload', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const { buffer, mimetype, originalname, size } = req.file;

  try {
    const content = await extractFileContent(buffer, mimetype, originalname);

    // For images, also return base64 for potential vision use
    let imageData = null;
    if (mimetype.startsWith('image/')) {
      imageData = `data:${mimetype};base64,${buffer.toString('base64')}`;
    }

    // Preview = first 500 chars
    const preview = content.length > 500 ? content.slice(0, 500) + '...' : content;

    res.json({
      success: true,
      name: originalname,
      type: mimetype,
      size,
      content,
      preview,
      imageData,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `Failed to process file: ${err.message}` });
  }
}));

// ==================== BROWSER AGENT ENDPOINT ====================

app.post('/api/browse', asyncHandler(async (req, res) => {
  const { url, action = 'open', query, filter, extract = 'text', wait_for, timeout = 30, scroll = false } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'url is required' });
  }

  // Lazy import to avoid startup delay
  const { executeBrowserTool } = await import('./tools/browser.js');

  let result;
  if (action === 'search') {
    result = await executeBrowserTool('browser_search_page', { url, query, context_chars: 300 });
  } else if (action === 'links') {
    result = await executeBrowserTool('browser_extract_links', { url, filter });
  } else {
    result = await executeBrowserTool('browser_open', { url, extract, wait_for, timeout, scroll });
  }

  res.json(result);
}));

// ==================== PROFILE & APPLY HISTORY ENDPOINTS ====================

app.get('/api/profile', asyncHandler(async (req, res) => {
  const { getProfile } = await import('./database.js');
  const profile = getProfile();
  res.json({ success: true, profile: profile || {} });
}));

app.post('/api/profile', asyncHandler(async (req, res) => {
  const { saveProfile } = await import('./database.js');
  const profile = saveProfile(req.body);
  res.json({ success: true, profile });
}));

app.get('/api/apply-history', asyncHandler(async (req, res) => {
  const { getApplyHistory } = await import('./database.js');
  const history = getApplyHistory(100);
  res.json({ success: true, history });
}));

app.patch('/api/apply-history/:id', asyncHandler(async (req, res) => {
  const { updateApplyStatus } = await import('./database.js');
  const { status, notes } = req.body;
  const record = updateApplyStatus(req.params.id, status, notes);
  res.json({ success: true, record });
}));

app.get('/api/config', (req, res) => {
  res.json({
    providers: ['openagentic', 'nvidia', 'puter', 'vector'],
    defaultProvider: config.defaultProvider,
    openagentic: {
      models: config.openagentic.models.map(m => ({
        id: m.id || m,
        label: m.label || m.id || m,
        family: m.family || 'Unknown',
        rec: m.rec || false,
        tags: m.tags || [],
      })),
      defaultModel: config.openagentic.defaultModel,
      maxTokens: config.openagentic.maxTokens,
      configured: Boolean(config.openagentic.apiKey),
    },
    nvidia: {
      models: config.nvidia.models.map(m => ({ id: m.id || m, label: m.label || m.id || m, family: m.family || '', rec: m.rec || false, tags: m.tags || [] })),
      defaultModel: config.nvidia.defaultModel,
      maxTokens: config.nvidia.maxTokens,
      keyCount: config.nvidia.apiKeys?.length || 1,
    },
    puter: {
      models: config.puter.models.map(m => ({ id: m.id || m, label: m.label || m.id || m, rec: m.rec || false, tags: m.tags || [] })),
      defaultModel: config.puter.defaultModel,
      enabled: config.puter.enabled,
    },
    vector: {
      models: config.vector.models.map(m => ({ id: m.id || m, label: m.label || m.id || m, rec: m.rec || false, tags: m.tags || [] })),
      defaultModel: config.vector.defaultModel,
      maxTokens: config.vector.maxTokens,
    },
    tokens: { dailyLimit: config.tokens.dailyLimit, dailyCostLimit: config.tokens.dailyCostLimit },
    context: { maxTurns: config.context?.maxTurns || 20 },
    rag: { enabled: config.rag?.enabled || false },
  });
});

app.get('/api/sessions', (req, res) => {
  const sessions = db.getSessions(parseInt(req.query.limit) || 50);
  res.json(sessions);
});

app.post('/api/sessions', (req, res) => {
  const { id, title, provider, model, messages } = req.body;
  const sessionId = id || crypto.randomUUID();
  const existing = db.getSessions(1000).find(s => s.id === sessionId);

  if (!existing) {
    const sessionTitle = title || (messages && messages.length > 0 ? messages[0].content.slice(0, 60) : 'New Chat');
    db.createSession(sessionId, sessionTitle, provider || config.defaultProvider, model || '');
  }

  if (messages && Array.isArray(messages)) {
    db.deleteMessages(sessionId);
    for (const msg of messages) {
      db.addMessage(sessionId, msg.role, sanitize(msg.content).slice(0, 50000), msg.tokens || 0, provider, model);
    }
  }

  res.json({ id: sessionId });
});

app.get('/api/sessions/:id', (req, res) => {
  const messages = db.getMessages(req.params.id);
  res.json({ id: req.params.id, messages });
});

app.delete('/api/sessions/:id', (req, res) => {
  db.deleteSession(req.params.id);
  res.json({ success: true });
});

app.patch('/api/sessions/:id', (req, res) => {
  const { title } = req.body;
  if (title) db.updateSessionTitle(req.params.id, sanitize(title).slice(0, 200));
  res.json({ success: true });
});

app.get('/api/sessions/:id/messages', (req, res) => {
  const messages = db.getMessages(req.params.id);
  res.json({ messages });
});

app.post('/api/chat', rateLimiters.chat, asyncHandler(async (req, res) => {
  const validation = validateChatBody(req.body);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  const limitCheck = checkTokenLimit();
  if (limitCheck.blocked) {
    return res.status(429).json({
      success: false,
      error: `Daily token limit of ${(config.tokens.dailyLimit / 1e6).toFixed(0)}M reached. Please wait until reset.`,
    });
  }

  const provider = req.body.provider || config.defaultProvider;
  const model = req.body.model;
  const messages = req.body.messages.map(m => ({ role: m.role, content: sanitize(m.content) }));
  const sessionId = req.body.session_id;

  let tokenContext = '';
  try {
    const today = new Date().toISOString().slice(0, 10);
    const usage = db.getDailyUsage(today);
    const limit = config.tokens?.dailyLimit || 500000;
    const remaining = Math.max(0, limit - (usage.total || 0));
    const pct = ((usage.total || 0) / limit * 100).toFixed(1);
    tokenContext = `\n\nKONTEKS TOKEN HARI INI (${today}):\n- Total dipakai: ${usage.total || 0} token\n- Sisa: ${remaining} token (${pct}% terpakai)\n- Limit harian: ${limit} token\n- Biaya hari ini: Rp ${(usage.cost || 0).toLocaleString('id-ID')}`;
  } catch (_) {}

  const { messages: truncatedMessages } = ctxManager.getTruncatedMessages(
    messages, model, WANAR_SYSTEM_PROMPT_WEB + tokenContext
  );

  const cacheKey = `chat:${provider}:${model || 'default'}:${truncatedMessages.slice(-2).map(m => m.content.slice(0, 100)).join('|')}`;
  const cached = contextCache.get(cacheKey);
  if (cached && req.body.useCache !== false) {
    return res.json({ ...cached, cached: true });
  }

  const tools = getToolDefinitions();
  let result;
  if (provider === 'openagentic') {
    result = await aiManager.openagenticProvider.chat(truncatedMessages, { model, tools, systemPrompt: WANAR_SYSTEM_PROMPT_WEB + tokenContext });
  } else if (provider === 'nvidia') {
    result = await aiManager.nvidiaProvider.chat(truncatedMessages, { model, tools, top_p: req.body.top_p ?? 1, seed: req.body.seed });
  } else if (provider === 'vector') {
    result = await aiManager.vectorProvider.chat(truncatedMessages, { model, tools });
  } else {
    const customProvider = providerRegistry.createDynamicProvider(provider);
    if (customProvider) {
      result = await customProvider.chat(truncatedMessages, { model, tools, ...req.body });
    } else {
      return res.status(400).json({ success: false, error: `Provider ${provider} tidak dikenal` });
    }
  }

  if (result && result.success) {
    let finalContent = result.content || '';
    let totalUsage = result.usage || { total_tokens: 0 };

    if (result.tool_calls && result.tool_calls.length > 0) {
      let toolMessages = [...truncatedMessages];
      let tcCount = 0;
      const maxTC = 25;
      let currentResult = result;

      while (currentResult.tool_calls && currentResult.tool_calls.length > 0 && tcCount < maxTC) {
        tcCount++;
        toolMessages.push({
          role: 'assistant',
          content: currentResult.content || null,
          tool_calls: currentResult.tool_calls,
        });

        for (const tc of currentResult.tool_calls) {
          if (tc.type !== 'function') continue;
          const { name, arguments: rawArgs } = tc.function;
          let args;
          try { args = JSON.parse(rawArgs); } catch { args = {}; }
          const toolResult = await executeTool(name, args);
          const resultStr = JSON.stringify(toolResult);
          toolMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultStr.length > 8000 ? resultStr.slice(0, 8000) + '\n...(truncated)' : resultStr,
          });
        }

        const providerCall = async (msgs) => {
          if (provider === 'openagentic') return aiManager.openagenticProvider.chat(msgs, { model, tools, systemPrompt: WANAR_SYSTEM_PROMPT_WEB + tokenContext });
          if (provider === 'nvidia') return aiManager.nvidiaProvider.chat(msgs, { model, tools, top_p: req.body.top_p ?? 1, seed: req.body.seed });
          if (provider === 'vector') return aiManager.vectorProvider.chat(msgs, { model, tools });
          const cp = providerRegistry.createDynamicProvider(provider);
          if (cp) return cp.chat(msgs, { model, tools, ...req.body });
          return null;
        };

        currentResult = await providerCall(toolMessages);
        if (!currentResult || !currentResult.success) break;
      }

      if (currentResult && currentResult.success && currentResult.content) {
        finalContent = currentResult.content;
        totalUsage = currentResult.usage || totalUsage;
      }
    }

    const tokens = totalUsage?.total_tokens || Math.round(finalContent.length * 1.3);
    const date = new Date().toISOString().slice(0, 10);
    db.recordTokenUsage(date, provider, model || 'unknown', tokens, estimateCost(provider, tokens));

    if (sessionId) {
      saveMessagesToDb(sessionId, messages, finalContent, tokens, provider, model);
    }

    const responseResult = { success: true, content: finalContent, model: result.model, usage: totalUsage, provider };
    contextCache.set(cacheKey, responseResult, 60000);
    res.json(responseResult);
  } else {
    res.status(500).json(result || { success: false, error: 'Failed to get response' });
  }
}));

app.post('/api/chat/stream', rateLimiters.chat, asyncHandler(async (req, res) => {
  const validation = validateChatBody(req.body);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  const limitCheck = checkTokenLimit();
  if (limitCheck.blocked) {
    return res.status(429).json({
      success: false,
      error: `Daily token limit of ${(config.tokens.dailyLimit / 1e6).toFixed(0)}M reached.`,
    });
  }

  const provider = req.query.provider || req.body.provider || config.defaultProvider;
  const model = req.query.model || req.body.model;
  const messages = req.body.messages.map(m => ({ role: m.role, content: sanitize(m.content) }));
  const sessionId = req.body.session_id || null;

  let systemPrompt = WANAR_SYSTEM_PROMPT_WEB;

  if (ragEngine.enabled && ragEngine.initialized) {
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (lastUserMsg) {
      const cacheKey = `rag:${lastUserMsg.content.slice(0, 200)}`;
      const ragContext = await contextCache.getOrSetAsync(
        cacheKey,
        () => ragEngine.buildRAGContext(lastUserMsg.content, 3) || '',
        120000
      );
      if (ragContext) {
        systemPrompt += '\n\nAnda memiliki akses ke kode project berikut:\n' + ragContext;
        systemPrompt += '\nGunakan kode di atas untuk menjawab pertanyaan terkait codebase. Jika tidak relevan, abaikan.';
      }
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientDisconnected = false;
  
  // Detect client disconnect
  req.on('close', () => {
    clientDisconnected = true;
  });

  req.on('error', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
      clientDisconnected = true;
    }
  });

  const sendEvent = (event, data) => {
    if (clientDisconnected || res.writableEnded) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch (err) {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
        clientDisconnected = true;
      }
      return false;
    }
  };

  let fullContent = '';
  let totalTokens = 0;
  const startTime = Date.now();
  const inputChars = messages.reduce((s, m) => s + m.content.length, 0);
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

  try {
    const stream = aiManager.chatWithTools(messages, {
      provider,
      model,
      systemPrompt,
      top_p: req.body.top_p ?? 1,
      seed: req.body.seed,
    });

    for await (const chunk of stream) {
      // Stop streaming if client disconnected
      if (clientDisconnected) {
        console.log('[Stream] Client disconnected, stopping stream');
        break;
      }

      if (chunk.type === 'content') {
        fullContent += chunk.content;
        if (!sendEvent('token', { content: chunk.content })) break;
      } else if (chunk.type === 'tool_start') {
        if (!sendEvent('tool_start', { name: chunk.name, args: chunk.args })) break;
      } else if (chunk.type === 'tool_end') {
        if (!sendEvent('tool_end', { name: chunk.name, result: chunk.result })) break;
      } else if (chunk.type === 'error') {
        sendEvent('error', { message: chunk.content });
      } else if (chunk.type === 'done') {
        break;
      }
    }

    if (!clientDisconnected) {
      totalTokens = Math.round(fullContent.length * 1.3);
      const date = new Date().toISOString().slice(0, 10);
      db.recordTokenUsage(date, provider, model || 'unknown', totalTokens, estimateCost(provider, totalTokens));

      if (sessionId && fullContent) {
        saveMessagesToDb(sessionId, messages, fullContent, totalTokens, provider, model);
      }

      sendEvent('done', { tokens: totalTokens });
    }

    const elapsed = Date.now() - startTime;
    db.logRequest({
      session_id: sessionId,
      provider,
      model: model || 'unknown',
      ip: clientIP,
      input_chars: inputChars,
      output_chars: fullContent.length,
      total_tokens: totalTokens || Math.round(fullContent.length * 1.3),
      response_time_ms: elapsed,
      tokens_per_second: elapsed > 0 ? Math.round((totalTokens / (elapsed / 1000)) * 100) / 100 : 0,
      status: clientDisconnected ? 'client_disconnect' : 'ok',
    });
  } catch (error) {
    if (!clientDisconnected && !res.writableEnded) {
      sendEvent('error', { message: error.message || 'Stream error' });
      sendEvent('done', {});
    }
    const elapsed = Date.now() - startTime;
    db.logRequest({
      session_id: sessionId,
      provider,
      model: model || 'unknown',
      ip: clientIP,
      input_chars: inputChars,
      output_chars: 0,
      total_tokens: 0,
      response_time_ms: elapsed,
      tokens_per_second: 0,
      status: 'error: ' + (error.message || '').slice(0, 50),
    });
  } finally {
    // Safe cleanup
    if (!res.writableEnded) {
      try {
        res.end();
      } catch (err) {
        // Connection already closed, ignore
      }
    }
  }
}));

app.get('/api/token-usage', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const daily = db.getDailyUsage(today);
  const limit = config.tokens.dailyLimit;
  const remaining = Math.max(0, limit - daily.total);
  const percent = Math.min(100, ((daily.total / limit) * 100));
  const history = db.getUsageHistory(30);

  res.json({
    today: {
      total: daily.total,
      cost: daily.cost,
      limit,
      remaining,
      percent: Math.round(percent * 100) / 100,
      providers: daily.providers,
      models: daily.models,
    },
    history: history.map(h => ({ date: h.date, total: h.total, cost: h.cost })),
  });
});

app.get('/api/tools', (req, res) => {
  res.json({ tools: getToolDefinitions() });
});

app.post('/api/tools/execute', asyncHandler(async (req, res) => {
  const { name, args } = req.body;
  if (!name || !args) return res.status(400).json({ error: 'name and args required' });
  const result = await executeTool(name, args);
  res.json({ name, args, result });
}));

app.get('/api/providers', (req, res) => {
  const providers = providerRegistry.getProviders();
  const safe = {};
  for (const [name, prov] of Object.entries(providers)) {
    safe[name] = { ...prov, apiKey: prov.apiKey ? '••••••' + prov.apiKey.slice(-4) : null };
  }
  res.json({ providers: safe });
});

app.post('/api/providers/test', asyncHandler(async (req, res) => {
  const { baseUrl, apiKey, model, format } = req.body;
  if (!baseUrl || !apiKey || !model) return res.status(400).json({ success: false, error: 'baseUrl, apiKey, and model required' });
  const result = await providerRegistry.testProviderConnection(baseUrl, apiKey, model, { format });
  res.json(result);
}));

app.post('/api/providers', asyncHandler(async (req, res) => {
  const { name, ...provConfig } = req.body;
  if (!name || !provConfig.baseUrl || !provConfig.apiKey) {
    return res.status(400).json({ success: false, error: 'name, baseUrl, and apiKey required' });
  }
  const result = await providerRegistry.addProvider(name, provConfig);
  res.status(result.success ? 201 : 400).json(result);
}));

app.delete('/api/providers/:name', (req, res) => {
  const result = providerRegistry.removeProvider(req.params.name);
  res.json(result);
});

app.post('/api/providers/:name/models', asyncHandler(async (req, res) => {
  const { modelId, modelLabel } = req.body;
  if (!modelId) return res.status(400).json({ success: false, error: 'modelId required' });
  const result = await providerRegistry.addModel(req.params.name, modelId, modelLabel);
  res.status(result.success ? 201 : 400).json(result);
}));

app.delete('/api/providers/:name/models/:modelId', (req, res) => {
  const result = providerRegistry.removeModel(req.params.name, req.params.modelId);
  res.json(result);
});

app.get('/api/models', (req, res) => {
  const registryModels = providerRegistry.getAllModels();
  res.json({
    builtin: {
      nvidia: config.nvidia.models.map(m => ({ id: m.id, provider: 'nvidia' })),
      puter: config.puter.models.map(m => ({ id: m.id, provider: 'puter' })),
    },
    custom: registryModels,
  });
});

app.get('/api/analytics', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  res.json(db.getAnalytics(hours));
});

app.post('/api/chat/rag', rateLimiters.rag, asyncHandler(async (req, res) => {
  if (!ragEngine.initialized) {
    return res.status(400).json({ success: false, error: 'RAG tidak diaktifkan. Set RAG_ENABLED=true dan rebuild index.' });
  }

  const { query, maxResults } = req.body;
  if (!query) return res.status(400).json({ success: false, error: 'query required' });

  const results = ragEngine.retrieve(query, { maxResults: maxResults || 10 });
  res.json({ success: true, query, results });
}));

app.post('/api/rag/query', rateLimiters.rag, asyncHandler(async (req, res) => {
  if (!ragEngine.initialized) {
    return res.status(400).json({ success: false, error: 'RAG belum di-index. Panggil POST /api/rag/reindex dulu.' });
  }

  const { query, maxResults } = req.body;
  if (!query) return res.status(400).json({ success: false, error: 'query required' });

  const results = ragEngine.retrieve(query, { maxResults: maxResults || 5 });
  const context = ragEngine.buildRAGContext(query, maxResults || 5);

  res.json({
    success: true,
    query,
    results,
    context,
    stats: ragEngine.getStats(),
  });
}));

app.post('/api/rag/reindex', asyncHandler(async (req, res) => {
  const { workspaceDir } = req.body;
  ragEngine.enabled = true;
  const result = await ragEngine.reindex(workspaceDir);
  coordinator.invalidateCache('rag:*');
  contextCache.invalidateByPrefix('rag');
  coordinator.broadcast({ type: 'reindex', files: result.files, chunks: result.chunks });
  res.json({ success: !result.error, ...result });
}));

app.get('/api/rag/status', (req, res) => {
  res.json(ragEngine.getStats());
});

app.post('/api/rag/codegraph', asyncHandler(async (req, res) => {
  const { filePath } = req.body;
  if (filePath) {
    res.json({
      dependencies: ragEngine.indexer.codeGraph?.getDependencies(filePath) || [],
      dependents: ragEngine.indexer.codeGraph?.getDependents(filePath) || [],
      functions: ragEngine.indexer.codeGraph?.getFunctions(filePath) || [],
      classes: ragEngine.indexer.codeGraph?.getClasses(filePath) || [],
      related: ragEngine.indexer.codeGraph?.getRelatedFiles(filePath, 1) || [],
      graph: {
        depCount: graphStore ? graphStore.getStats().totalEdges : 0,
      },
    });
  } else {
    res.json(ragEngine.getCodeGraph());
  }
}));

app.get('/api/rag/graph/stats', (req, res) => {
  res.json(graphStore.getStats());
});

app.get('/api/rag/graph/symbols', (req, res) => {
  const { name, pattern } = req.query;
  if (name) {
    res.json(graphStore.findSymbol(name));
  } else if (pattern) {
    res.json(graphStore.searchSymbols(pattern, parseInt(req.query.limit) || 20));
  } else {
    res.json(graphStore.getStats());
  }
});

app.get('/api/rag/graph/related', (req, res) => {
  const { filePath, depth } = req.query;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  const related = graphStore.getRelatedFiles(filePath, parseInt(depth) || 1);
  const dependencies = graphStore.getDependencies(filePath);
  const dependents = graphStore.getDependents(filePath);
  res.json({ filePath, related, dependencies, dependents });
});

app.get('/api/rag/graph/shortest-path', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const path = graphStore.shortestPath(from, to);
  res.json({ from, to, path, length: path ? path.length : 0 });
});

app.get('/api/rag/graph/components', (req, res) => {
  const components = graphStore.findConnectedComponents();
  res.json({
    total: components.length,
    components: components.map((c, i) => ({
      index: i,
      size: c.length,
      files: c.map(n => n.rel_path || n.file_path),
    })),
  });
});

app.get('/api/rag/git', (req, res) => {
  res.json(ragEngine.getGitInfo());
});

app.get('/api/rag/git/diff', (req, res) => {
  const base = req.query.base || 'HEAD';
  res.json(ragEngine.git.getDiff({ base }));
});

app.get('/api/rag/git/branch-diff', (req, res) => {
  const target = req.query.target || 'main';
  res.json(ragEngine.git.getBranchDiff(target));
});

app.get('/api/rag/git/log', (req, res) => {
  const count = parseInt(req.query.count) || 10;
  res.json(ragEngine.git.getLog(count));
});

app.delete('/api/rag/index', (req, res) => {
  ragEngine.indexer.clear();
  res.json({ success: true, message: 'RAG index cleared' });
});

app.get('/api/health', (req, res) => {
  const limitCheck = checkTokenLimit();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    tokenLimitReached: limitCheck.blocked,
    providers: {
      openagentic: { available: aiManager.openagenticProvider.isAvailable(), configured: Boolean(config.openagentic.apiKey) },
      nvidia: { available: aiManager.nvidiaProvider.isAvailable(), keyCount: aiManager.nvidiaProvider.getKeyCount?.() || 1 },
    },
    context: {
      maxTurns: config.context?.maxTurns || 20,
    },
    rag: ragEngine.getStats(),
    cluster: coordinator.redisAvailable ? { instances: coordinator.getInstanceCount(), redisConnected: true } : { standalone: true },
  });
});

app.get('/api/cluster', (req, res) => {
  const stats = coordinator.getStats();
  res.json({
    instanceId: stats.instanceId,
    mode: stats.redisAvailable ? 'distributed' : 'standalone',
    instances: stats.instances,
    instanceList: stats.instanceList,
    redis: stats.redisUrl,
  });
});

app.post('/api/cluster/broadcast', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  coordinator.broadcast(message);
  res.json({ success: true, instanceId: coordinator.instanceId, message });
});

app.get('/api/cluster/cache/flush', (req, res) => {
  coordinator.invalidateCache('*');
  contextCache.flushAll();
  res.json({ success: true, message: 'Cache invalidated across cluster' });
});

app.get('/api/cache/stats', (req, res) => {
  res.json(contextCache.getStats());
});

app.post('/api/cache/flush', (req, res) => {
  const { prefix } = req.body;
  if (prefix) {
    const count = contextCache.invalidateByPrefix(prefix);
    res.json({ success: true, invalidated: count, prefix });
  } else {
    contextCache.flushAll();
    res.json({ success: true, message: 'All cache flushed' });
  }
});

app.post('/api/auth/google', asyncHandler(async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ success: false, error: 'idToken required' });
  const result = await auth.loginWithGoogle(idToken);
  res.status(result.success ? 200 : 401).json(result);
}));

app.post('/api/auth/api-key', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ success: false, error: 'apiKey required' });
  const user = db.getUserByApiKey(apiKey);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid API key' });
  const jwtToken = jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    process.env.JWT_SECRET || 'wanar-ai-jwt-secret-change-in-production',
    { expiresIn: '7d' }
  );
  res.json({ success: true, token: jwtToken, user });
});

app.get('/api/auth/profile', auth.authMiddleware, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, user });
});

app.get('/api/auth/admin/users', auth.authMiddleware, auth.adminOnly, (req, res) => {
  const users = db.getAllUsers();
  res.json({ success: true, users });
});

app.patch('/api/auth/admin/users/:id/role', auth.authMiddleware, auth.adminOnly, (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin', 'superadmin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  db.updateUserRole(parseInt(req.params.id), role);
  res.json({ success: true });
});

// ==================== ANALYTICS API ENDPOINTS ====================

// GET /api/analytics/summary - Total summary (requests, tokens, cost, avg response time)
app.get('/api/analytics/summary', (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const summary = db.getAnalyticsSummary(days);
  res.json({ success: true, data: summary });
});

// GET /api/analytics/daily - Daily usage data for charts
app.get('/api/analytics/daily', (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const dailyData = db.getAnalyticsDailyUsage(days);
  res.json({ success: true, data: dailyData });
});

// GET /api/analytics/by-model - Breakdown by model
app.get('/api/analytics/by-model', (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const modelData = db.getAnalyticsByModel(days);
  res.json({ success: true, data: modelData });
});

// GET /api/analytics/by-provider - Breakdown by provider
app.get('/api/analytics/by-provider', (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const providerData = db.getAnalyticsByProvider(days);
  res.json({ success: true, data: providerData });
});

// GET /api/analytics/logs - Detailed logs with filters
app.get('/api/analytics/logs', (req, res) => {
  const filters = {
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    model: req.query.model,
    provider: req.query.provider,
    limit: parseInt(req.query.limit) || 100,
    offset: parseInt(req.query.offset) || 0
  };
  
  const logs = db.getAnalyticsLogs(filters);
  res.json({ success: true, data: logs });
});

// GET /api/analytics/models - Get list of available models for filter
app.get('/api/analytics/models', (req, res) => {
  const models = db.getAnalyticsModels();
  res.json({ success: true, data: models });
});

// GET /api/analytics/providers - Get list of available providers for filter
app.get('/api/analytics/providers', (req, res) => {
  const providers = db.getAnalyticsProviders();
  res.json({ success: true, data: providers });
});

// GET /api/analytics/export - Export to CSV
app.get('/api/analytics/export', (req, res) => {
  const filters = {
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    model: req.query.model,
    provider: req.query.provider,
    limit: 10000 // Max 10k rows for CSV
  };
  
  const logs = db.getAnalyticsLogs(filters);
  
  // Convert to CSV
  const csvHeader = 'Waktu,Model,Provider,Input Tokens,Output Tokens,Total Tokens,Response Time (ms),Status\n';
  const csvRows = logs.map(log => {
    const inputTokens = Math.round(log.total_tokens * 0.4); // Rough estimate
    const outputTokens = log.total_tokens - inputTokens;
    return `${log.created_at},${log.model},${log.provider},${inputTokens},${outputTokens},${log.total_tokens},${log.response_time_ms},${log.status}`;
  }).join('\n');
  
  const csv = csvHeader + csvRows;
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="wanar-ai-analytics-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.get('/api/auth/me', auth.authMiddleware, (req, res) => {
  const user = db.getUserById(req.user.id);
  const todayUsage = db.getUserTokensToday(req.user.id);
  const teams = enterprise.getTeamsByUser(req.user.id);
  res.json({
    success: true,
    user,
    usage: { today: todayUsage, limit: auth.getUserDailyLimit() },
    teams,
  });
});

app.get('/api/teams', enterprise.authMiddleware, asyncHandler(async (req, res) => {
  const teams = enterprise.getTeamsByUser(req.user.id);
  res.json({ teams });
}));

app.post('/api/teams', enterprise.authMiddleware, asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Team name required' });
  const team = enterprise.createTeam(name, req.user.id);
  res.json({ success: true, team });
}));

app.get('/api/teams/:teamId', enterprise.authMiddleware, enterprise.requireTeamRole('viewer'), asyncHandler(async (req, res) => {
  const team = enterprise.getTeam(parseInt(req.params.teamId));
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const stats = enterprise.getTeamStats(parseInt(req.params.teamId));
  res.json({ team, stats });
}));

app.patch('/api/teams/:teamId', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  const { name } = req.body;
  enterprise.updateTeam(parseInt(req.params.teamId), { name });
  res.json({ success: true });
}));

app.delete('/api/teams/:teamId', enterprise.authMiddleware, enterprise.requireTeamRole('owner'), asyncHandler(async (req, res) => {
  enterprise.deleteTeam(parseInt(req.params.teamId));
  res.json({ success: true });
}));

app.get('/api/teams/:teamId/members', enterprise.authMiddleware, enterprise.requireTeamRole('viewer'), asyncHandler(async (req, res) => {
  const members = enterprise.getTeamMembers(parseInt(req.params.teamId));
  res.json({ members });
}));

app.post('/api/teams/:teamId/members', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  const { userId, role } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const result = enterprise.addTeamMember(parseInt(req.params.teamId), userId, role || 'member');
  res.json({ success: true, ...result });
}));

app.delete('/api/teams/:teamId/members/:userId', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  enterprise.removeTeamMember(parseInt(req.params.teamId), parseInt(req.params.userId));
  res.json({ success: true });
}));

app.get('/api/teams/:teamId/workspaces', enterprise.authMiddleware, enterprise.requireTeamRole('viewer'), asyncHandler(async (req, res) => {
  const workspaces = enterprise.getWorkspaces(parseInt(req.params.teamId));
  res.json({ workspaces });
}));

app.post('/api/teams/:teamId/workspaces', enterprise.authMiddleware, enterprise.requireTeamRole('editor'), asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Workspace name required' });
  const ws = enterprise.createWorkspace(parseInt(req.params.teamId), name, req.user.id);
  res.json({ success: true, workspace: ws });
}));

app.delete('/api/teams/:teamId/workspaces/:wsId', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  enterprise.deleteWorkspace(parseInt(req.params.wsId));
  res.json({ success: true });
}));

app.get('/api/teams/:teamId/keys', enterprise.authMiddleware, enterprise.requireTeamRole('viewer'), asyncHandler(async (req, res) => {
  const keys = enterprise.getApiKeys(parseInt(req.params.teamId));
  res.json({ keys });
}));

app.post('/api/teams/:teamId/keys', enterprise.authMiddleware, enterprise.requireTeamRole('editor'), asyncHandler(async (req, res) => {
  const { name, permissions } = req.body;
  const result = enterprise.createApiKey(parseInt(req.params.teamId), req.user.id, name || 'default', permissions);
  res.json({ success: true, key: result });
}));

app.delete('/api/teams/:teamId/keys/:keyId', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  enterprise.revokeApiKey(parseInt(req.params.keyId), parseInt(req.params.teamId));
  res.json({ success: true });
}));

app.post('/api/teams/:teamId/keys/:keyId/rotate', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  const { name } = req.body;
  const result = enterprise.rotateApiKey(parseInt(req.params.keyId), parseInt(req.params.teamId), name);
  if (!result) return res.status(404).json({ error: 'API key not found' });
  res.json({ success: true, key: result });
}));

app.get('/api/teams/:teamId/usage', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const usage = enterprise.getTeamUsage(parseInt(req.params.teamId), days);
  res.json({ usage, teamId: parseInt(req.params.teamId), days });
}));

// ============================================
// SECURITY TESTING API ENDPOINTS
// by Wisnu Alfian Nur Ashar
// ============================================

app.post('/api/security/scan', asyncHandler(async (req, res) => {
  const { target, scanType, modules, aggressive } = req.body;
  
  if (!target) {
    return res.status(400).json({ success: false, error: 'Target URL required' });
  }

  try {
    const result = await securityScanner.scanVulnerabilities(
      target,
      scanType || 'quick',
      modules || ['sqli', 'xss', 'csrf', 'security_headers', 'ssl']
    );

    res.json({ success: true, results: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.post('/api/security/auth-test', asyncHandler(async (req, res) => {
  const { target, username, password, testTypes } = req.body;
  
  if (!target) {
    return res.status(400).json({ success: false, error: 'Target URL required' });
  }

  try {
    const result = await securityScanner.testAuthentication(
      target,
      username || 'admin',
      testTypes || ['bruteforce', 'bypass', 'session_hijack']
    );

    res.json({ success: true, results: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.post('/api/security/code-audit', asyncHandler(async (req, res) => {
  const { path: codePath, language, checks, severity } = req.body;
  
  if (!codePath) {
    return res.status(400).json({ success: false, error: 'Code path required' });
  }

  try {
    const result = await securityScanner.auditCode(codePath);

    res.json({ success: true, results: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.post('/api/security/dependency-scan', asyncHandler(async (req, res) => {
  const { path: projectPath, includeDevDeps, fixable } = req.body;

  try {
    const result = await securityScanner.scanDependencies();

    res.json({ success: true, results: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Realtime Security Scan via SSE
app.post('/api/security/scan/stream', asyncHandler(async (req, res) => {
  const { target, scanType, modules } = req.body;

  if (!target) {
    return res.status(400).json({ success: false, error: 'Target URL required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientDisconnected = false;

  req.on('close', () => { clientDisconnected = true; });
  req.on('error', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') clientDisconnected = true;
  });

  const sendEvent = (event, data) => {
    if (clientDisconnected || res.writableEnded) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch (err) {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
        clientDisconnected = true;
      }
      return false;
    }
  };

  try {
    const stream = securityScanner.streamScanVulnerabilities(
      target,
      scanType || 'deep',
      modules || ['sqli', 'xss', 'csrf', 'security_headers', 'ssl'],
      aiManager
    );

    for await (const chunk of stream) {
      if (clientDisconnected) break;

      if (chunk.type === 'vulnerability') {
        sendEvent('vulnerability', chunk);
      } else if (chunk.type === 'progress') {
        sendEvent('progress', chunk);
      } else if (chunk.type === 'check_pass') {
        sendEvent('check_pass', chunk);
      } else if (chunk.type === 'check_error') {
        sendEvent('check_error', chunk);
      } else if (chunk.type === 'target_info') {
        sendEvent('target_info', chunk);
      } else if (chunk.type === 'scan_start') {
        sendEvent('scan_start', chunk);
      } else if (chunk.type === 'ai_analysis') {
        sendEvent('ai_analysis', chunk);
      } else if (chunk.type === 'scan_complete') {
        sendEvent('scan_complete', chunk);
      } else if (chunk.type === 'scan_error') {
        sendEvent('scan_error', chunk);
      }
    }

    if (!clientDisconnected && !res.writableEnded) {
      sendEvent('stream_end', {});
    }
  } catch (error) {
    if (!clientDisconnected && !res.writableEnded) {
      sendEvent('scan_error', { message: error.message });
    }
  } finally {
    if (!res.writableEnded) {
      try { res.end(); } catch (err) {}
    }
  }
}));

// AI Analysis for Security Scan Results
app.post('/api/security/analyze', asyncHandler(async (req, res) => {
  const { vulnerabilities, target } = req.body;

  if (!vulnerabilities || !Array.isArray(vulnerabilities)) {
    return res.status(400).json({ success: false, error: 'Vulnerabilities array required' });
  }

  try {
    const analysis = await securityScanner.analyzeScanResultsWithAI(vulnerabilities, target, aiManager);
    res.json({ success: true, analysis });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// AI Chat for Security - uses DeepSeek/NVIDIA for contextual analysis
app.post('/api/security/ai-advice', asyncHandler(async (req, res) => {
  const { vulnerability, target, question } = req.body;

  if (!vulnerability) {
    return res.status(400).json({ success: false, error: 'Vulnerability data required' });
  }

  try {
    const result = await securityScanner.aiDeepQuery(vulnerability, target, question || '', aiManager);
    if (result._aiGenerated) {
      res.json({ success: true, analysis: result.analysis });
    } else {
      const fallback = await securityScanner.analyzeScanResultsWithAI([vulnerability], target, aiManager);
      const av = fallback.attackVectors?.[0] || {};
      const answer = `## AI Security Analysis: ${vulnerability.type}

### Cara Kerja Attack
${av.howItWorks || 'Attacker mengeksploitasi celah ini untuk mengompromikan sistem.'}

### Dampak
${av.impact || 'Dapat menyebabkan kebocoran data atau kompromi sistem.'}

### Prioritas
${av.priority || 'P2 - Fix in current sprint'}

### Langkah Remediasi
${vulnerability.recommendation || 'Apply security patches and follow best practices.'}

### Detail
${vulnerability.description}
${vulnerability.evidence ? '\n**Evidence:** ' + vulnerability.evidence.join(', ') : ''}
${vulnerability.cvss ? '\n**CVSS:** ' + vulnerability.cvss + '/10' : ''}`;
      res.json({ success: true, analysis: answer });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// ==================== JOB AGENT ENDPOINTS ====================

// GET /api/job-agent/sessions — list semua sesi
app.get('/api/job-agent/sessions', (req, res) => {
  const sessions = db.getJobSessions();
  const activeIds = jobAgent.getActiveSessionIds();
  res.json({ success: true, sessions, activeIds });
});

// POST /api/job-agent/sessions — buat sesi baru
app.post('/api/job-agent/sessions', asyncHandler(async (req, res) => {
  const { name, source_url, settings } = req.body;
  if (!source_url) return res.status(400).json({ success: false, error: 'source_url wajib diisi' });
  const session = db.createJobSession(name || 'Job Scan Session', source_url, settings || {});
  res.json({ success: true, session });
}));

// GET /api/job-agent/sessions/:id — detail sesi + stats
app.get('/api/job-agent/sessions/:id', (req, res) => {
  const session = db.getJobSession(Number(req.params.id));
  if (!session) return res.status(404).json({ success: false, error: 'Session tidak ditemukan' });
  const stats = db.getJobQueueStats();
  const activeIds = jobAgent.getActiveSessionIds();
  res.json({ success: true, session, stats, isActive: activeIds.includes(req.params.id) });
});

// POST /api/job-agent/sessions/:id/start — mulai crawl & apply
app.post('/api/job-agent/sessions/:id/start', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { trustedMode = false, headless = false } = req.body || {};
  res.json({ success: true, message: 'Session dimulai', sessionId: id });
  // Run async — tidak block response
  jobAgent.startJobSession(id, { trustedMode, headless }).catch(err => {
    console.error('[job-agent] session error:', err.message, err.stack);
  });
}));

// POST /api/job-agent/sessions/:id/stop — hentikan sesi
app.post('/api/job-agent/sessions/:id/stop', (req, res) => {
  const stopped = jobAgent.stopJobSession(Number(req.params.id));
  res.json({ success: true, stopped });
});

// POST /api/job-agent/launch-chrome — launch Chrome dengan CDP remote debugging
// Agar agent bisa connect ke Chrome yang sudah login via CDP
app.post('/api/job-agent/launch-chrome', asyncHandler(async (req, res) => {
  const { execSync, spawn } = await import('child_process');

  // Cek apakah CDP sudah aktif
  try {
    const cdpRes = await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(1500) });
    if (cdpRes.ok) {
      return res.json({ success: true, message: 'Chrome CDP sudah aktif di port 9222', alreadyRunning: true });
    }
  } catch {}

  // Cari path Chrome
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  let chromePath = null;
  for (const p of chromePaths) {
    try { execSync(`if exist "${p}" echo found`, { shell: true }).toString().includes('found') && (chromePath = p); } catch {}
    if (chromePath) break;
  }
  // Fallback: cari via registry
  if (!chromePath) {
    try {
      const reg = execSync('reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve', { shell: true }).toString();
      const match = reg.match(/REG_SZ\s+(.+\.exe)/);
      if (match) chromePath = match[1].trim();
    } catch {}
  }

  if (!chromePath) {
    return res.status(404).json({ success: false, message: 'Chrome tidak ditemukan. Install Google Chrome terlebih dahulu.' });
  }

  // Launch Chrome dengan CDP flag
  const userDataDir = `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Google\\Chrome\\User Data`;
  spawn(chromePath, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: 'ignore' }).unref();

  // Tunggu Chrome ready
  let ready = false;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 800));
    try {
      const check = await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(1000) });
      if (check.ok) { ready = true; break; }
    } catch {}
  }

  if (ready) {
    res.json({ success: true, message: 'Chrome berhasil diluncurkan dengan CDP di port 9222. Agent akan menggunakan Chrome yang sudah login.' });
  } else {
    res.json({ success: false, message: 'Chrome diluncurkan tapi CDP belum merespons. Coba lagi dalam beberapa detik.' });
  }
}));

// DELETE /api/job-agent/sessions/:id — hapus sesi dan semua job-nya
app.delete('/api/job-agent/sessions/:id', (req, res) => {
  const id = Number(req.params.id);
  jobAgent.stopJobSession(id); // pastikan stop dulu jika sedang running
  db.deleteJobSession(id);
  res.json({ success: true });
});

// GET /api/job-agent/queue — daftar job di queue
app.get('/api/job-agent/queue', (req, res) => {
  const { status, limit = 100, offset = 0 } = req.query;
  const jobs = db.getJobQueue(status || null, Number(limit), Number(offset));
  const stats = db.getJobQueueStats();
  res.json({ success: true, jobs, stats });
});

// PATCH /api/job-agent/queue/:id — update status job manual
app.patch('/api/job-agent/queue/:id', asyncHandler(async (req, res) => {
  const { status, notes } = req.body;
  const updated = db.updateJobStatus(Number(req.params.id), status, { notes });
  res.json({ success: true, job: updated });
}));

// GET /api/job-agent/review — review queue (needs_review)
app.get('/api/job-agent/review', (req, res) => {
  const { status = 'pending' } = req.query;
  const items = db.getReviewQueue(status);
  res.json({ success: true, items });
});

// POST /api/job-agent/review/:id/approve — approve review item
app.post('/api/job-agent/review/:id/approve', asyncHandler(async (req, res) => {
  const { editedMapping } = req.body || {};
  const item = db.updateReviewItem(Number(req.params.id), 'approved', editedMapping || null);
  // Update job status ke submitted
  if (item) db.updateJobStatus(item.job_id, 'submitted', { notes: 'Approved dari review queue' });
  res.json({ success: true, item });
}));

// POST /api/job-agent/review/:id/reject — reject review item
app.post('/api/job-agent/review/:id/reject', asyncHandler(async (req, res) => {
  const item = db.updateReviewItem(Number(req.params.id), 'rejected');
  if (item) db.updateJobStatus(item.job_id, 'rejected', { notes: 'Ditolak dari review queue' });
  res.json({ success: true, item });
}));

// POST /api/job-agent/crawl — crawl URL sekarang (preview tanpa start session)
app.post('/api/job-agent/crawl', asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'url wajib diisi' });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const jobs = await jobAgent.crawlListingPage(url, page);
    res.json({ success: true, count: jobs.length, jobs: jobs.slice(0, 50) });
  } finally {
    await browser.close().catch(() => {});
  }
}));

// DELETE /api/job-agent/queue — clear semua queue
app.delete('/api/job-agent/queue', (req, res) => {
  db.clearJobQueue();
  res.json({ success: true, message: 'Queue dibersihkan' });
});

// GET /api/job-agent/sessions/:id/live — SSE live feed
app.get('/api/job-agent/sessions/:id/live', (req, res) => {
  const sessionId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial ping
  send({ type: 'connected', sessionId });

  const handler = (event) => {
    if (event.sessionId === sessionId) {
      send(event);
    }
  };

  agentEvents.on('event', handler);

  // Heartbeat every 15s to keep connection alive
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  req.on('close', () => {
    clearInterval(hb);
    agentEvents.off('event', handler);
  });
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/assets/')) return;
  const indexPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  }
});

// Deep Attack Stream - Professional Pentest
app.post('/api/security/attack/stream', asyncHandler(async (req, res) => {
  const { target, scanType } = req.body;

  if (!target) {
    return res.status(400).json({ success: false, error: 'Target URL required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientDisconnected = false;
  req.on('close', () => { clientDisconnected = true; });
  req.on('error', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') clientDisconnected = true;
  });

  const sendEvent = (event, data) => {
    if (clientDisconnected || res.writableEnded) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch { return false; }
  };

  try {
    const { options } = req.body;
    const stream = securityScanner.deepAttackStream(target, scanType || 'deep', options || {}, aiManager);

    for await (const chunk of stream) {
      if (clientDisconnected) break;

      if (chunk.type === 'payload_test') sendEvent('payload_test', chunk);
      else if (chunk.type === 'cloudflare_detected') sendEvent('cloudflare_detected', chunk);
      else if (chunk.type === 'vulnerability_confirmed') sendEvent('vulnerability_confirmed', chunk);
      else if (chunk.type === 'attack_fake') sendEvent('attack_fake', chunk);
      else if (chunk.type === 'progress') sendEvent('progress', chunk);
      else if (chunk.type === 'evidence') sendEvent('evidence', chunk);
      else if (chunk.type === 'ai_guidance') sendEvent('ai_guidance', chunk);
      else if (chunk.type === 'attack_start') sendEvent('attack_start', chunk);
      else if (chunk.type === 'attack_complete') sendEvent('attack_complete', chunk);
      else if (chunk.type === 'attack_error') sendEvent('attack_error', chunk);
      else if (chunk.type === 'exploit_chains') sendEvent('exploit_chains', chunk);
      else if (chunk.type === 'compliance') sendEvent('compliance', chunk);
      else if (chunk.type === 'ddos_start') sendEvent('ddos_start', chunk);
      else if (chunk.type === 'ddos_progress') sendEvent('ddos_progress', chunk);
      else if (chunk.type === 'ddos_complete') sendEvent('ddos_complete', chunk);
      else if (chunk.type === 'bruteforce_complete') sendEvent('bruteforce_complete', chunk);
      else if (chunk.type === 'exploitation') sendEvent('exploitation', chunk);
      else if (chunk.type === 'exploitation_complete') sendEvent('exploitation_complete', chunk);
    }

    if (!clientDisconnected && !res.writableEnded) sendEvent('stream_end', {});
  } catch (error) {
    if (!clientDisconnected && !res.writableEnded) sendEvent('attack_error', { message: error.message });
  } finally {
    if (!res.writableEnded) { try { res.end(); } catch {} }
  }
}));

// Generate Professional Bug Bounty Report
app.post('/api/security/report', asyncHandler(async (req, res) => {
  const { vulnerabilities, fake, target, dnsInfo, techStack, aiGuidance, compliance, format } = req.body;

  if (!vulnerabilities || !Array.isArray(vulnerabilities)) {
    return res.status(400).json({ success: false, error: 'Vulnerabilities array required' });
  }

  try {
    const report = securityScanner.generateProfessionalReport(
      vulnerabilities,
      fake || [],
      target || 'Unknown',
      dnsInfo || {},
      techStack || {},
      aiGuidance || null,
      compliance || null
    );

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(report.htmlReport);
    } else if (format === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(report.rawReport);
    } else {
      res.json({ success: true, report });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Professional Attack: Data Extraction
app.post('/api/security/professional/extract', asyncHandler(async (req, res) => {
  const { target } = req.body;
  if (!target) return res.status(400).json({ success: false, error: 'Target required' });

  try {
    const extraction = await securityScanner.performDeepExtraction(target);
    res.json({ success: true, ...extraction });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Compliance Report Endpoint
app.post('/api/security/compliance', asyncHandler(async (req, res) => {
  const { vulnerabilities } = req.body;
  if (!vulnerabilities || !Array.isArray(vulnerabilities)) {
    return res.status(400).json({ success: false, error: 'Vulnerabilities array required' });
  }
  try {
    const compliance = securityScanner.generateComplianceReport(vulnerabilities);
    res.json({ success: true, compliance });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Send Notification (Email / WhatsApp)
app.post('/api/security/notify', asyncHandler(async (req, res) => {
  const { target, vulnerabilities, fake, type, contact } = req.body;

  if (!target) {
    return res.status(400).json({ success: false, error: 'Target required' });
  }

  try {
    const report = securityScanner.generateProfessionalReport(
      vulnerabilities || [], fake || [], target, {}, {}, null, null
    );

    if (type === 'email') {
      const emailContent = securityScanner.generateEmailContent(report, contact || 'security@target.com');
      // In production, integrate with nodemailer / SendGrid / SMTP
      // For now, return the email content for preview
      res.json({
        success: true,
        notificationType: 'email',
        preview: {
          to: emailContent.to,
          subject: emailContent.subject,
          html: emailContent.html,
        },
        message: 'Email notification ready. Configure SMTP in production.',
      });
    } else if (type === 'whatsapp') {
      const waContent = securityScanner.generateWhatsAppMessage(report);
      // In production, integrate with WhatsApp Business API
      res.json({
        success: true,
        notificationType: 'whatsapp',
        preview: { message: waContent.message },
        message: 'WhatsApp notification ready. Configure WhatsApp API in production.',
      });
    } else {
      res.json({
        success: true,
        email: securityScanner.generateEmailContent(report, contact),
        whatsapp: securityScanner.generateWhatsAppMessage(report),
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

async function startServer() {
  console.log('[DEBUG] Starting server...');
  try {
    console.log('[DEBUG] Initializing coordinator...');
    const clusterInfo = await coordinator.initialize();
    console.log('[DEBUG] Coordinator initialized');
    if (clusterInfo.redisAvailable) {
      coordinator.onNotify((data) => {
        if (data?.message?.type === 'reindex') {
          console.log(`[CLUSTER] Peer reindexed: ${data.message.files} files`);
        }
      });
    }
  } catch (err) {
    console.log(`[CLUSTER] Coordinator init skipped: ${err.message}`);
  }

  console.log('[DEBUG] About to call app.listen...');
  app.listen(PORT, () => {
    console.log('[DEBUG] app.listen callback triggered!');
  console.log('\n' + '='.repeat(60));
  console.log('                    WANAR AI v2.0');
  console.log('              Enterprise Multi-Provider AI');
  console.log('='.repeat(60) + '\n');
  console.log(`Server    : http://localhost:${PORT}`);
  console.log(`Token/day : ${(config.tokens.dailyLimit / 1e6).toLocaleString()}M`);
  console.log(`Cost/day  : $${config.tokens.dailyCostLimit}`);
  console.log(`Providers : OpenAgentic (${config.openagentic.models?.length || 0} models), NVIDIA (${config.nvidia.apiKeys?.length || 1} keys), Vector, Puter.js`);
  console.log(`Context   : ${config.context?.maxTurns || 20} max turns, ${(config.context?.maxContextTokens || 131072) / 1000}k tokens`);
  console.log(`Database  : SQLite (WAL mode)`);
  console.log(`Security  : Helmet + CORS + Rate-Limit`);
  console.log(`Streaming : SSE enabled`);
  console.log(`RAG       : ${config.rag?.enabled ? 'Enabled' : 'Disabled'}\n`);
  console.log('Press Ctrl+C to stop\n');
  console.log(`Cluster   : ${coordinator.redisAvailable ? `Distributed (${coordinator.getInstanceCount()} instances)` : 'Standalone'}\n`);
  });
}

export default app;

startServer();
