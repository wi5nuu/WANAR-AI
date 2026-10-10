/**
 * src/tools/browser-cursor.js
 *
 * Virtual in-page cursor for Wanar AI's visible Chromium.
 *
 * Menampilkan "ghost cursor" DI DALAM halaman browser yang dikendalikan AI:
 *   - Bergerak halus dan real-time mengikuti aksi tool
 *   - Riak (ripple) saat klik, dan trail cahaya saat bergerak
 *   - Terisolasi penuh dari cursor OS: cursor laptop user tetap bisa bergerak
 *     bebas, dan saat user masuk ke window Chromium, ghost cursor tetap ada.
 *
 * Tidak menyentuh user32.dll / SetCursorPos sama sekali.
 */

// Script yang di-inject ke setiap halaman (idempotent).
export const CURSOR_INIT_SCRIPT = `
(() => {
  if (window.__wanarCursor) return;

  const install = () => {
    if (window.__wanarCursor) return;
    const root = document.documentElement || document.body;
    if (!root) return;

    const style = document.createElement('style');
    style.id = '__wanar_cursor_style';
    style.textContent = \`
      #__wanar_cursor {
        position: fixed; left: 0; top: 0; width: 26px; height: 26px;
        z-index: 2147483647; pointer-events: none;
        transform: translate3d(-100px,-100px,0);
        transition: transform .12s linear;
        filter: drop-shadow(0 2px 5px rgba(0,0,0,.45));
        will-change: transform;
      }
      #__wanar_cursor svg { width: 26px; height: 26px; display: block; overflow: visible; }
      #__wanar_cursor.hidden { opacity: 0; }
      #__wanar_cursor.press svg { transform: scale(.84); }
      #__wanar_cursor svg { transition: transform .09s ease; }
      #__wanar_ripple {
        position: fixed; width: 14px; height: 14px; margin: -7px 0 0 -7px;
        border-radius: 50%; z-index: 2147483646; pointer-events: none;
        background: rgba(255,152,0,.55); border: 2px solid rgba(255,152,0,.95);
        transform: translate3d(-100px,-100px,0) scale(.3); opacity: 0;
      }
      #__wanar_ripple.go { animation: __wanar_rip .55s ease-out forwards; }
      @keyframes __wanar_rip {
        0% { opacity: .9; transform: scale(.3); }
        100% { opacity: 0; transform: scale(3.2); }
      }
      #__wanar_label {
        position: fixed; z-index: 2147483647; pointer-events: none;
        transform: translate3d(-100px,-100px,0);
        background: rgba(20,20,30,.92); color: #ffb74d;
        font: 600 11px/1.4 'Segoe UI',Arial,sans-serif;
        padding: 3px 8px; border-radius: 6px; white-space: nowrap;
        max-width: 320px; overflow: hidden; text-overflow: ellipsis;
        box-shadow: 0 3px 12px rgba(0,0,0,.4);
        opacity: 0; transition: opacity .18s ease;
      }
      #__wanar_label.show { opacity: 1; }
    \`;
    root.appendChild(style);

    const cur = document.createElement('div');
    cur.id = '__wanar_cursor';
    // Panah putih gaya cursor OS (mudah dilihat di semua background)
    // + lencana oranye "AI" agar jelas ini tangan AI, bukan mouse user.
    cur.innerHTML = '<svg viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M6 3.5l12.5 10.2-5.9 1.1-2.3 5.9L6 3.5z" fill="#ffffff" stroke="#1a1a1a" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<circle cx="19.5" cy="19.5" r="6" fill="#ff9800" stroke="#ffffff" stroke-width="1.6"/>' +
      '<path d="M16.9 19.5l1.8 1.8 3-3.4" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    root.appendChild(cur);

    const rip = document.createElement('div');
    rip.id = '__wanar_ripple';
    root.appendChild(rip);

    const label = document.createElement('div');
    label.id = '__wanar_label';
    root.appendChild(label);

    let x = -100, y = -100;

    const api = {
      show() { cur.classList.remove('hidden'); },
      hide() { cur.classList.add('hidden'); label.classList.remove('show'); },
      move(nx, ny) {
        x = Math.round(nx); y = Math.round(ny);
        cur.style.transform = 'translate3d(' + (x - 4) + 'px,' + (y - 3) + 'px,0)';
        rip.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
        label.style.transform = 'translate3d(' + (x + 16) + 'px,' + (y + 14) + 'px,0)';
      },
      click(nx, ny) {
        if (typeof nx === 'number') api.move(nx, ny);
        cur.classList.add('press');
        const c = cur.cloneNode(true);
        c.style.transform = 'translate3d(' + (x - 4) + 'px,' + (y - 3) + 'px,0) scale(.82)';
        setTimeout(() => cur.classList.remove('press'), 90);
        rip.classList.remove('go'); void rip.offsetWidth; rip.classList.add('go');
        return true;
      },
      ripple(nx, ny) {
        if (typeof nx === 'number') api.move(nx, ny);
        rip.classList.remove('go'); void rip.offsetWidth; rip.classList.add('go');
      },
      label(text) {
        if (!text) { label.classList.remove('show'); return; }
        label.textContent = text;
        label.classList.add('show');
      },
      pos() { return { x, y }; },
    };

    window.__wanarCursor = api;
    api.show();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
`;

/** Inject the cursor overlay into a page and keep it across navigations. */
export async function installCursor(page) {
  try {
    await page.addInitScript(CURSOR_INIT_SCRIPT);
  } catch { /* noop */ }
  try {
    await page.evaluate(CURSOR_INIT_SCRIPT);
  } catch { /* some pages may block eval */ }
  try {
    await page.evaluate(() => window.__wanarCursor?.show?.());
  } catch { /* noop */ }
}

/** Pindahkan ghost cursor ke koordinat (x, y). */
export async function moveCursor(page, x, y) {
  try {
    await page.evaluate(([px, py]) => window.__wanarCursor?.move?.(px, py), [x, y]);
  } catch { /* noop */ }
}

/**
 * Gerakkan ghost cursor secara halus seperti manusia: easing ease-in-out,
 * langkah kecil 10-25ms, plus overshoot 2-5px + koreksi untuk jarak jauh.
 * Mengembalikan posisi akhir menurut overlay (akurasi bisa diverifikasi).
 */
export async function glideCursor(page, x, y, label = null) {
  try {
    if (label !== null && label !== undefined) {
      await page.evaluate((t) => window.__wanarCursor?.label?.(t), String(label).slice(0, 80));
    }
    const final = await page.evaluate(([tx, ty]) => {
      const api = window.__wanarCursor;
      if (!api) return null;
      const from = (api.pos && api.pos()) || { x: tx, y: ty };
      const dist = Math.hypot(tx - from.x, ty - from.y);
      const steps = Math.max(8, Math.min(48, Math.round(dist / 28)));
      const ox = dist > 150 ? (Math.random() * 8 - 4) : 0;
      const oy = dist > 150 ? (Math.random() * 8 - 4) : 0;
      return new Promise((resolve) => {
        let i = 0;
        const tick = () => {
          i++;
          const t = Math.min(1, i / steps);
          const e = t * t * (3 - 2 * t);
          api.move(from.x + (tx + ox - from.x) * e, from.y + (ty + oy - from.y) * e);
          if (i < steps) {
            setTimeout(tick, 10 + Math.random() * 16);
          } else if (ox !== 0 || oy !== 0) {
            setTimeout(() => { api.move(tx, ty); resolve({ x: Math.round(tx), y: Math.round(ty) }); }, 60);
          } else {
            resolve({ x: Math.round(tx), y: Math.round(ty) });
          }
        };
        tick();
      });
    }, [Math.round(x), Math.round(y)]);
    return final || { x: Math.round(x), y: Math.round(y) };
  } catch {
    return { x: Math.round(x), y: Math.round(y) };
  }
}

/** Pindahkan ghost cursor ke tengah sebuah elemen (selector CSS). */
export async function moveCursorToSelector(page, selector) {
  try {
    const box = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector);
    if (!box) return null;
    await moveCursor(page, box.x, box.y);
    return box;
  } catch {
    return null;
  }
}

/** Efek klik (ripple + press) pada posisi tertentu. */
export async function rippleClick(page, x, y) {
  try {
    await page.evaluate(([px, py]) => window.__wanarCursor?.click?.(px, py), [x, y]);
  } catch { /* noop */ }
}

/** Tampilkan label aksi di samping cursor, mis. "klik tombol Daftar". */
export async function cursorLabel(page, text) {
  try {
    await page.evaluate((t) => window.__wanarCursor?.label?.(t), text || '');
  } catch { /* noop */ }
}

export default { installCursor, moveCursor, glideCursor, moveCursorToSelector, rippleClick, cursorLabel };