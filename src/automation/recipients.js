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
 * Normalises a phone number to digits-only international form (what the
 * WhatsApp Cloud API expects). A leading 0 is read as the default country code
 * (Indonesia, 62), so "0812-3456-7890" becomes "6281234567890".
 */
export function normalizePhone(raw, countryCode) {
  const cc = String(countryCode || process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '62').replace(/\D/g, '') || '62';
  let d = String(raw || '').replace(/[\s().-]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = cc + d.slice(1);
  return /^\d{8,15}$/.test(d) ? d : null;
}

/** Telegram chat id: numeric (negative for groups) or @channelusername. */
export function normalizeChatId(raw) {
  const v = String(raw || '').trim();
  if (/^-?\d{5,20}$/.test(v)) return v;
  if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v)) return v.toLowerCase();
  return null;
}

/** Webhook-style channels have one configured destination. */
export function normalizeDestination(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '' || v === 'default' || v === 'semua' || v === 'all' ? 'default' : null;
}

const KINDS = {
  email: {
    label: 'email',
    headers: EMAIL_HEADERS,
    normalize: (v) => {
      const e = String(v).trim().toLowerCase();
      return isValidEmail(e) ? e : null;
    },
    looksLike: (c) => c.includes('@'),
  },
  phone: {
    label: 'nomor telepon',
    headers: new Set(['telepon', 'telephone', 'phone', 'hp', 'no hp', 'no. hp', 'nomor', 'nomor hp', 'whatsapp', 'wa', 'no wa', 'mobile']),
    normalize: (v) => normalizePhone(v),
    looksLike: (c) => /^\+?[\d\s().-]{6,}$/.test(c),
  },
  chat_id: {
    label: 'chat ID Telegram',
    headers: new Set(['chat_id', 'chatid', 'chat id', 'telegram', 'telegram_id', 'user_id', 'id']),
    normalize: normalizeChatId,
    looksLike: (c) => /^-?\d{5,}$|^@\w+$/.test(c),
  },
  destination: {
    label: 'tujuan',
    headers: new Set(['tujuan', 'destination', 'target']),
    normalize: normalizeDestination,
    looksLike: () => true,
  },
};

export const RECIPIENT_KINDS = Object.freeze(Object.keys(KINDS));

/**
 * Pulls the "@subscribers" shortcut (meaning: every active subscriber of the
 * channel, resolved at send time) out of a pasted list.
 */
export function extractSubscribersToken(input) {
  if (Array.isArray(input)) {
    const rest = input.filter((x) => String(x).trim().toLowerCase() !== '@subscribers');
    return { input: rest, useSubscribers: rest.length !== input.length };
  }
  const text = String(input || '');
  const re = /^[ \t]*@subscribers[ \t]*$/gim;
  const useSubscribers = re.test(text);
  return { input: useSubscribers ? text.replace(/^[ \t]*@subscribers[ \t]*\r?\n?/gim, '') : text, useSubscribers };
}

/**
 * @param {string|Array<string|object>} input  raw text, or already-structured list
 * @param {{max?: number}} [options]
 * @returns {{recipients: Array<{email:string,name:string,vars:object}>,
 *            invalid: Array<{line:number,value:string,reason:string}>,
 *            duplicates: string[], total: number}}
 */
export function parseRecipients(input, options = {}) {
  const max = options.max ?? 5000;
  const kind = KINDS[options.kind || 'email'] || KINDS.email;
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
        const { email, address, phone, chat_id: chatId, chatId: chatId2, name, ...rest } = item;
        const addr = email ?? address ?? phone ?? chatId ?? chatId2 ?? '';
        rows.push({ line: i + 1, email: String(addr).trim(), name: cleanName(name), vars: rest });
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
      const headerIdx = first.findIndex((c) => kind.headers.has(c.toLowerCase()));
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
          const angle = options.kind && options.kind !== 'email' ? null : /^(.*?)<([^>]+)>\s*$/.exec(l.text.trim());
          if (angle) {
            rows.push({ line: l.line, email: angle[2].trim(), name: cleanName(angle[1]), vars: {} });
            continue;
          }
          const cells = splitCsvLine(l.text, delimiter);
          const emailCell = cells.find((c) => kind.looksLike(c)) ?? cells[0];
          const nameCell = cells.find((c) => c && c !== emailCell && !kind.looksLike(c)) ?? '';
          rows.push({ line: l.line, email: emailCell.trim(), name: cleanName(nameCell), vars: {} });
        }
      }
    }
  }

  const seen = new Set();
  const duplicates = [];
  const recipients = [];

  for (const r of rows) {
    const email = /[\r\n]/.test(r.email) ? null : kind.normalize(r.email);
    if (!email) {
      invalid.push({
        line: r.line,
        value: r.email.slice(0, 80),
        reason: /[\r\n]/.test(r.email) ? 'Mengandung karakter terlarang' : `Format ${kind.label} tidak valid`,
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
