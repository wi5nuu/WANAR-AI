import { useState, useRef, useCallback } from 'react';

export function useChat(saveSession) {
  const [messages, setMessages] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState({ color: 'var(--gr)', text: 'Ready' });
  const abRef = useRef(null);

  const addMessage = useCallback((role, content, attachments) => {
    setMessages(prev => [...prev, { role, content, attachments }]);
  }, []);

  const replaceLast = useCallback((role, content) => {
    setMessages(prev => {
      const idx = prev.length - 1;
      if (idx < 0) return [{ role, content }];
      const copy = [...prev];
      copy[idx] = { ...copy[idx], content };
      return copy;
    });
  }, []);

  const send = useCallback(async (provider, model, route, attachments = [], overrideText = null) => {
    const inputEl = document.querySelector('.input-textarea');
    const text = overrideText !== null ? overrideText : (inputEl?.value?.trim() || '');
    if (!text && attachments.length === 0) return;
    if (processing) return;
    if (inputEl && overrideText === null) { inputEl.value = ''; inputEl.style.height = 'auto'; }

    setProcessing(true);
    setStatus({ color: 'var(--yl)', text: 'Mengetik...' });
    const history = [...messages];

    // Show user message with attachment info
    const displayContent = text || (attachments.length > 0 ? `[${attachments.length} file(s) attached]` : '');
    addMessage('user', displayContent, attachments.map(f => ({ name: f.name, type: f.type, size: f.size })));
    addMessage('assistant', '');

    if (provider === 'puter') {
      await sendPuter(text, attachments, saveSession, setMessages, setStatus, setProcessing, abRef, history);
    } else {
      await sendSSE(provider, model, route, text, attachments, saveSession, setMessages, setStatus, setProcessing, abRef, history);
    }
  }, [processing, addMessage, messages, saveSession]);

  const stop = useCallback(() => {
    if (abRef.current) { abRef.current.abort(); abRef.current = null; }
    setProcessing(false);
    setStatus({ color: 'var(--gr)', text: 'Ready' });
  }, []);

  const clear = useCallback(() => {
    if (processing) return;
    setMessages([]);
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

  return { messages, processing, status, send, stop, clear, loadMessages, setStatus, updateMessage };
}

/**
 * Upload files to server and get extracted text content back
 */
async function uploadFiles(files) {
  if (!files || files.length === 0) return [];
  const results = [];
  for (const file of files) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const resp = await fetch('/api/upload', { method: 'POST', body: formData });
      if (resp.ok) {
        const data = await resp.json();
        results.push({ name: file.name, type: file.type, content: data.content, preview: data.preview });
      } else {
        results.push({ name: file.name, type: file.type, content: `[Failed to read: ${file.name}]`, preview: null });
      }
    } catch (e) {
      results.push({ name: file.name, type: file.type, content: `[Error reading file: ${e.message}]`, preview: null });
    }
  }
  return results;
}

/**
 * Build message content that includes file content for AI context
 */
function buildMessageWithFiles(text, fileResults) {
  if (!fileResults || fileResults.length === 0) return text || '';

  const fileParts = fileResults.map(f => {
    if (f.content) {
      return `\n\n--- File: ${f.name} ---\n${f.content}\n--- End of ${f.name} ---`;
    }
    return `\n\n--- File: ${f.name} (binary/unsupported) ---`;
  }).join('');

  return (text ? text + '\n' : '') + fileParts;
}

async function sendSSE(provider, model, route, text, attachments, saveSession, setMessages, setStatus, setProcessing, abRef, history) {
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (!json) continue;
        try {
          const d = JSON.parse(json);
          if (d.content) {
            fullContent += d.content;
            setMessages(prev => {
              const copy = [...prev];
              if (copy.length) copy[copy.length - 1] = { ...copy[copy.length - 1], content: fullContent };
              return copy;
            });
          }
          if (d.error) throw new Error(d.error);
        } catch (e) { if (e.name === 'AbortError') throw e; }
      }
    }

    const finalMessages = [
      { role: 'user', content: messageContent },
      { role: 'assistant', content: fullContent },
    ];
    await saveSession(finalMessages);
  } catch (e) {
    if (e.name !== 'AbortError') {
      const err = 'Error: ' + e.message;
      setMessages(prev => {
        const copy = [...prev];
        if (copy.length) copy[copy.length - 1] = { ...copy[copy.length - 1], content: err };
        return copy;
      });
    }
  } finally {
    setProcessing(false);
    abRef.current = null;
    setStatus({ color: 'var(--gr)', text: 'Ready' });
  }
}

async function sendPuter(text, attachments, saveSession, setMessages, setStatus, setProcessing, abRef, history) {
  if (!window.puter) {
    setMessages(prev => {
      const copy = [...prev];
      if (copy.length) copy[copy.length - 1] = { ...copy[copy.length - 1], content: 'Error: Puter.js tidak tersedia' };
      return copy;
    });
    setProcessing(false);
    setStatus({ color: 'var(--gr)', text: 'Ready' });
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
    const content = result?.message?.content || result?.text || result?.toString() || '';
    setMessages(prev => {
      const copy = [...prev];
      if (copy.length) copy[copy.length - 1] = { ...copy[copy.length - 1], content };
      return copy;
    });
    await saveSession([
      { role: 'user', content: messageContent },
      { role: 'assistant', content },
    ]);
  } catch (e) {
    if (e.name !== 'AbortError') {
      setMessages(prev => {
        const copy = [...prev];
        if (copy.length) copy[copy.length - 1] = { ...copy[copy.length - 1], content: 'Error: ' + e.message };
        return copy;
      });
    }
  } finally {
    setProcessing(false);
    abRef.current = null;
    setStatus({ color: 'var(--gr)', text: 'Ready' });
  }
}
