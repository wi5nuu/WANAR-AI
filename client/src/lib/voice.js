/**
 * voice.js — helper TTS Bahasa Indonesia semanusiawi untuk chat UI.
 * Prioritas: TTS server (/api/voice/tts, bila ada key) → suara natural browser (id-ID).
 */

export function humanizeForSpeech(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, ' tautan ')
    .replace(/[*_#`>|~]/g, '')
    .replace(/\s*-\s+/g, ', ')
    .replace(/\n+/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.{3,}/g, '... ')
    .trim()
    .slice(0, 1200);
}

export function splitSentences(text) {
  const parts = String(text).split(/(?<=[.!?…\n])\s+/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0 && text.trim()) return [text.trim()];
  const out = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1].length < 40) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out;
}

export function pickBestVoice(voices) {
  const list = voices || [];
  if (!list.length) return null;
  const score = (v) => {
    let s = 0;
    if (/^id([-_]|$)/i.test(v.lang)) s += 100;
    if (/indonesi/i.test(v.name)) s += 60;
    if (/natural|neural/i.test(v.name)) s += 40;
    if (/google bahasa indonesia/i.test(v.name)) s += 30;
    if (/google/i.test(v.name)) s += 15;
    if (/microsoft/i.test(v.name)) s += 12;
    if (/female|gadis|zira|aria|jenny/i.test(v.name)) s += 5;
    if (/^en([-_]|$)/i.test(v.lang)) s -= 20;
    return s;
  };
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Intonasi berperasaan: rate/pitch/jeda menyesuaikan isi kalimat,
 * seperti orang yang ngomong pakai perasaan (naik-turun, tidak datar).
 */
export function prosodyFor(sentence) {
  const s = String(sentence || '');
  let rate = 1.0;
  let pitch = 1.06;
  let pause = 220;
  if (/\?\s*$/.test(s)) { pitch = 1.16; pause = 380; }          // tanya → nada naik
  else if (/!\s*$/.test(s)) { pitch = 1.12; rate = 1.04; pause = 340; } // seru → antusias
  else if (/[….]\s*$/.test(s)) { pause = 300; }
  if (/(hehe|haha|hihi|wkwk|wah|aduh|yah+|maaf|tenang|sabar|astaga|waduh|ikut |sedih|senang|kasihan|semangat)/i.test(s)) {
    rate = Math.min(rate, 0.95);   // empati / tawa → sedikit melambat, hangat
    pitch = Math.max(pitch, 1.09);
    pause = Math.max(pause, 320);
  }
  if (s.length > 150) rate = Math.min(rate, 0.96); // kalimat panjang → tidak ngebut
  return { rate, pitch, pause };
}

// ---- Anti-echo: jangan anggap suara AI sendiri sebagai omongan user ----
const recentSpoken = []; // kalimat AI yang baru dibunyikan (max 6)

function normEcho(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Catat kalimat yang baru dibunyikan speaker (server maupun native). */
export function noteSpoken(sentence) {
  const n = normEcho(sentence);
  if (!n) return;
  recentSpoken.push(n);
  if (recentSpoken.length > 6) recentSpoken.shift();
}

/** True bila transkrip mic kemungkinan besar adalah gema suara AI sendiri. */
export function isEcho(transcript) {
  const t = normEcho(transcript);
  if (t.length < 4) return false; // terlalu pendek — anggap user ("ya", "oke")
  return recentSpoken.some((r) => {
    if (!r) return false;
    if (r.includes(t) || t.includes(r)) return true;
    const tw = t.split(' ').filter(w => w.length > 2);
    if (tw.length < 3) return false;
    let hit = 0;
    for (const w of tw) if (r.includes(w)) hit++;
    return hit / tw.length > 0.65;
  });
}

let serverTTS = null; // null = belum dicek, true/false sesudahnya

/**
 * WAJIB dipanggil sinkron di dalam klik tombol (user gesture) sebelum TTS pertama.
 * Membuka kunci audio browser (AudioContext + speechSynthesis) agar sapaan
 * pertama benar-benar BUNYI, bukan cuma muncul teks.
 */
export function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      unlockAudio._ctx = unlockAudio._ctx || new AC();
      if (unlockAudio._ctx.state === 'suspended') unlockAudio._ctx.resume().catch(() => {});
    }
  } catch { /* noop */ }
  try {
    const sy = window.speechSynthesis;
    if (sy) {
      try { sy.cancel(); } catch { /* noop */ }
      sy.getVoices(); // hangatkan daftar suara
    }
  } catch { /* noop */ }
}

async function checkServerTTS() {
  try {
    const r = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Tes.' }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function isServerTTSAvailable() {
  if (serverTTS === null) serverTTS = await checkServerTTS();
  return serverTTS;
}

/** Engine TTS aktif: 'server' | 'browser' | 'cek…'. Untuk status diagnostik UI. */
export function getTTSEngine() {
  return serverTTS === true ? 'server' : serverTTS === false ? 'browser' : 'cek…';
}

let lastTTSError = '';
let lastTTSVoice = '';
export function getLastTTSError() { return lastTTSError; }
export function getLastTTSVoice() { return lastTTSVoice; }

function keepAliveStart(sy) {
  // Hack Chrome: cegah suara mati di tengah kalimat panjang (>15 dtk).
  try {
    return setInterval(() => {
      try { if (sy.speaking && !sy.paused) { sy.pause(); sy.resume(); } } catch { /* noop */ }
    }, 8000);
  } catch { return null; }
}

function keepAliveStop(h) {
  try { if (h) clearInterval(h); } catch { /* noop */ }
}

// Ucapkan sekali via suara browser. Return { ok, error } — error PENTING untuk diagnosis.
export function speakNativeOnce(text, voice) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      if (err) lastTTSError = err;
      resolve({ ok, error: err || '' });
    };
    try {
      const sy = (typeof window !== 'undefined' ? window.speechSynthesis : null);
      if (!sy) return done(false, 'no-synthesis');
      const v = voice !== undefined ? voice : pickBestVoice(sy.getVoices());
      const u = new SpeechSynthesisUtterance(text);
      if (v) {
        u.voice = v;
        try { u.lang = v.lang || 'id-ID'; } catch { /* noop */ }
        lastTTSVoice = v.name || '';
      } else {
        u.lang = 'id-ID';
        lastTTSVoice = '(default browser)';
      }
      const p = prosodyFor(text);
      u.rate = p.rate;
      u.pitch = p.pitch;
      u.volume = 1.0;
      const ka = keepAliveStart(sy);
      u.onend = () => { keepAliveStop(ka); done(true); };
      u.onerror = (e) => { keepAliveStop(ka); done(false, (e && e.error) || 'unknown'); };
      sy.speak(u);
    } catch (e) { done(false, String((e && e.message) || e)); }
  });
}

/** Native dengan 1x retry pakai suara default bila voice spesifik ditolak. */
export async function speakNativeRobust(text) {
  const sy = (typeof window !== 'undefined' ? window.speechSynthesis : null);
  const v = sy ? pickBestVoice(sy.getVoices()) : null;
  let r = await speakNativeOnce(text, v);
  if (!r.ok && v && /language|voice|synthesis/i.test(r.error || '')) {
    r = await speakNativeOnce(text, null);
  }
  return r;
}

/** Putar Blob audio. Resolve { ok:true } saat SELESAI bunyi, { ok:false, error } bila gagal mulai. */
export function playAudioBlob(blob) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, err, via) => {
      if (settled) return;
      settled = true;
      resolve({ ok, error: err || '', via: via || '' });
    };
    try {
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      activeEl = a;
      a.onended = () => { URL.revokeObjectURL(url); if (activeEl === a) activeEl = null; done(true, '', 'element'); };
      a.onerror = async () => {
        // Jalur 2: WebAudio decode+play (decoder berbeda — sering lolos saat <audio> gagal).
        URL.revokeObjectURL(url);
        if (activeEl === a) activeEl = null;
        const w = await playViaWebAudio(blob);
        if (w.ok) done(true, '', 'webaudio');
        else done(false, 'audio-error+decode-failed');
      };
      const pr = a.play();
      if (pr && typeof pr.catch === 'function') {
        pr.catch(async () => {
          // play() ditolak (biasanya izin autoplay) → coba WebAudio yang lebih longgar.
          try { URL.revokeObjectURL(url); } catch { /* noop */ }
          if (activeEl === a) activeEl = null;
          const w = await playViaWebAudio(blob);
          if (w.ok) done(true, '', 'webaudio');
          else done(false, w.error || 'play-rejected');
        });
      }
    } catch (e) { done(false, String((e && e.message) || e)); }
  });
}

let activeEl = null;   // elemen <audio> yang sedang bunyi (jalur server)
let activeSrc = null;  // buffer source WebAudio yang sedang bunyi

function getCtx() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!getCtx._c) getCtx._c = new AC();
    const c = getCtx._c;
    if (c.state === 'suspended') c.resume().catch(() => {});
    return c;
  } catch { return null; }
}

function playViaWebAudio(blob) {
  return (async () => {
    const ctx = getCtx();
    if (!ctx) return { ok: false, error: 'no-webaudio' };
    try {
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* noop */ } }
      const ab = await blob.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      return await new Promise((res) => {
        try {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          activeSrc = src;
          src.onended = () => { if (activeSrc === src) activeSrc = null; res({ ok: true }); };
          try { src.start(); } catch (e) {
            if (activeSrc === src) activeSrc = null;
            res({ ok: false, error: 'src-start-fail' });
          }
        } catch (e) { res({ ok: false, error: 'decode-failed' }); }
      });
    } catch (e) { return { ok: false, error: 'decode-failed' }; }
  })();
}

/** Hentikan semua audio jalur server (dipakai tombol stop/sela/ganti mode). */
export function stopServerAudio() {
  try { if (activeEl) { const a = activeEl; activeEl = null; a.pause(); } } catch { /* noop */ }
  try { if (activeSrc) { const s = activeSrc; activeSrc = null; try { s.stop(); } catch { /* noop */ } } } catch { /* noop */ }
}

/** Buang cache audio teks ini (dipakai saat blob terbukti rusak agar fetch ulang). */
export function evictTTSCache(text) {
  try { audioCache.delete(String(text || '').slice(0, 500)); } catch { /* noop */ }
}

// Cache audio per kalimat — filler & sapaan yang diulang jadi instan (tanpa fetch).
const audioCache = new Map(); // teks(≤500 char) -> Blob, maks 30

/** Ambil audio TTS server (cache dulu). Return Blob atau null bila tak tersedia/gagal. */
export async function fetchTTSAudio(text) {
  const key = String(text || '').slice(0, 500);
  if (!key.trim()) return null;
  if (audioCache.has(key)) return audioCache.get(key);
  if (!(await isServerTTSAvailable())) return null;
  try {
    const r = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: key }),
      signal: AbortSignal.timeout(12000), // jangan diam selamanya kalau server macet
    });
    if (r.status === 501) { serverTTS = false; return null; }
    if (!r.ok) return null;
    const blob = await r.blob();
    if (!blob || !blob.size) return null;
    if (audioCache.size >= 30) audioCache.delete(audioCache.keys().next().value);
    audioCache.set(key, blob);
    return blob;
  } catch {
    return null;
  }
}

/** Hangatkan cache agar kalimat pembuka/filler bunyi seketika (fire-and-forget). */
export function prefetchTTS(texts) {
  (texts || []).forEach((t) => { try { fetchTTSAudio(t); } catch { /* noop */ } });
}

/** Speaker antrean yang bisa dibatalkan.
 *  enqueue() → kalimat diucapkan berurutan (FIFO), cocok untuk TTS sambil streaming.
 *  waitIdle() → resolve saat antrean habis (untuk lanjut mendengarkan).
 *  cancel() → hentikan semuanya seketika.
 *  Teknik cepat: audio kalimat BERIKUTNYA di-fetch selagi kalimat ini bunyi (lookahead),
 *  + kalimat yang pernah bunyi diambil dari cache.
 */
export function createSpeaker() {
  let queue = [];
  let pumping = false;
  let settle = null; // penyelesai kalimat yang sedang bunyi (dipakai cancel)
  let idleResolvers = [];
  let runId = 0; // generasi pump — cancel() menaikkan agar loop lama berhenti

  const synth = () => (typeof window !== 'undefined' ? window.speechSynthesis : null);

  const finishIdle = () => {
    const rs = idleResolvers;
    idleResolvers = [];
    rs.forEach(r => { try { r(); } catch { /* noop */ } });
  };

  const cancel = () => {
    runId++;
    queue = [];
    try { synth()?.cancel(); } catch { /* noop */ }
    try { stopServerAudio(); } catch { /* noop */ }
    if (settle) { const f = settle; settle = null; try { f(false); } catch { /* noop */ } }
    pumping = false;
    finishIdle();
  };

  const waitIdle = () => new Promise((res) => {
    if (!pumping && queue.length === 0) res();
    else idleResolvers.push(res);
  });

  const playNative = (s, myRun) => new Promise((resolve) => {
    const attempt = (voice, retried) => {
      try {
        const sy = synth();
        if (!sy || myRun !== runId) return resolve(false);
        const u = new SpeechSynthesisUtterance(s);
        if (voice) {
          u.voice = voice;
          try { u.lang = voice.lang || 'id-ID'; } catch { /* noop */ }
          lastTTSVoice = voice.name || '';
        } else {
          u.lang = 'id-ID';
          lastTTSVoice = '(default browser)';
        }
        const p = prosodyFor(s);
        u.rate = p.rate;
        u.pitch = p.pitch;
        u.volume = 1.0;
        const ka = keepAliveStart(sy);
        settle = (val) => { settle = null; keepAliveStop(ka); resolve(val); };
        u.onend = () => { if (settle) settle(true); };
        u.onerror = (e) => {
          const err = (e && e.error) || 'unknown';
          lastTTSError = err;
          keepAliveStop(ka);
          if (!retried && voice && /language|voice|synthesis/i.test(err)) {
            settle = null; // reset agar attempt berikut pasang baru
            attempt(null, true); // retry 1x pakai suara default
          } else if (settle) settle(false);
        };
        sy.speak(u);
      } catch { resolve(false); }
    };
    const sy0 = synth();
    attempt(sy0 ? pickBestVoice(sy0.getVoices()) : null, false);
  });

  // Putar blob via jalur bersama (element → WebAudio fallback). Record ke settle agar cancel tembus.
  const playBlob = (blob, myRun) => new Promise((resolve) => {
    settle = (val) => { settle = null; resolve(val); };
    if (myRun !== runId) return settle(false);
    playAudioBlob(blob).then((r) => { if (settle) settle(r.ok); });
  });

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    const myRun = runId;
    await isServerTTSAvailable();
    let lookahead = null; // { key, promise } audio kalimat berikut
    while (queue.length && myRun === runId) {
      const s = queue.shift();
      noteSpoken(s); // untuk echo guard: ini suara AI, bukan user
      const pause = prosodyFor(s).pause;
      if (serverTTS) {
        // Pakai hasil lookahead bila cocok, kalau tidak fetch langsung.
        let blob = null;
        if (lookahead && lookahead.key === s.slice(0, 500)) {
          try { blob = await lookahead.promise; } catch { blob = null; }
        } else {
          blob = await fetchTTSAudio(s);
        }
        // Siapkan lookahead kalimat berikut selagi yang ini bunyi.
        lookahead = queue.length
          ? { key: queue[0].slice(0, 500), promise: fetchTTSAudio(queue[0]) }
          : null;
        if (myRun !== runId) break;
        if (blob) {
          await playBlob(blob, myRun);
        } else {
          await playNative(s, myRun); // server gagal sesaat → native sekali jalan
        }
      } else {
        await playNative(s, myRun);
      }
      if (queue.length && myRun === runId && pause > 0) {
        await new Promise((r) => setTimeout(r, Math.min(pause, 450))); // jeda napas alami
      }
    }
    if (myRun === runId) {
      pumping = false;
      finishIdle();
    }
  };

  const enqueue = (text) => {
    const clean = humanizeForSpeech(text);
    if (!clean) return;
    for (const s of splitSentences(clean)) queue.push(s);
    pump();
  };

  const speak = (text) => { enqueue(text); return waitIdle(); };

  return { enqueue, speak, waitIdle, cancel };
}
