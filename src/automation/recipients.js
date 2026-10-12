/**
 * src/automation/recipients.js
 *
 * Turns whatever the operator pastes (a column of emails, "Nama, email" lines,
 * or a full CSV with a header row) into a clean, de-duplicated recipient list.
 *
 * Security notes
 *  - Addresses containing CR/LF are rejected outright: that is the classic
 *    SMTP header-injection vector.
 *  - Display names are stripped of control characters and angle brackets.
 *  - Per-recipient extra columns become template variables; they are only
 *    ever substituted as plain strings (see templates.js).
 *
 * @author Wisnu Alfian Nur Ashar
 */

// Pragmatic RFC-5322 subset: good enough to catch typos without rejecting
// legitimate addresses. Real validation is the SMTP server's job.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 6 || v.length > 254) return false;
  if (/[\r\n\0<>,;\s]/.test(v)) return false;
  const [local] = v.split('@');
  if (local.length > 64) return false;
  return EMAIL_RE.test(v);
}

export function cleanName(value) {
  return String(value || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>"]/g, '')
    .trim()
    .slice(0, 120);
}

/** RFC-4180-ish CSV line splitter (handles quotes and escaped quotes). */
function splitCsvLine(line, delimiter) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function detectDelimiter(sample) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const d of Object.keys(counts)) counts[d] = (sample.match(new RegExp(d === '\t' ? '\t' : `\\${d}`, 'g')) || []).length;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

const EMAIL_HEADERS = new Set(['email', 'e-mail', 'mail', 'alamat email', 'email address']);
const NAME_HEADERS = new Set(['nama', 'name', 'full name', 'fullname', 'nama lengkap']);

/**
 * @param {string|Array<string|object>} input  raw text, or already-structured list
 * @param {{max?: number}} [options]
 * @returns {{recipients: Array<{email:string,name:string,vars:object}>,
 *            invalid: Array<{line:number,value:string,reason:string}>,
 *            duplicates: string[], total: number}}
 */
export function parseRecipients(input, options = {}) {
  const max = options.max ?? 5000;
  const rows = []; // { line, email, name, vars }
  const invalid = [];

  if (Array.isArray(input)) {
    input.forEach((item, i) => {
      if (typeof item === 'string') {
        const m = /^(.*?)<([^>]+)>$/.exec(item.trim());
        rows.push(m
          ? { line: i + 1, email: m[2].trim(), name: cleanName(m[1]), vars: {} }
          : { line: i + 1, email: item.trim(), name: '', vars: {} });
      } else if (item && typeof item === 'object') {
        const { email, name, ...rest } = item;
        rows.push({ line: i + 1, email: String(email || '').trim(), name: cleanName(name), vars: rest });
      }
    });
  } else {
    const lines = String(input || '')
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .map((l, i) => ({ text: l, line: i + 1 }))
      .filter((l) => l.text.trim() && !l.text.trim().startsWith('#'));

    if (lines.length) {
      const delimiter = detectDelimiter(lines.slice(0, 5).map((l) => l.text).join('\n'));
      const first = splitCsvLine(lines[0].text, delimiter);
      const headerIdx = first.findIndex((c) => EMAIL_HEADERS.has(c.toLowerCase()));
      const hasHeader = headerIdx !== -1;

      if (hasHeader) {
        const header = first.map((c) => c.toLowerCase());
        const nameIdx = header.findIndex((c) => NAME_HEADERS.has(c));
        for (const l of lines.slice(1)) {
          const cells = splitCsvLine(l.text, delimiter);
          const vars = {};
          header.forEach((h, idx) => {
            if (idx !== headerIdx && idx !== nameIdx && h) vars[h] = cells[idx] ?? '';
          });
          rows.push({
            line: l.line,
            email: (cells[headerIdx] || '').trim(),
            name: cleanName(nameIdx >= 0 ? cells[nameIdx] : ''),
            vars,
          });
        }
      } else {
        for (const l of lines) {
          // "Nama <mail@x.com>" | "mail@x.com" | "Nama, mail@x.com" | "mail@x.com, Nama"
          const angle = /^(.*?)<([^>]+)>\s*$/.exec(l.text.trim());
          if (angle) {
            rows.push({ line: l.line, email: angle[2].trim(), name: cleanName(angle[1]), vars: {} });
            continue;
          }
          const cells = splitCsvLine(l.text, delimiter);
          const emailCell = cells.find((c) => c.includes('@')) ?? cells[0];
          const nameCell = cells.find((c) => c && c !== emailCell && !c.includes('@')) ?? '';
          rows.push({ line: l.line, email: emailCell.trim(), name: cleanName(nameCell), vars: {} });
        }
      }
    }
  }

  const seen = new Set();
  const duplicates = [];
  const recipients = [];

  for (const r of rows) {
    const email = r.email.toLowerCase();
    if (!isValidEmail(email)) {
      invalid.push({
        line: r.line,
        value: r.email.slice(0, 80),
        reason: /[\r\n]/.test(r.email) ? 'Mengandung karakter terlarang' : 'Format email tidak valid',
      });
      continue;
    }
    if (seen.has(email)) {
      duplicates.push(email);
      continue;
    }
    seen.add(email);
    // vars: strip control chars & cap size so a hostile CSV cannot bloat the DB.
    const vars = {};
    for (const [k, v] of Object.entries(r.vars || {})) {
      if (typeof k !== 'string' || !k) continue;
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      // eslint-disable-next-line no-control-regex
      vars[k.slice(0, 40)] = String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 500);
    }
    recipients.push({ email, name: r.name, vars });
    if (recipients.length >= max) break;
  }

  return { recipients, invalid, duplicates, total: rows.length };
}
