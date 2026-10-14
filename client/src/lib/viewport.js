/**
 * Keeps --app-h equal to the height the user can actually SEE.
 *
 * On phones 100vh is the height with the browser's address bar tucked away, and
 * it ignores the on-screen keyboard — so a layout pinned to 100vh pushes the
 * chat form below the fold. visualViewport reports the real visible height
 * (address bar and keyboard included), and CSS uses `var(--app-h, 100dvh)`.
 */
export function initViewportHeight() {
  if (typeof window === 'undefined') return () => {};
  const vv = window.visualViewport;
  const set = () => {
    const h = Math.round(vv?.height || window.innerHeight);
    document.documentElement.style.setProperty('--app-h', `${h}px`);
  };
  // iOS scrolls the (hidden) page when the keyboard opens; keep the app pinned.
  const pin = () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); set(); };

  set();
  vv?.addEventListener('resize', set);
  vv?.addEventListener('scroll', pin);
  window.addEventListener('resize', set);
  window.addEventListener('orientationchange', set);
  return () => {
    vv?.removeEventListener('resize', set);
    vv?.removeEventListener('scroll', pin);
    window.removeEventListener('resize', set);
    window.removeEventListener('orientationchange', set);
  };
}
