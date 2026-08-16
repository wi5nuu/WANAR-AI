import { useState, useEffect, useCallback, useRef } from 'react';
import puter from '@heyputer/puter.js';

const KV_SESSIONS = 'puter_chat_sessions';
const KV_ACTIVE = 'puter_chat_active';

const MODELS = [
  { id: 'openai/gpt-5.4-nano', label: 'GPT-5.4 Nano' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
];

function newSession() {
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    messages: [],
    createdAt: Date.now(),
  };
}

export function usePuterChat() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [model, setModel] = useState(MODELS[0].id);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const abortRef = useRef(null);

  const activeSession = sessions.find(s => s.id === activeId) || null;
  const messages = activeSession?.messages || [];

  useEffect(() => {
    async function load() {
      try {
        const saved = await puter.kv.get(KV_SESSIONS);
        const active = await puter.kv.get(KV_ACTIVE);
        if (saved?.length) {
          setSessions(saved);
          setActiveId(active || saved[0].id);
        } else {
          const session = newSession();
          setSessions([session]);
          setActiveId(session.id);
        }
      } catch {
        const session = newSession();
        setSessions([session]);
        setActiveId(session.id);
      } finally {
        setReady(true);
      }
    }
    load();
  }, []);

  const persist = useCallback(async (nextSessions, nextActiveId) => {
    try {
      await puter.kv.set(KV_SESSIONS, nextSessions);
      if (nextActiveId) await puter.kv.set(KV_ACTIVE, nextActiveId);
    } catch (err) {
      console.error('Failed to persist chat:', err);
    }
  }, []);

  const updateSessions = useCallback((updater) => {
    setSessions(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      persist(next, activeId);
      return next;
    });
  }, [activeId, persist]);

  const startNewChat = useCallback(() => {
    const session = newSession();
    setSessions(prev => {
      const next = [session, ...prev];
      persist(next, session.id);
      return next;
    });
    setActiveId(session.id);
  }, [persist]);

  const switchSession = useCallback((id) => {
    setActiveId(id);
    persist(sessions, id);
  }, [sessions, persist]);

  const deleteSession = useCallback((id) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      if (next.length === 0) {
        const session = newSession();
        setActiveId(session.id);
        persist([session], session.id);
        return [session];
      }
      if (activeId === id) {
        setActiveId(next[0].id);
        persist(next, next[0].id);
      } else {
        persist(next, activeId);
      }
      return next;
    });
  }, [activeId, persist]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  }, []);

  const send = useCallback(async (text) => {
    const trimmed = text.trim();
    if (!trimmed || loading || !activeId) return;

    const userMsg = { role: 'user', content: trimmed };
    const history = [...messages, userMsg];
    const title = messages.length === 0
      ? trimmed.slice(0, 48) + (trimmed.length > 48 ? '…' : '')
      : activeSession?.title;

    updateSessions(prev =>
      prev.map(s =>
        s.id === activeId
          ? { ...s, title, messages: [...history, { role: 'assistant', content: '' }] }
          : s
      )
    );

    setLoading(true);
    const ab = new AbortController();
    abortRef.current = ab;

    try {
      const stream = await puter.ai.chat(history, {
        model,
        stream: true,
        signal: ab.signal,
      });

      let fullText = '';
      for await (const part of stream) {
        const chunk = part?.text ?? '';
        if (!chunk) continue;
        fullText += chunk;
        updateSessions(prev =>
          prev.map(s => {
            if (s.id !== activeId) return s;
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = { role: 'assistant', content: fullText };
            return { ...s, messages: msgs };
          })
        );
      }

      if (!fullText) {
        const reply = await puter.ai.chat(history, { model, signal: ab.signal });
        fullText = reply?.message?.content?.toString?.() || reply?.text?.toString?.() || '';
        updateSessions(prev =>
          prev.map(s => {
            if (s.id !== activeId) return s;
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = { role: 'assistant', content: fullText };
            return { ...s, messages: msgs };
          })
        );
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        const errText = err.message?.includes('auth')
          ? 'Please sign in with Puter when prompted, then try again.'
          : `Error: ${err.message}`;
        updateSessions(prev =>
          prev.map(s => {
            if (s.id !== activeId) return s;
            const msgs = [...s.messages];
            msgs[msgs.length - 1] = { role: 'assistant', content: errText };
            return { ...s, messages: msgs };
          })
        );
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [loading, activeId, messages, model, activeSession?.title, updateSessions]);

  return {
    ready,
    sessions,
    activeId,
    messages,
    model,
    setModel,
    models: MODELS,
    loading,
    send,
    stop,
    startNewChat,
    switchSession,
    deleteSession,
  };
}
