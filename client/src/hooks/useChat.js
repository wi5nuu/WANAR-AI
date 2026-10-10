import { useState, useRef, useCallback } from 'react';

const IDLE_FLOW = {
  stage: 'idle',
  activeTool: null,
  steps: [],
  startedAt: null,
  finishedAt: null,
  error: null,
  activeProvider: null,
  activeModel: null,
  switches: [],
};

export function useChat(saveSession) {
  const [messages, setMessages] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState({ color: 'var(--gr)', text: 'Ready' });
  const [agentFlow, setAgentFlow] = useState(IDLE_FLOW);
  const abRef = useRef(null);

  const addMessage = useCallback((role, content, attachments, opts = {}) => {
    setMessages(prev => [...prev, {
      role,
      content,
      attachments,
      // Placeholder assistant: tanpa timestamp dulu — diisi saat token pertama tiba.
      timestamp: opts.deferTimestamp ? null : Date.now(),
    }]);
  }, []);

  const replaceLast = useCallback((role, content) => {
    setMessages(prev => {
      const idx = prev.length - 1;
      if (idx < 0) return [{ role, content, timestamp: Date.now() }];
      const copy = [...prev];
      copy[idx] = { ...copy[idx], content, timestamp: copy[idx].timestamp || Date.now() };
      return copy;
    });
  }, []);

  const send = useCallback(async (provider, model, route, attachments = [], overrideText = null) => {
    // overrideText = teks eksplisit dari InputBar (jalur utama, anti-race).
    // Fallback DOM query hanya untuk kompatibilitas pemanggil lama.
    const domText = document.querySelector('.input-textarea')?.value?.trim() || '';
    const text = overrideText !== null ? String(overrideText).trim() : domText;
    if (!text && attachments.length === 0) return;
    if (processing) return;
    const inputEl = document.querySelector('.input-textarea');
    if (inputEl && overrideText === null) { inputEl.value = ''; inputEl.style.height = 'auto'; }

    setProcessing(true);
    setStatus({ color: 'var(--yl)', text: 'Mengetik...' });
    setAgentFlow({
      ...IDLE_FLOW,
      stage: 'user_input',
      startedAt: Date.now(),
    });
    const history = [...messages];

    // Show user message with attachment info
    const displayContent = text || (attachments.length > 0 ? `[${attachments.length} file(s) attached]` : '');
    addMessage('user', displayContent, attachments.map(f => ({ name: f.name, type: f.type, size: f.size })));
    addMessage('assistant', '', undefined, { deferTimestamp: true });

    setAgentFlow(prev => ({ ...prev, stage: 'thinking' }));

    if (provider === 'puter') {
      await sendPuter(text, attachments, saveSession, setMessages, setStatus, setProcessing, abRef, history, setAgentFlow);
    } else {
      await sendSSE(provider, model, route, text, attachments, saveSession, setMessages, setStatus, setProcessing, abRef, history, setAgentFlow);
    }
  }, [processing, addMessage, messages, saveSession]);

  const stop = useCallback(() => {
    if (abRef.current) { abRef.current.abort(); abRef.current = null; }
    setProcessing(false);
    setStatus({ color: 'var(--gr)', text: 'Ready' });
    setAgentFlow(prev => ({ ...prev, stage: 'stopped', activeTool: null, finishedAt: Date.now() }));
  }, []);

  const clear = useCallback(() => {
    if (processing) return;
    setMessages([]);
    setAgentFlow(IDLE_FLOW);
  }, [processing]);

  const loadMessages = useCallback((msgs) => {
    setMessages(msgs || []);
  }, []);

  const updateMessage = useCallback((index, content) => {
    setMessages(prev => {
      const copy = [...prev];
      if (copy[index]) copy[index] = { ...copy[index], content };
      return copy;
    });
  }, []);

  return { messages, processing, status, agentFlow, send, stop, clear, loadMessages, setStatus, updateMessage };
}

/**
 * Upload files to server and get extracted text content back
 */
const MAX_TOTAL_FILE_CHARS = 150000;
const MAX_PER_FILE_CHARS = 40000;

async function uploadFiles(files) {
  if (!files || files.length === 0) return [];
  const results = [];
  for (const file of files) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const resp = await fetch('/api/upload', { method: 'POST', body: formData });
      let data = null;
      try { data = await resp.json(); } catch { data = null; }
      if (resp.ok && data && data.success !== false) {
        results.push({
          name: file.name,
          type: file.type,
          content: data.content || '',
          preview: data.preview || null,
          pages: data.pages ?? null,
          charCount: data.charCount ?? (data.content || '').length,
          truncated: Boolean(data.truncated),
          engine: data.engine || null,
          imageData: data.imageData || null,
        });
      } else {
        const serverMsg = data?.error || `HTTP ${resp.status}`;
        results.push({ name: file.name, type: file.type, content: `[Gagal membaca ${file.name}: ${serverMsg}]`, preview: null, error: serverMsg });
      }
    } catch (e) {
      results.push({ name: file.name, type: file.type, content: `[Error reading file ${file.name}: ${e.message}]`, preview: null, error: e.message });
    }
  }
  return results;
}

/**
 * Build message content that includes file content for AI context.
 * Batasi total agar tidak melebihi limit backend (200k/req) — potong per file
 * secara adil bila gabungan terlalu besar.
 */
function buildMessageWithFiles(text, fileResults) {
  if (!fileResults || fileResults.length === 0) return text || '';

  let budget = MAX_TOTAL_FILE_CHARS;
  const perFile = Math.min(MAX_PER_FILE_CHARS, Math.floor(MAX_TOTAL_FILE_CHARS / Math.max(1, fileResults.length)));
  const fileParts = fileResults.map(f => {
    let c = f.content || '';
    let note = '';
    if (c.length > perFile) {
      const cut = c.lastIndexOf('\n\n', perFile);
      const at = cut > perFile * 0.5 ? cut : perFile;
      note = `\n...[dipotong untuk chat: ${c.length.toLocaleString('id-ID')} → ${at.toLocaleString('id-ID')} karakter]`;
      c = c.slice(0, at).trimEnd() + note;
    }
    budget -= c.length;
    const meta = f.pages ? ` (${f.pages} hlm, ${(f.charCount ?? c.length).toLocaleString('id-ID')} karakter${f.truncated ? ', dipotong' : ''})` : '';
    if (c) {
      return `\n\n--- File: ${f.name}${meta} ---\n${c}\n--- End of ${f.name} ---`;
    }
    return `\n\n--- File: ${f.name} (binary/unsupported) ---`;
  }).join('');

  let out = (text ? text + '\n' : '') + fileParts;
  // Pengaman terakhir: jangan pernah kirim >180k ke /api/chat
  if (out.length > 180000) {
    out = out.slice(0, 180000).trimEnd() + '\n\n...[pesan dipotong: terlalu panjang]';
  }
  return out;
}

async function sendSSE(provider, model, route, text, attachments, saveSession, setMessages, setStatus, setProcessing, abRef, history, setAgentFlow) {
  const ab = new AbortController();
  abRef.current = ab;

  let messageContent = text;

  // Upload and extract file content if there are attachments
  if (attachments && attachments.length > 0) {
    setStatus({ color: 'var(--yl)', text: 'Membaca file...' });
    const fileResults = await uploadFiles(attachments);
    messageContent = buildMessageWithFiles(text, fileResults);
  }

  const params = new URLSearchParams({ provider, model, route: route || '' });
  let fullContent = '';

  try {
    const resp = await fetch('/api/chat/stream?' + params.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [...(history || []).map(m => ({ role: m.role, content: m.content })), { role: 'user', content: messageContent }],
        stream: true,
      }),
      signal: ab.signal,
    });

    if (!resp.ok) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));

    setStatus({ color: 'var(--yl)', text: 'Mengetik...' });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let currentEvent = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (!json) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(json);
        } catch { continue; }
        const d = parsed;
        currentEvent = currentEvent || 'message';
        if (d.content) {
          fullContent += d.content;
          setMessages(prev => {
            const copy = [...prev];
            if (copy.length) copy[copy.length - 1] = {
              ...copy[copy.length - 1],
              content: fullContent,
              // Jam balasan AI diambil saat token pertama tiba.
              timestamp: copy[copy.length - 1].timestamp || Date.now(),
            };
            return copy;
          });
        }
        if (currentEvent === 'tool_start') {
            setStatus({ color: 'var(--yl)', text: `Menjalankan alat: ${d.name}` });
            setAgentFlow(prev => ({
              ...prev,
              stage: 'tool_running',
              activeTool: { name: d.name, args: d.args, startedAt: Date.now() },
              steps: [...prev.steps, { name: d.name, args: d.args, status: 'running', startedAt: Date.now() }],
            }));
          } else if (currentEvent === 'tool_end') {
            setAgentFlow(prev => {
              const steps = [...prev.steps];
              for (let i = steps.length - 1; i >= 0; i--) {
                if (steps[i].name === d.name && steps[i].status === 'running') {
                  const failed = d.result && (d.result.error || d.result.success === false);
                  steps[i] = {
                    ...steps[i],
                    status: failed ? 'error' : 'done',
                    result: d.result,
                    finishedAt: Date.now(),
                  };
                  break;
                }
              }
              return { ...prev, stage: 'thinking', activeTool: null, steps };
            });
            setStatus({ color: 'var(--yl)', text: 'Menganalisis hasil...' });
          } else if (currentEvent === 'error') {
            setAgentFlow(prev => ({ ...prev, stage: 'error', errorAt: prev.activeTool ? 'tool_running' : 'thinking', error: d.message || d.content || 'Terjadi error', activeTool: null }));
            const msg = d.message || d.content || 'Stream error';
            throw new Error(msg);
          } else if (currentEvent === 'provider_switch') {
            const sw = {
              from: d.from || null,
              to: d.to || '?',
              model: d.model || null,
              reason: d.reason || 'failover',
              attempt: d.attempt ?? 0,
              at: Date.now(),
            };
            setAgentFlow(prev => ({
              ...prev,
              activeProvider: sw.to,
              activeModel: sw.model,
              switches: [...prev.switches, sw],
            }));
            if (d.reason && d.reason !== 'initial') {
              setStatus({ color: 'var(--yl)', text: `Beralih ke ${sw.to}${sw.model ? '/' + sw.model : ''}…` });
            }
            if (d.reset && sw.from) {
              // Provider gagal di tengah jalan: reset jawaban parsial lalu lanjut.
              fullContent = '';
              setMessages(prev => {
                const copy = [...prev];
                if (copy.length) copy[copy.length - 1] = { ...copy[copy.length - 1], content: fullContent };
                return copy;
              });
            }
          } else if (currentEvent === 'done') {
            setAgentFlow(prev => ({ ...prev, stage: 'done', activeTool: null, finishedAt: Date.now() }));
          }
        currentEvent = 'message';
      }
    }

    const finalMessages = [
      { role: 'user', content: messageContent },
      { role: 'assistant', content: fullContent },
    ];
    await saveSession(finalMessages);
    setAgentFlow(prev => ({ ...prev, stage: 'done', activeTool: null, finishedAt: Date.now() }));
  } catch (e) {
    if (e.name !== 'AbortError') {
      const err = 'Error: ' + e.message;
      setMessages(prev => {
        const copy = [...prev];
        if (copy.length) copy[copy.length - 1] = { ...copy[copy.length - 1], content: err };
        return copy;
      });
      setAgentFlow(prev => ({ ...prev, stage: 'error', errorAt: prev.steps?.length ? 'tool_running' : 'thinking', error: e.message, activeTool: null, finishedAt: Date.now() }));
    }
  } finally {
    setProcessing(false);
    abRef.current = null;
    setStatus({ color: 'var(--gr)', text: 'Ready' });
  }
}

async function sendPuter(text, attachments, saveSession, setMessages, setStatus, setProcessing, abRef, history, setAgentFlow) {
  if (!window.puter) {
    setMessages(prev => {
      const copy = [...prev];
      if (copy.length) copy[copy.length - 1] = { ...copy[copy.length - 1], content: 'Error: Puter.js tidak tersedia' };
      return copy;
    });
    setProcessing(false);
    setStatus({ color: 'var(--gr)', text: 'Ready' });
    setAgentFlow(prev => ({ ...prev, stage: 'error', error: 'Puter.js tidak tersedia', finishedAt: Date.now() }));
    return;
  }

  const ab = new AbortController();
  abRef.current = ab;

  let messageContent = text;
  if (attachments && attachments.length > 0) {
    setStatus({ color: 'var(--yl)', text: 'Membaca file...' });
    const fileResults = await uploadFiles(attachments);
    messageContent = buildMessageWithFiles(text, fileResults);
  }

  const ctx = (history || []).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
  const prompt = ctx ? `${ctx}\nUser: ${messageContent}\nAssistant: ` : `User: ${messageContent}\nAssistant: `;

  try {
    const result = await window.puter.ai.chat(prompt, { signal: ab.signal, stream: false });
    const     content = result?.message?.content || result?.text || result?.toString() || '';
    setMessages(prev => {
      const copy = [...prev];
      if (copy.length) copy[copy.length - 1] = { ...copy[copy.length - 1], content, timestamp: copy[copy.length - 1].timestamp || Date.now() };
      return copy;
    });
    await saveSession([
      { role: 'user', content: messageContent },
      { role: 'assistant', content },
    ]);
    setAgentFlow(prev => ({ ...prev, stage: 'done', activeTool: null, finishedAt: Date.now() }));
  } catch (e) {
    if (e.name !== 'AbortError') {
      setMessages(prev => {
        const copy = [...prev];
        if (copy.length) copy[copy.length - 1] = { ...copy[copy.length - 1], content: 'Error: ' + e.message };
        return copy;
      });
      setAgentFlow(prev => ({ ...prev, stage: 'error', error: e.message, finishedAt: Date.now() }));
    }
  } finally {
    setProcessing(false);
    abRef.current = null;
    setStatus({ color: 'var(--gr)', text: 'Ready' });
  }
}
