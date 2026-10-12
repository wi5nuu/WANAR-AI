/**
 * src/automation/attachments.js
 *
 * Email attachments for campaigns and scheduled jobs.
 *
 * Safety properties
 *  - Files are stored under a server-generated name (`att_<hex><ext>`); the
 *    user-supplied filename is only ever used as the *display* name in the
 *    email, after sanitising. It can never influence a filesystem path.
 *  - Executable / script extensions are refused (what mail providers and
 *    recipients' gateways block anyway — better to say so up front).
 *  - Per-file, per-message and total size caps keep the message under the
 *    ~25 MB provider limit (base64 adds ~33%).
 *
 * @author Wisnu Alfian Nur Ashar
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ATTACHMENT_DIR = path.join(__dirname, '..', '..', 'data', 'automation-attachments');

const BLOCKED_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'pif', 'cpl', 'dll', 'sys', 'drv',
  'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'lnk', 'reg',
  'apk', 'app', 'dmg', 'gadget', 'sh', 'bin', 'iso', 'inf',
]);

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  zip: 'application/zip',
};

export class AttachmentError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}

const ID_RE = /^att_[a-f0-9]{12}$/;

export function sanitizeFilename(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return 'lampiran';
  const ext = path.extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - ext.length).slice(0, 100) || 'lampiran';
  return `${stem}${ext.slice(0, 12)}`;
}

export function createAttachmentService({
  store,
  dir = DEFAULT_ATTACHMENT_DIR,
  maxFileBytes = (parseFloat(process.env.EMAIL_MAX_ATTACHMENT_MB || '10') || 10) * 1024 * 1024,
  maxTotalBytes = (parseFloat(process.env.EMAIL_MAX_TOTAL_ATTACHMENT_MB || '18') || 18) * 1024 * 1024,
  maxFiles = parseInt(process.env.EMAIL_MAX_ATTACHMENTS || '5', 10) || 5,
}) {
  fs.mkdirSync(dir, { recursive: true });

  const limits = { maxFileBytes, maxTotalBytes, maxFiles };

  /** Validates and persists an uploaded buffer. */
  function save({ originalName, buffer, contentType }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new AttachmentError('File kosong');
    if (buffer.length > limits.maxFileBytes) {
      throw new AttachmentError(
        `File terlalu besar (${(buffer.length / 1048576).toFixed(1)} MB). Maksimal ${(limits.maxFileBytes / 1048576).toFixed(0)} MB per file.`,
        'too_large'
      );
    }
    const filename = sanitizeFilename(originalName);
    const ext = path.extname(filename).slice(1).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      throw new AttachmentError(`Tipe file .${ext} tidak diizinkan sebagai lampiran (berpotensi berbahaya dan umumnya diblokir penyedia email).`, 'blocked_type');
    }

    const rand = crypto.randomBytes(6).toString('hex');
    const storedName = `att_${rand}${ext ? `.${ext.replace(/[^a-z0-9]/g, '').slice(0, 8)}` : ''}`;
    const fullPath = path.join(dir, storedName);
    fs.writeFileSync(fullPath, buffer, { flag: 'wx' });

    return store.attachments.add({
      filename,
      contentType: MIME_BY_EXT[ext] || (/^[a-z]+\/[a-z0-9.+-]+$/i.test(contentType || '') ? contentType : 'application/octet-stream'),
      size: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      storedName,
    });
  }

  function pathOf(att) {
    // stored_name is generated here, but never trust the DB blindly.
    const full = path.join(dir, path.basename(att.storedName));
    return full;
  }

  /** Normalises an id list and enforces count / total-size limits. */
  function assertAvailable(ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
    if (list.length > limits.maxFiles) {
      throw new AttachmentError(`Maksimal ${limits.maxFiles} lampiran per email`, 'too_many');
    }
    let total = 0;
    for (const id of list) {
      if (!ID_RE.test(id)) throw new AttachmentError(`ID lampiran tidak valid: ${String(id).slice(0, 30)}`);
      const att = store.attachments.get(id);
      if (!att) throw new AttachmentError(`Lampiran ${id} tidak ditemukan`, 'not_found');
      if (!fs.existsSync(pathOf(att))) throw new AttachmentError(`File lampiran "${att.filename}" hilang dari server`, 'missing');
      total += att.size;
    }
    if (total > limits.maxTotalBytes) {
      throw new AttachmentError(
        `Total lampiran ${(total / 1048576).toFixed(1)} MB melebihi batas ${(limits.maxTotalBytes / 1048576).toFixed(0)} MB`,
        'too_large'
      );
    }
    return list;
  }

  /** nodemailer-ready attachment objects. Throws when a file has vanished. */
  function resolveForSend(ids) {
    return assertAvailable(ids).map((id) => {
      const att = store.attachments.get(id);
      return { filename: att.filename, path: pathOf(att), contentType: att.contentType };
    });
  }

  function remove(id) {
    const att = store.attachments.get(id);
    if (!att) return false;
    try { fs.unlinkSync(pathOf(att)); } catch { /* already gone */ }
    return store.attachments.remove(id);
  }

  /** Is this attachment referenced by a not-yet-finished campaign or a job? */
  function inUse(id) {
    const live = store.campaigns.list(500).some(
      (c) => c.attachmentIds.includes(id) && !['completed', 'cancelled'].includes(c.status)
    );
    if (live) return true;
    return store.jobs.list().some((j) => Array.isArray(j.payload?.attachmentIds) && j.payload.attachmentIds.includes(id));
  }

  return { save, assertAvailable, resolveForSend, remove, inUse, limits, dir, pathOf };
}
