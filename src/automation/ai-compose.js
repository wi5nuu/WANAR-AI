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

// A greeting that addresses nobody in particular ("Bapak/Ibu,", "Yth. Bapak/Ibu", "Halo Ibu").
const GENERIC_GREETING =
  /^\s*(?:(?:Yth\.?|Kepada(?:\s+Yth\.?)?|Halo|Hai|Selamat\s+(?:pagi|siang|sore|malam))\s+)?(?:Bapak\s*\/\s*Ibu|Bapak\s+atau\s+Ibu|Bapak|Ibu|Saudara(?:\/i)?|Sdr\.?)\s*[,:!]?\s*/i;

/**
 * Models often ignore "start with {{nama|Bapak/Ibu}}" and write a bare
 * "Bapak/Ibu," — which silently loses personalisation. Make it deterministic:
 * a person-facing message always carries the placeholder.
 */
export function ensurePersonalGreeting(text, channel = 'email') {
  const body = String(text || '');
  if (!body.trim() || /\{\{\s*(?:nama|name)\b/i.test(body)) return body;

  const formal = channel === 'email';
  const lead = formal ? 'Yth.' : 'Halo';
  const m = GENERIC_GREETING.exec(body);
  if (m) {
    const sep = formal || m[0].includes('\n') ? '\n\n' : ' ';
    return `${lead} {{nama|Bapak/Ibu}},${sep}${body.slice(m[0].length)}`;
  }
  return formal ? `${lead} {{nama|Bapak/Ibu}},\n\n${body}` : `${lead} {{nama|Bapak/Ibu}}! ${body}`;
}

/**
 * collect() + parse, with ONE corrective retry when the reply is not in the
 * requested shape. Models occasionally answer with prose or a clarifying
 * question; showing the operator an error for that is poor service.
 */
export async function collectParsed(aiManager, messages, options, parse) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const convo = attempt === 0
      ? messages
      : [
        ...messages,
        { role: 'assistant', content: last.text.slice(0, 1500) },
        {
          role: 'user',
          content: 'Balasan tadi bukan dalam format yang diminta. Jangan bertanya balik dan jangan beri penjelasan: '
            + 'balas ulang HANYA dengan satu objek JSON valid sesuai format, tanpa markdown.',
        },
      ];
    last = await collect(aiManager, convo, options);
    const parsed = parse(last.text);
    if (parsed) return { parsed, provider: last.provider, model: last.model, text: last.text, attempts: attempt + 1 };
  }
  return { parsed: null, provider: last.provider, model: last.model, text: last.text, attempts: 2 };
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

  const { parsed: draft, provider: usedProvider, model: usedModel } = await collectParsed(
    aiManager,
    [{ role: 'user', content: user }],
    { provider, model, systemPrompt: system, temperature: 0.4, maxTokens: 2000 },
    parseEmailDraft
  );
  if (!draft) {
    throw new ComposeError('AI tidak mengembalikan format email yang bisa dibaca. Coba lagi atau perjelas brief.', 'unparseable');
  }
  if (personalize) {
    draft.subject = ensureNameFallback(draft.subject);
    draft.body = ensurePersonalGreeting(ensureNameFallback(draft.body), 'email');
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

const CHANNEL_STYLE = {
  telegram: 'pesan Telegram yang singkat (maksimal sekitar 600 karakter)',
  whatsapp: 'pesan WhatsApp yang singkat dan sopan (maksimal sekitar 500 karakter)',
  slack: 'pesan Slack yang ringkas dan jelas',
  discord: 'pesan Discord yang ringkas dan jelas',
  teams: 'pesan Microsoft Teams yang ringkas dan profesional',
  webhook: 'notifikasi singkat berupa teks biasa',
};

/** Extracts {body} from a model reply: JSON first, then the raw text. */
export function parseMessageDraft(raw) {
  const text = String(raw || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  for (const c of [fenced?.[1], text]) {
    if (!c) continue;
    const a = c.indexOf('{');
    const b = c.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        const o = JSON.parse(c.slice(a, b + 1));
        const body = String(o.body ?? o.pesan ?? o.text ?? '').trim();
        if (body) return { body, subject: String(o.subject ?? o.subjek ?? '').trim() };
      } catch { /* fall through */ }
    }
  }
  const plain = text.replace(/^```[a-z]*\n?|```$/gim, '').trim();
  return plain ? { body: plain, subject: '' } : null;
}

/**
 * Drafts a short chat-style message (Telegram / WhatsApp / Slack ...).
 * Unlike email there is no subject line and no formal letter structure.
 */
export async function generateMessage(aiManager, {
  brief, channel = 'telegram', tone = 'ramah dan profesional', language = 'Bahasa Indonesia',
  audience = '', signature = '', personalize = true, provider, model,
}) {
  if (!String(brief || '').trim()) throw new ComposeError('Brief pesan wajib diisi', 'bad_request');
  const style = CHANNEL_STYLE[channel] || 'pesan singkat';

  const system = [
    'Kamu adalah asisten komunikasi kantor yang ringkas dan akurat.',
    `Hari ini: ${todayLine()}.`,
    `Tulis ${style} berdasarkan brief. Jangan mengarang fakta, angka, tanggal, atau nama yang tidak ada di brief.`,
    'Tulis teks biasa saja: tanpa markdown, tanpa HTML, tanpa judul. Boleh 1 emoji bila wajar, jangan berlebihan.',
    personalize
      ? 'Mulai dengan sapaan singkat memakai placeholder {{nama|Bapak/Ibu}} (jangan membuat placeholder lain).'
      : 'Jangan gunakan placeholder; mulai dengan sapaan umum.',
    'Balas HANYA dengan satu objek JSON valid: {"body": "..."}.',
  ].join('\n');

  const user = [
    `Brief: ${brief}`,
    `Bahasa: ${language}`,
    `Nada: ${tone}`,
    audience && `Penerima: ${audience}`,
    signature && `Penutup: ${signature}`,
  ].filter(Boolean).join('\n');

  const { text, provider: p, model: m } = await collect(
    aiManager,
    [{ role: 'user', content: user }],
    { provider, model, systemPrompt: system, temperature: 0.4, maxTokens: 700 }
  );

  const draft = parseMessageDraft(text);
  if (!draft) throw new ComposeError('AI tidak mengembalikan pesan yang bisa dibaca. Coba lagi.', 'unparseable');
  const body = personalize
    ? ensurePersonalGreeting(ensureNameFallback(draft.body), channel)
    : draft.body;
  return { subject: '', body, provider: p, model: m };
}

// ----------------------------------------------------------- all-channel package

const PACKAGE_CHANNELS = ['email', 'telegram', 'whatsapp', 'slack', 'discord', 'teams', 'webhook'];
const TEAM_CHANNELS = new Set(['slack', 'discord', 'teams', 'webhook']);

/** Team/webhook channels have no individual recipient, so "Halo {{nama}}" would read "Halo Bapak/Ibu". */
function teamGreeting(text) {
  return String(text).replace(/\{\{\s*(?:nama|name)\s*(?:\|[^}]*)?\}\}/gi, 'Tim');
}

/** Extracts {name, drafts} from a model reply. Tolerates fences and prose. */
export function parsePackage(raw) {
  const text = String(raw || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  for (const c of [fenced?.[1], text]) {
    if (!c) continue;
    const a = c.indexOf('{');
    const b = c.lastIndexOf('}');
    if (a === -1 || b <= a) continue;
    try {
      const o = JSON.parse(c.slice(a, b + 1));
      const pick = (v) => (typeof v === 'string' ? v : v?.body ?? v?.text ?? '');
      const drafts = {};
      for (const ch of PACKAGE_CHANNELS) {
        const v = o[ch];
        const body = String(pick(v) || '').trim();
        if (!body) continue;
        drafts[ch] = { subject: ch === 'email' ? String(v?.subject ?? v?.subjek ?? '').trim() : '', body };
      }
      if (Object.keys(drafts).length) return { name: String(o.name ?? o.nama ?? '').trim(), drafts };
    } catch { /* try next */ }
  }
  return null;
}

/**
 * One brief -> ready-to-edit templates for EVERY channel plus a campaign name.
 * A single model call keeps the versions consistent with each other.
 */
export async function generatePackage(aiManager, {
  brief, tone = 'profesional dan ramah', language = 'Bahasa Indonesia', audience = '',
  signature = '', personalize = true, provider, model,
}) {
  if (!String(brief || '').trim()) throw new ComposeError('Brief wajib diisi', 'bad_request');

  const system = [
    'Kamu adalah asisten komunikasi kantor yang ringkas, sopan, dan akurat.',
    `Hari ini: ${todayLine()}.`,
    'Dari satu brief, tulis versi pesan untuk SETIAP kanal berikut dengan isi/fakta yang sama, hanya gayanya yang disesuaikan:',
    '- email: formal, ada salam pembuka dan penutup, field "subject" + "body" (paragraf dipisah baris kosong).',
    '- telegram: singkat (maks ~600 karakter), ramah, boleh 1 emoji wajar.',
    '- whatsapp: sangat ringkas (maks ~500 karakter), sopan, tanpa format markdown.',
    '- slack, discord, teams: gaya pengumuman tim, 2-4 baris, jelas dan to the point.',
    '- webhook: satu kalimat notifikasi.',
    'Jangan mengarang fakta, angka, tanggal, atau nama yang tidak ada di brief. Teks biasa: tanpa markdown dan tanpa HTML.',
    personalize
      ? 'Untuk email, telegram, dan whatsapp mulai dengan sapaan memakai {{nama|Bapak/Ibu}}. Jangan membuat placeholder lain.'
      : 'Jangan gunakan placeholder; pakai sapaan umum.',
    'Tambahkan "name": judul kampanye singkat (maks 60 karakter).',
    'Balas HANYA satu objek JSON valid dengan bentuk: ' +
      '{"name":"","email":{"subject":"","body":""},"telegram":{"body":""},"whatsapp":{"body":""},' +
      '"slack":{"body":""},"discord":{"body":""},"teams":{"body":""},"webhook":{"body":""}}',
  ].join('\n');

  const user = [
    `Brief: ${brief}`,
    `Bahasa: ${language}`,
    `Nada: ${tone}`,
    audience && `Penerima: ${audience}`,
    signature && `Tanda tangan/penutup: ${signature}`,
  ].filter(Boolean).join('\n');

  // Seven channels is a big JSON object, and reasoning models spend part of the
  // budget "thinking": give it room, and retry once with a correction.
  const { parsed, provider: p, model: m } = await collectParsed(
    aiManager,
    [{ role: 'user', content: user }],
    { provider, model, systemPrompt: system, temperature: 0.4, maxTokens: 4000 },
    parsePackage
  );
  if (!parsed) throw new ComposeError('AI tidak mengembalikan paket template yang bisa dibaca. Coba lagi.', 'unparseable');

  // Every channel must end up with a usable template, even if the model skipped one.
  const chatFallback = parsed.drafts.telegram?.body || parsed.drafts.whatsapp?.body
    || parsed.drafts.email?.body.slice(0, 500) || '';
  const drafts = {};
  for (const ch of PACKAGE_CHANNELS) {
    let d = parsed.drafts[ch];
    if (!d) {
      d = ch === 'email'
        ? { subject: parsed.name || String(brief).slice(0, 80), body: chatFallback }
        : { subject: '', body: chatFallback };
    }
    let body = personalize ? ensureNameFallback(d.body) : d.body;
    if (personalize && !TEAM_CHANNELS.has(ch)) body = ensurePersonalGreeting(body, ch);
    let subject = personalize ? ensureNameFallback(d.subject) : d.subject;
    if (TEAM_CHANNELS.has(ch)) {
      body = teamGreeting(body);
      subject = teamGreeting(subject);
      // A shared channel is not "Bapak/Ibu": "Bapak/Ibu," -> "Halo Tim,".
      if (ch !== 'webhook') {
        const m = GENERIC_GREETING.exec(body);
        if (m) body = `Halo Tim,${m[0].includes('\n') ? '\n' : ' '}${body.slice(m[0].length)}`;
      }
    }
    drafts[ch] = { subject, body };
  }

  const name = (parsed.name || String(brief).trim().replace(/\s+/g, ' ')).slice(0, 80);
  return { name, drafts, provider: p, model: m };
}
