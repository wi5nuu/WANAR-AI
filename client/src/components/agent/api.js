/**
 * Shared helpers for the Agent Center: one fetch wrapper (with the operator token prompt the other
 * pages use) and the small formatters every tab needs.
 */

import { getAutomationToken } from '../../lib/stream.js';

const TOKEN_KEY = 'automationToken';
export const TZ = 'Asia/Jakarta';

export async function api(base, path, { method = 'GET', body } = {}, retried = false) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const t = getAutomationToken();
  if (t) headers['X-Automation-Token'] = t;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && !retried) {
    const entered = window.prompt('Masukkan token otomasi (AUTOMATION_TOKEN di .env server):');
    if (entered) {
      try { localStorage.setItem(TOKEN_KEY, entered.trim()); } catch { /* private mode */ }
      return api(base, path, { method, body }, true);
    }
  }
  if (!res.ok) throw new Error(data.error || data.message || `Permintaan gagal (HTTP ${res.status})`);
  return data;
}

export const careerApi = (path, opts) => api('/api/career', path, opts);
export const salesApi = (path, opts) => api('/api/sales', path, opts);

// ----------------------------------------------------------------------- formatting

export function ago(ts, now = Date.now()) {
  if (!ts) return 'belum pernah';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'baru saja';
  if (s < 3600) return `${Math.round(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86400)} hari lalu`;
}

export const clock = (ts) => new Date(ts).toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

const dayKey = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });

/** "Hari ini" / "Kemarin" / "Kam, 15 Okt" for grouping a feed. */
export function dayLabel(ts, now = Date.now()) {
  const k = dayKey(ts);
  if (k === dayKey(now)) return 'Hari ini';
  if (k === dayKey(now - 86_400_000)) return 'Kemarin';
  return new Date(ts).toLocaleDateString('id-ID', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
}

export const groupByDay = (items, now = Date.now()) => {
  const groups = [];
  for (const it of items) {
    const label = dayLabel(it.ts, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(it);
    else groups.push({ label, items: [it] });
  }
  return groups;
};

export const rupiah = (n) => `Rp${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;

export function shortRupiah(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `Rp${(v / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`;
  if (v >= 1_000) return `Rp${Math.round(v / 1_000).toLocaleString('id-ID')} rb`;
  return rupiah(v);
}

export const priceText = (p) => `${shortRupiah(p.min)} – ${shortRupiah(p.max)}${p.unit === 'bulan' ? ' / bulan' : ''}`;

export function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }
export function recall(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }

/** Downloads a protected file (the owner's CV) with the operator token, then hands it to the browser. */
export async function downloadFile(path, fallbackName = 'file') {
  const headers = {};
  const t = getAutomationToken();
  if (t) headers['X-Automation-Token'] = t;
  const res = await fetch(path, { headers });
  if (!res.ok) {
    let msg = `Unduhan gagal (HTTP ${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Copies text; returns true when the browser allowed it. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
