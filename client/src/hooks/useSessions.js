import { useState, useCallback, useEffect } from 'react';

export function useSessions() {
  const [sessions, setSessions] = useState([]);
  const [currentId, setCurrentId] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/sessions');
      setSessions(await r.json());
    } catch (e) {}
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = useCallback(async (data) => {
    const body = { ...data, id: data.id || undefined };
    if (data.messages) body.messages = data.messages;
    const r = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await r.json();
    await load();
    return res.id;
  }, [load]);

  const remove = useCallback(async (id) => {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (currentId === id) setCurrentId(null);
    await load();
  }, [currentId, load]);

  const switchTo = useCallback(async (id) => {
    const r = await fetch(`/api/sessions/${id}`);
    const data = await r.json();
    setCurrentId(id);
    await load();
    return data.messages || [];
  }, [load]);

  return { sessions, currentId, setCurrentId, create, remove, switchTo, reload: load };
}
