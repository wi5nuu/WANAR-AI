/**
 * Realtime streams (SSE) for the guarded APIs.
 *
 * EventSource cannot send headers, and putting the permanent AUTOMATION_TOKEN
 * in a URL leaks it into proxy/CDN logs. So we first trade the token (sent as
 * a header) for a short-lived signed ticket, and reconnect with a fresh ticket
 * whenever the stream drops.
 */

const TOKEN_KEY = 'automationToken';

export function getAutomationToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

async function fetchTicket() {
  const t = getAutomationToken();
  const res = await fetch('/api/automation/stream-ticket', { headers: t ? { 'X-Automation-Token': t } : {} });
  if (!res.ok) throw new Error(`ticket ${res.status}`);
  const data = await res.json();
  return data.ticket || null; // null = localhost, no ticket needed
}

/**
 * @param {string} path  e.g. '/api/worklog/events'
 * @param {{onOpen?:Function, onDown?:Function, events?:Record<string,Function>, onMessage?:Function}} h
 * @returns {() => void} close
 */
export function openStream(path, h = {}) {
  let es = null;
  let closed = false;
  let retry = null;
  let delay = 2000;

  const connect = async () => {
    if (closed) return;
    let ticket = null;
    try { ticket = await fetchTicket(); } catch { schedule(); return; }
    if (closed) return;
    const sep = path.includes('?') ? '&' : '?';
    es = new EventSource(ticket ? `${path}${sep}ticket=${encodeURIComponent(ticket)}` : path);
    es.onopen = () => { delay = 2000; h.onOpen?.(); };
    es.onerror = () => {
      h.onDown?.();
      es?.close();
      schedule(); // fresh ticket on every reconnect (tickets expire)
    };
    if (h.onMessage) es.onmessage = h.onMessage;
    for (const [name, fn] of Object.entries(h.events || {})) es.addEventListener(name, fn);
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(retry);
    retry = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30_000);
  };

  connect();
  return () => { closed = true; clearTimeout(retry); es?.close(); };
}
