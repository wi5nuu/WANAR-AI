/**
 * src/automation/ai-compose.js
 *
 * AI-assisted drafting for the automation module: emails, code, and free text.
 *
 * Uses AIManager.chatStream, which carries the smart auto-failover chain — so a
 * scheduled job keeps working even when the preferred model has run out of
 * quota (the daily free tier does that regularly).
 *
 * @author Wisnu Alfian Nur Ashar
 */

const MAX_OUTPUT_CHARS = 20_000;

export class ComposeError extends Error {
  constructor(message, code = 'compose_failed') {
    super(message);
    this.name = 'ComposeError';
    this.code = code;
  }
}

function todayLine() {
  return new Date().toLocaleDateString('id-ID', {
    timeZone: process.env.AUTOMATION_TZ || 'Asia/Jakarta',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

/** Drains a failover-aware stream into a string. */
export async function collect(aiManager, messages, options = {}) {
  let buffer = '';
  let lastError = null;
  let model = options.model || null;
  let provider = options.provider || null;

  for await (const ev of aiManager.chatStream(messages, options)) {
    if (ev.type === 'provider_switch') {
      // The previous candidate failed mid-flight; its partial text is garbage.
      if (ev.reset) buffer = '';
      provider = ev.to || provider;
      model = ev.model || model;
    } else if (ev.type === 'content' || ev.type === 'token') {
      buffer += ev.content || '';
    } else if (ev.type === 'error') {
      lastError = ev.content || 'Unknown AI error';
    }
    if (buffer.length > MAX_OUTPUT_CHARS * 2) break; // runaway guard
  }

  const text = buffer.trim();
  if (!text) throw new ComposeError(lastError || 'AI tidak mengembalikan jawaban', 'empty');
  return { text: text.slice(0, MAX_OUTPUT_CHARS), provider, model };
}

/**
 * Models often emit a bare {{nama}}. Without a fallback, every recipient that
 * has no name would be skipped, so guarantee one.
 */
export function ensureNameFallback(text, fallback = 'Bapak/Ibu') {
  return String(text).replace(/\{\{\s*(nama|name)\s*\}\}/gi, (_, v) => `{{${v.toLowerCase()}|${fallback}}}`);
}

/** Pulls {subject, body} out of whatever shape the model answered with. */
export function parseEmailDraft(raw) {
  const text = String(raw || '').trim();

  // 1) JSON, possibly inside a fenced block or surrounded by prose.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const obj = JSON.parse(c.slice(start, end + 1));
        const subject = String(obj.subject ?? obj.subjek ?? '').trim();
        const body = String(obj.body ?? obj.isi ?? obj.text ?? '').trim();
        if (subject && body) return { subject, body };
      } catch { /* try next strategy */ }
    }
  }

  // 2) "Subjek: ..." header followed by the body.
  const m = /^\s*(?:subject|subjek|perihal)\s*:\s*(.+)$/im.exec(text);
  if (m) {
    const body = text.slice(m.index + m[0].length).replace(/^\s*(?:body|isi)\s*:\s*/i, '').trim();
    if (body) return { subject: m[1].trim(), body };
  }

  return null;
}

/**
 * Drafts an email from a short brief.
 * @returns {{subject:string, body:string, provider:string|null, model:string|null}}
 */
export async function generateEmail(aiManager, {
  brief, tone = 'profesional dan ramah', language = 'Bahasa Indonesia',
  audience = '', signature = '', personalize = true, provider, model,
}) {
  if (!String(brief || '').trim()) throw new ComposeError('Brief email wajib diisi', 'bad_request');

  const system = [
    'Kamu adalah asisten penulis email kantor yang ringkas, sopan, dan akurat.',
    `Hari ini: ${todayLine()}.`,
    'Tulis email siap kirim berdasarkan brief. Jangan mengarang fakta, angka, tanggal, atau nama yang tidak ada di brief.',
    'Jika sebuah detail penting tidak diberikan, tulis dengan kalimat yang tetap benar tanpa detail itu — jangan menaruh placeholder acak.',
    personalize
      ? 'Gunakan placeholder {{nama}} untuk nama penerima di salam pembuka (contoh: "Yth. {{nama|Bapak/Ibu}},"). Jangan membuat placeholder lain.'
      : 'Jangan gunakan placeholder; tulis salam yang umum.',
    'Balas HANYA dengan satu objek JSON valid: {"subject": "...", "body": "..."}.',
    'Field body berisi teks biasa (tanpa markdown/HTML), paragraf dipisah baris kosong.',
  ].join('\n');

  const user = [
    `Brief: ${brief}`,
    `Bahasa: ${language}`,
    `Nada: ${tone}`,
    audience && `Penerima: ${audience}`,
    signature && `Tanda tangan di akhir:\n${signature}`,
  ].filter(Boolean).join('\n');

  const { text, provider: usedProvider, model: usedModel } = await collect(
    aiManager,
    [{ role: 'user', content: user }],
    { provider, model, systemPrompt: system, temperature: 0.4, maxTokens: 1500 }
  );

  const draft = parseEmailDraft(text);
  if (!draft) {
    throw new ComposeError('AI tidak mengembalikan format email yang bisa dibaca. Coba lagi atau perjelas brief.', 'unparseable');
  }
  if (personalize) {
    draft.subject = ensureNameFallback(draft.subject);
    draft.body = ensureNameFallback(draft.body);
  }
  return { ...draft, provider: usedProvider, model: usedModel };
}

/** Extracts the first fenced code block (and its language) from a reply. */
export function extractCode(markdown) {
  const m = /```([A-Za-z0-9_+#.-]*)\n([\s\S]*?)```/.exec(String(markdown || ''));
  return m ? { language: m[1] || '', code: m[2].replace(/\s+$/, '') } : { language: '', code: '' };
}

/** Generates code from a plain-language request. */
export async function generateCode(aiManager, { brief, language = '', provider, model }) {
  if (!String(brief || '').trim()) throw new ComposeError('Deskripsi kode wajib diisi', 'bad_request');
  const system = [
    'Kamu adalah software engineer senior. Tulis kode yang benar, aman, dan mudah dirawat.',
    'Jawab dengan: (1) satu blok kode lengkap yang bisa langsung dijalankan, (2) penjelasan singkat cara pakai.',
    'Sertakan penanganan error dasar. Jangan menaruh rahasia/kredensial hard-coded; pakai variabel lingkungan.',
    'Gunakan Bahasa Indonesia untuk penjelasan; komentar kode boleh Bahasa Inggris atau Indonesia.',
  ].join('\n');
  const user = `${language ? `Bahasa pemrograman: ${language}\n` : ''}Permintaan: ${brief}`;

  const { text, provider: p, model: m } = await collect(
    aiManager,
    [{ role: 'user', content: user }],
    { provider, model, systemPrompt: system, temperature: 0.2, maxTokens: 4000 }
  );
  const { language: lang, code } = extractCode(text);
  return { text, code, language: lang || language, provider: p, model: m };
}

/** Free-form text task (summaries, daily reports, announcements...). */
export async function generateText(aiManager, { prompt, provider, model }) {
  if (!String(prompt || '').trim()) throw new ComposeError('Prompt wajib diisi', 'bad_request');
  const system = [
    'Kamu adalah asisten kerja yang ringkas dan akurat.',
    `Hari ini: ${todayLine()}.`,
    'Jangan mengarang data. Jika informasi yang dibutuhkan tidak tersedia, katakan dengan jelas.',
  ].join('\n');
  const { text, provider: p, model: m } = await collect(
    aiManager,
    [{ role: 'user', content: prompt }],
    { provider, model, systemPrompt: system, temperature: 0.5, maxTokens: 3000 }
  );
  return { text, provider: p, model: m };
}
