/**
 * Hard refresh + new-version detection.
 *
 * Phones often cannot refresh this app: the page scrolls inside its own
 * containers (so pull-to-refresh never fires) and an app opened from the home
 * screen has no reload button at all. So the app offers its own:
 *
 *   hardRefresh()        drop caches/service workers, reload with a cache-busting URL
 *   useVersionWatcher()  tells the user when the server has a newer build
 *
 * localStorage (login token, theme, drafts) is deliberately left untouched.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

const PARAM = '_r';

export async function hardRefresh() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((regs || []).map((r) => r.unregister()));
  } catch { /* not supported */ }
  try {
    const keys = await globalThis.caches?.keys?.();
    await Promise.all((keys || []).map((k) => globalThis.caches.delete(k)));
  } catch { /* not supported */ }
  const u = new URL(window.location.href);
  u.searchParams.set(PARAM, Date.now().toString(36));
  window.location.replace(u.toString());
}

/** Removes the cache-busting parameter after a hard refresh so the address bar stays clean. */
export function cleanRefreshParam() {
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has(PARAM)) {
      u.searchParams.delete(PARAM);
      window.history.replaceState(window.history.state, '', u.pathname + (u.search || '') + u.hash);
    }
  } catch { /* ignore */ }
}

async function fetchBuild() {
  const res = await fetch('/api/version', { cache: 'no-store' });
  if (!res.ok) return null;
  const data = await res.json();
  return data.build || null;
}

/**
 * @returns {{updateAvailable:boolean, check:()=>Promise<void>, dismiss:()=>void}}
 */
export function useVersionWatcher({ intervalMs = 120_000 } = {}) {
  const loaded = useRef(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const check = useCallback(async () => {
    try {
      const build = await fetchBuild();
      if (!build) return;
      if (loaded.current == null) { loaded.current = build; return; }
      if (build !== loaded.current) setUpdateAvailable(true);
    } catch { /* offline or behind a login prompt: try again later */ }
  }, []);

  useEffect(() => {
    check();
    const t = setInterval(check, intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    };
  }, [check, intervalMs]);

  return { updateAvailable, check, dismiss: () => setUpdateAvailable(false) };
}
