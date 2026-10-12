/**
 * src/automation/templates.js
 *
 * Tiny, safe mail-merge engine.
 *
 *   Halo {{nama}},                       -> value of `nama`
 *   Halo {{nama|Bapak/Ibu}},             -> fallback when `nama` is empty
 *   Tanggal hari ini: {{tanggal}}        -> built-in variables
 *
 * No expressions, no code execution: a placeholder can only ever be replaced by
 * a string, so a spreadsheet cell cannot smuggle logic into a template.
 * When rendering HTML, every substituted value is escaped.
 *
 * @author Wisnu Alfian Nur Ashar
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.\-]+)\s*(?:\|([^}]*))?\}\}/g;

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Built-in variables available in every template (Indonesian locale, WIB). */
export function builtinVars(now = new Date(), tz = process.env.AUTOMATION_TZ || 'Asia/Jakarta') {
  const opts = { timeZone: tz };
  return {
    tanggal: now.toLocaleDateString('id-ID', { ...opts, day: 'numeric', month: 'long', year: 'numeric' }),
    hari: now.toLocaleDateString('id-ID', { ...opts, weekday: 'long' }),
    jam: now.toLocaleTimeString('id-ID', { ...opts, hour: '2-digit', minute: '2-digit' }),
    bulan: now.toLocaleDateString('id-ID', { ...opts, month: 'long' }),
    tahun: now.toLocaleDateString('id-ID', { ...opts, year: 'numeric' }),
    date: now.toLocaleDateString('en-CA', opts), // YYYY-MM-DD
  };
}

/** Lists the distinct variable names used by a template. */
export function extractVars(template) {
  const found = new Set();
  String(template || '').replace(PLACEHOLDER, (_, name) => {
    found.add(name);
    return '';
  });
  return [...found];
}

/**
 * Renders a template.
 * @param {string} template
 * @param {Record<string, any>} vars
 * @param {{html?: boolean}} [options]
 * @returns {{text: string, missing: string[]}}
 */
export function render(template, vars = {}, options = {}) {
  const missing = new Set();
  // Null-prototype map: `{{constructor}}` / `{{__proto__}}` must resolve to
  // "missing", never to something inherited from Object.prototype.
  const lookup = Object.create(null);
  for (const [k, v] of Object.entries(vars)) lookup[k.toLowerCase()] = v;

  const text = String(template || '').replace(PLACEHOLDER, (_, name, fallback) => {
    const raw = lookup[name.toLowerCase()];
    const has = raw !== undefined && raw !== null && String(raw).trim() !== '';
    let value;
    if (has) value = String(raw);
    else if (fallback !== undefined) value = fallback.trim();
    else {
      missing.add(name);
      value = '';
    }
    return options.html ? escapeHtml(value) : value;
  });

  return { text, missing: [...missing] };
}

/** Converts plain text to a minimal, safe HTML body (paragraphs + <br>). */
export function textToHtml(text) {
  const paragraphs = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.55">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2937">${paragraphs.join('')}</div>`;
}
