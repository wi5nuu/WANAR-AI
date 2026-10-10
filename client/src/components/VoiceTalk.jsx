/**
 * VoiceTalk — ngobrol suara Bahasa Indonesia yang simpel, responsif, realtime.
 *
 * - Tiap masuk halaman selalu muncul popup "Mulai Bicara".
 * - Kiri: obrolan suara. Kanan: browser yang dibuka AI (split 2 layar).
 * - "buka youtube cari X" / "buka browser" / "carikan info kerja" langsung dibuka terlihat.
 * - Suara dibuat semanusiawi mungkin: TTS server (bila ada key) + suara natural
 *   browser (id-ID) + bicara per kalimat sambil streaming (realtime) + barge-in.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import DashboardLayout from './DashboardLayout';
import { prosodyFor, noteSpoken, isEcho, fetchTTSAudio, isServerTTSAvailable, prefetchTTS, unlockAudio, speakNativeOnce, playAudioBlob, stopServerAudio, evictTTSCache, getLastTTSError, getLastTTSVoice, getTTSEngine } from '../lib/voice';
import './voice-talk.css';

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? (window.SpeechRecognition || window.webkitSpeechRecognition)
    : null;

// ---------- helpers: perintah browser lokal (respon instan, tanpa tunggu AI) ----------
function parseLocalCommand(raw) {
  const t = (raw || '').toLowerCase().trim();
  if (!t) return null;

  // buka youtube cari X
  let m = t.match(/buka(?:kan)?\s*youtube(?:\s*(?:cari|carikan|tentang|video)?\s*(.+))?/);
  if (m) {
    const q = (m[1] || '').replace(/^(tentang|video|dong|ya|tolong)\s+/g, '').trim();
    if (q) {
      return {
        kind: 'youtube-search', query: q, label: `YouTube: ${q}`,
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
        embed: `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(q)}`,
      };
    }
    return { kind: 'youtube', label: 'YouTube', url: 'https://www.youtube.com', embed: 'https://www.youtube.com/embed' };
  }
  // putar / cari video X di youtube
  m = t.match(/(?:putar|cari|carikan|buka).{0,20}?(?:di\s*youtube|youtube).{0,10}?(.*)/);
  if (m && m[1] && m[1].trim().length > 1) {
    const q = m[1].trim();
    return {
      kind: 'youtube-search', query: q, label: `YouTube: ${q}`,
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
      embed: `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(q)}`,
    };
  }
  // cari kerja / info loker X
  m = t.match(/(?:cari|carikan|info|inpo|loker|lowongan|kerja).{0,30}?(kerja|loker|lowongan|job|magang|intern)/);
  if (m) {
    const q = t
      .replace(/tolong|carikan|cari|dong|ya|info|inpo|tentang|kerja|loker|lowongan|pekerjaan|job|yang|untuk|saya|aku|di|jakarta|bekasi|bandung|remote/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const query = q || 'IT support Bekasi';
    return {
      kind: 'jobs', query, label: `Loker: ${query}`,
      url: `https://glints.com/id/opportunities?q=${encodeURIComponent(query)}`,
      links: [
        { label: 'Glints', url: `https://glints.com/id/opportunities?q=${encodeURIComponent(query)}` },
        { label: 'Jobstreet', url: `https://www.jobstreet.co.id/id/job-search/${encodeURIComponent(query)}-jobs/` },
        { label: 'LinkedIn', url: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(query)}&location=Indonesia` },
      ],
    };
  }
  // buka browser / buka google [cari X]
  m = t.match(/buka(?:kan)?\s*(browser|google|chrome)(?:\s*(?:cari|carikan|tentang)?\s*(.+))?/);
  if (m) {
    const q = (m[2] || '').trim();
    if (q) {
      return {
        kind: 'google', query: q, label: `Google: ${q}`,
        url: `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=id`,
      };
    }
    return { kind: 'google', label: 'Google', url: 'https://www.google.com/?hl=id' };
  }
  return null;
}

// ---------- helpers: TTS semanusiawi ----------
function humanizeForSpeech(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, ' tautan ')
    .replace(/[*_#`>|~]/g, '')
    .replace(/\s*-\s+/g, ', ')
    .replace(/\n+/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.{3,}/g, '... ')
    .trim()
    .slice(0, 900);
}

function splitSentences(text) {
  const parts = String(text).split(/(?<=[.!?…\n])\s+/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0 && text.trim()) return [text.trim()];
  // gabung potongan terlalu pendek agar tidak patah-patah
  const out = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1].length < 40) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out;
}

// Sahutan instan agar AI terasa langsung respon (< 1 detik); jawaban asli nyusul streaming.
// Nada: formal khas AI agent, tetap santai. Nama user hanya sesekali, bukan tiap kalimat.
const FILLERS = [
  'Baik, sebentar ya.',
  'Oke, saya cek dulu.',
  'Sebentar, saya carikan.',
  'Siap, saya siapkan jawabannya.',
];

export default function VoiceTalk() {
  const [showWelcome, setShowWelcome] = useState(true); // popup tiap masuk halaman
  const [callState, setCallState] = useState('idle');   // idle | listening | thinking | speaking
  const [turns, setTurns] = useState([]);
  const [interim, setInterim] = useState('');
  const [loading, setLoading] = useState(false); // loading saat nunggu jawaban AI
  const [switchNotice, setSwitchNotice] = useState(''); // info pindah model otomatis
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [browser, setBrowser] = useState(null); // { label, url, embed?, links?, screenshot?, title? }
  const [voices, setVoices] = useState([]);
  const [provider, setProvider] = useState(
    () => localStorage.getItem('wanar_voice_provider') || 'openagentic'
  );
  const [model, setModel] = useState(
    () => localStorage.getItem('wanar_voice_model_v2') || 'deepseek-v4.1-flash-free'
  );

  const callActiveRef = useRef(false);
  const speakingRef = useRef(false);
  const busyRef = useRef(false); // true saat thinking (abaikan mic baru)
  const recognitionRef = useRef(null);
  const historyRef = useRef([]);
  const abortRef = useRef(null);
  const speakQueueRef = useRef([]);
  const speakRunningRef = useRef(false);
  const lastFinalAt = useRef(0);
  const fillerIdx = useRef(0);
  const pendingRef = useRef([]);   // antrean omongan user (FIFO, maks 2) — giliran profesional
  const coolUntilRef = useRef(0);  // abaikan mic sesaat setelah AI berhenti (ekor gema)
  const micEnabledRef = useRef(false);
  const turnStartRef = useRef(0);  // performance.now() saat omongan user dikirim
  const ttfbRef = useRef(null);    // detik: token pertama tiba
  const tFirstAudioRef = useRef(null); // detik: suara pertama bunyi
  const tickRef = useRef(null);    // interval detik loading
  const [queued, setQueued] = useState([]); // cerminan pendingRef untuk UI
  const [elapsed, setElapsed] = useState(0); // detik loading berjalan
  const [loadStage, setLoadStage] = useState(''); // tahap loading detail
  const [lastTiming, setLastTiming] = useState(null); // ringkasan waktu giliran terakhir
  const [ttsStatus, setTtsStatus] = useState(''); // hasil diagnostik Tes Suara
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const browserRef = useRef(null);
  browserRef.current = browser;

  const supported = Boolean(SpeechRecognitionImpl);
  const inCall = callState !== 'idle';
  const stateLabel = {
    idle: 'Belum mulai', listening: 'Mendengarkan… silakan berbicara',
    thinking: 'Sebentar, saya proses dulu…', speaking: 'Saya sedang berbicara… (sela saja bila perlu)',
  }[callState];

  const addTurn = useCallback((role, text) => {
    setTurns(prev => [...prev.slice(-49), { role, text, at: Date.now() }]);
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns, interim, loading, lastTiming]);

  // Default model otomatis dari server (FREE) — tanpa dropdown, tanpa ribet.
  // Kalau kuota habis, backend failover pindah sendiri + kasih notice.
  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(c => {
      const savedP = localStorage.getItem('wanar_voice_provider');
      const p = (savedP && c?.[savedP]) ? savedP : (c?.defaultProvider || 'openagentic');
      setProvider(p);
      const ids = (c?.[p]?.models || []).map(m => m.id || m);
      const savedM = localStorage.getItem('wanar_voice_model_v2');
      const m = (savedM && ids.includes(savedM)) ? savedM : (c?.[p]?.defaultModel || ids[0] || 'deepseek-v4.1-flash-free');
      setModel(m);
    }).catch(() => {});
  }, []);

  // Daftar suara + pilih yang paling natural Indonesia.
  useEffect(() => {
    if (!window.speechSynthesis) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, []);

  // ---- TTS: server dulu (paling manusiawi), fallback suara natural browser ----
  // Fungsi inti dari lib (ada error capture + retry + anti-mati-tengah-jalan).
  // noteSpoken dipanggil di pump agar echo guard tahu ini suara AI.
  const speakNative = useCallback((sentence) => {
    return speakNativeOnce(sentence).then(() => {});
  }, []);

  // Tandai detik suara pertama bunyi (untuk ringkasan waktu).
  const markFirstAudio = useCallback(() => {
    if (tFirstAudioRef.current == null && turnStartRef.current) {
      tFirstAudioRef.current = (performance.now() - turnStartRef.current) / 1000;
    }
  }, []);

  // 🔊 Tes Suara: diagnosis berlapis + hasilnya DITULIS di layar.
  // Kalau AI diam, tombol ini bilang persis macetnya di mana (server? browser? volume?).
  const testSound = useCallback(async () => {
    try { unlockAudio(); } catch { /* noop */ }
    const KAL = 'Halo, Wisnu. Ini tes suara. Kalau terdengar jelas, berarti suaranya sudah berjalan.';
    setTtsStatus('⏳ Mengetes suara server…');
    try {
      const blob = await fetchTTSAudio(KAL);
      if (blob) {
        setTtsStatus(`✅ Server OK (${(blob.size / 1024).toFixed(0)} KB) — memutar, dengarkan…`);
        const r = await playAudioBlob(blob);
        if (r.ok) {
          setTtsStatus(`✅ Selesai bunyi (via ${r.via === 'webaudio' ? 'WebAudio' : 'pemutar standar'}). Apakah terdengar? Kalau tidak, cek volume/speaker laptop.`);
          return;
        }
        // Blob bermasalah → buang dari cache lalu lanjut tes browser (jangan berhenti).
        evictTTSCache(KAL);
        setTtsStatus(`⚠️ Jalur standar gagal (${r.error}), coba jalur browser…`);
      }
    } catch (e) { /* lanjut ke tes browser */ }
    setTtsStatus('⏳ Mengetes suara browser…');
    const r = await speakNativeOnce(KAL);
    if (r.ok) {
      setTtsStatus(`✅ Suara browser bunyi (voice: ${getLastTTSVoice() || 'default'}). Dengar? Kalau tidak, cek volume/speaker.`);
    } else {
      const err = r.error || getLastTTSError() || 'unknown';
      setTtsStatus(`❌ Browser menolak bicara (error: ${err}). Pakai Chrome/Edge terbaru, cek volume & speaker, pastikan tab tidak di-mute.`);
    }
  }, []);

  // Nyalakan mic kembali — hanya saat AI benar-benar diam (half-duplex),
  // dengan jeda 700ms agar ekor suara speaker tidak kerekam.
  const resumeListening = useCallback(() => {
    if (!callActiveRef.current || busyRef.current || speakingRef.current) return;
    if (!micEnabledRef.current || !recognitionRef.current) return;
    coolUntilRef.current = Date.now() + 700;
    setTimeout(() => {
      if (!callActiveRef.current || busyRef.current || speakingRef.current) return;
      if (!micEnabledRef.current) return;
      try { recognitionRef.current?.start(); } catch { /* sudah nyala */ }
    }, 750);
  }, []);

  const pumpSpeakQueue = useCallback(async () => {
    if (speakRunningRef.current) return;
    speakRunningRef.current = true;
    // Mic TETAP nyala selama AI bersuara (full-duplex): omongan user saat AI
    // menjawab tetap ketangkap → masuk antrean. Gema suara AI dibuang via isEcho.
    await isServerTTSAvailable();
    let lookahead = null; // { key, promise } audio kalimat berikut (fetch selagi bunyi)
    while (speakQueueRef.current.length && callActiveRef.current) {
      const sentence = speakQueueRef.current.shift();
      speakingRef.current = true;
      setCallState('speaking');
      noteSpoken(sentence); // echo guard untuk jalur audio server
      markFirstAudio();
      if (await isServerTTSAvailable()) {
        let blob = null;
        if (lookahead && lookahead.key === sentence.slice(0, 500)) {
          try { blob = await lookahead.promise; } catch { blob = null; }
        } else {
          blob = await fetchTTSAudio(sentence);
        }
        lookahead = speakQueueRef.current.length
          ? { key: speakQueueRef.current[0].slice(0, 500), promise: fetchTTSAudio(speakQueueRef.current[0]) }
          : null;
        if (!callActiveRef.current) break;
        if (blob) {
          // Jalur bersama: <audio> → WebAudio fallback bila decode gagal.
          const pr = await playAudioBlob(blob);
          if (!pr.ok) {
            evictTTSCache(sentence); // blob rusak → jangan pakai cache ini lagi
            await speakNative(sentence);
          }
        } else {
          await speakNative(sentence); // server gagal sesaat → native sekali jalan
        }
      } else {
        await speakNative(sentence);
      }
      // Jeda napas alami antar kalimat (intonasi manusiawi).
      if (speakQueueRef.current.length && callActiveRef.current) {
        await new Promise((r) => setTimeout(r, Math.min(prosodyFor(sentence).pause, 450)));
      }
    }
    speakRunningRef.current = false;
    speakingRef.current = false;
    if (callActiveRef.current && !busyRef.current) {
      setCallState('listening');
      // Sapaan selesai tapi user sempat ngomong → proses antrean langsung.
      const next = pendingRef.current.shift();
      setQueued([...pendingRef.current]);
      if (next) {
        addTurn('user', next);
        historyRef.current.push({ role: 'user', content: next });
        sendToAIRef.current?.(next, { fromQueue: true });
      } else {
        resumeListening(); // mic nyala lagi hanya setelah AI selesai total
      }
    }
  }, [speakNative, resumeListening, addTurn, markFirstAudio]);

  const queueSpeak = useCallback((text) => {
    const clean = humanizeForSpeech(text);
    if (!clean) return;
    for (const s of splitSentences(clean)) speakQueueRef.current.push(s);
    pumpSpeakQueue();
  }, [pumpSpeakQueue]);

  const stopSpeaking = useCallback(() => {
    // Sela manual via ketuk orb: hentikan suara, mic langsung dengar lagi.
    speakQueueRef.current = [];
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    try { stopServerAudio(); } catch { /* noop */ }
    speakingRef.current = false;
    speakRunningRef.current = false;
    if (callActiveRef.current && !busyRef.current) {
      setCallState('listening');
      resumeListening();
    }
  }, [resumeListening]);

  // ---- kirim ke AI (streaming, bicara per kalimat = realtime) ----
  // Giliran profesional: satu omongan diselesaikan penuh dulu, sisanya antre FIFO.
  const sendToAI = useCallback(async (userText, opts = {}) => {
    if (busyRef.current || !callActiveRef.current) return;
    busyRef.current = true;
    // Mic TETAP nyala selama thinking & speaking (full-duplex + echo guard):
    // omongan baru masuk antrean FIFO, gema suara AI dibuang otomatis.
    setCallState('thinking');
    setLoading(true); // loading nyala: user tahu AI lagi kerja
    setSwitchNotice('');
    setInterim('');
    setError('');
    // Timer detik loading: mulai dari omongan user dikirim.
    turnStartRef.current = performance.now();
    ttfbRef.current = null;
    tFirstAudioRef.current = null;
    setElapsed(0);
    setLoadStage('mengirim ke AI…');
    setLastTiming(null);
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      if (turnStartRef.current) setElapsed((performance.now() - turnStartRef.current) / 1000);
    }, 200);
    // Sahutan instan: langsung bunyi < 1 detik, jawaban asli nyusul per kalimat.
    queueSpeak(opts.fromQueue
      ? 'Baik, saya lanjutkan yang tadi. Sebentar ya.'
      : FILLERS[fillerIdx.current++ % FILLERS.length]);

    // Respon instan di panel kanan (tanpa tunggu AI) → terasa realtime.
    const local = parseLocalCommand(userText);
    if (local) setBrowser(prev => ({ ...(prev || {}), ...local }));

    const ab = new AbortController();
    abortRef.current = ab;
    let full = '';
    let sentHead = 0; // posisi kalimat yang sudah diucapkan

    const flushNewSentences = () => {
      const clean = humanizeForSpeech(full);
      const sens = splitSentences(clean);
      // ucapkan semua kalimat kecuali yang terakhir (masih bisa bersambung),
      // kecuali stream sudah selesai.
      const ready = sens.length > 1 ? sens.slice(sentHead, -1) : [];
      for (const s of ready) { speakQueueRef.current.push(s); sentHead++; }
      if (ready.length) setLoadStage('menyuarakan jawabannya…');
      pumpSpeakQueue();
    };
    const firstActivity = () => {
      setLoading(false); // token/tool pertama = AI mulai jawab
      if (ttfbRef.current == null && turnStartRef.current) {
        ttfbRef.current = (performance.now() - turnStartRef.current) / 1000;
      }
      setLoadStage('AI menjawab, menyiapkan suara…');
    };

    try {
      const params = new URLSearchParams({ provider, model });
      const resp = await fetch('/api/chat/stream?' + params.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: historyRef.current.map(m => ({ role: m.role, content: m.content })),
          voice: true, // server: prompt suara + browser visible dipaksa
          provider, model, stream: true,
          maxTokens: 2000, // jawaban suara pendek → selesai (dan total) lebih cepat
        }),
        signal: ab.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const evM = part.match(/^event: (.+)$/m);
          const dataM = part.match(/^data: (.+)$/m);
          if (!evM || !dataM) continue;
          const ev = evM[1].trim();
          let d = {};
          try { d = JSON.parse(dataM[1]); } catch { continue; }
          if (ev === 'token') {
            firstActivity();
            full += d.content || '';
            setInterim(humanizeForSpeech(full).slice(-220));
            flushNewSentences();
          } else if (ev === 'tool_start') {
            firstActivity();
            setInterim('Sebentar, saya bukakan dulu…');
          } else if (ev === 'tool_end') {
            const shot = d.result?.screenshot_base64;
            const url = d.result?.url;
            const title = d.result?.title;
            if (shot || url) {
              setBrowser(prev => ({
                label: title || prev?.label || 'Browser AI',
                url: url || prev?.url,
                title: title || prev?.title,
                screenshot: shot || prev?.screenshot,
                kind: 'live',
              }));
            }
          } else if (ev === 'provider_switch') {
            // Ubah model otomatis — sama kayak chat UI (failover).
            const to = d.to || provider;
            const m = d.model || model;
            setProvider(to);
            localStorage.setItem('wanar_voice_provider', to);
            if (m) {
              setModel(m);
              localStorage.setItem('wanar_voice_model_v2', m);
            }
            if (d.reason && d.reason !== 'initial') {
              const msg = `🔄 Otomatis pindah ke ${to}${m ? '/' + m : ''} (${d.reason}) — lanjut…`;
              setSwitchNotice(msg);
              addTurn('system', msg);
            }
            if (d.reset) {
              // Provider gagal di tengah jalan: ulangi jawaban dari awal.
              full = '';
              sentHead = 0;
              speakQueueRef.current = [];
              setInterim('');
            }
          } else if (ev === 'error') {
            throw new Error(d.message || 'stream error');
          } else if (ev === 'done') {
            finished = true;
            break;
          }
        }
      }

      // Sisa kalimat terakhir → ucapkan.
      const clean = humanizeForSpeech(full).trim();
      if (clean) {
        const sens = splitSentences(clean).slice(sentHead);
        for (const s of sens) speakQueueRef.current.push(s);
        pumpSpeakQueue();
        addTurn('assistant', clean);
        historyRef.current.push({ role: 'assistant', content: clean });
      }
      setInterim('');
      // tunggu ucapan selesai, lalu kembali mendengarkan
      const waitSpoke = () => new Promise((res) => {
        const t = setInterval(() => {
          if (!speakQueueRef.current.length && !speakRunningRef.current) { clearInterval(t); res(); }
        }, 200);
        setTimeout(() => { clearInterval(t); res(); }, 60000);
      });
      await waitSpoke();
    } catch (e) {
      if (e.name !== 'AbortError') {
        const msg = /quota/i.test(e.message)
          ? 'Maaf, kuotanya habis. Silakan ganti provider di atas.'
          : 'Maaf, jaringannya terputus. Silakan coba berbicara lagi.';
        setError(msg);
        queueSpeak(msg);
      }
    } finally {
      abortRef.current = null;
      busyRef.current = false;
      setLoading(false);
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      setLoadStage('');
      if (turnStartRef.current) {
        const total = (performance.now() - turnStartRef.current) / 1000;
        setLastTiming({
          ttfb: ttfbRef.current,
          firstAudio: tFirstAudioRef.current,
          total,
        });
        turnStartRef.current = 0;
      }
      // Giliran berikutnya (FIFO): JANGAN serobot — selesaikan antrean satu per satu.
      const next = pendingRef.current.shift();
      setQueued([...pendingRef.current]);
      if (next && callActiveRef.current) {
        setTimeout(() => sendToAIRef.current?.(next, { fromQueue: true }), 400);
      } else if (callActiveRef.current) {
        setCallState('listening');
        resumeListening();
      }
    }
  }, [provider, model, addTurn, pumpSpeakQueue, queueSpeak, resumeListening]);
  const sendToAIRef = useRef(null);
  sendToAIRef.current = sendToAI;

  const handleFinalSpeech = useCallback((text) => {
    const t = (text || '').trim();
    if (!callActiveRef.current || t.length < 2) return;
    if (isEcho(t)) return; // gema suara AI sendiri → buang, bukan omongan user
    const now = Date.now();
    if (now - lastFinalAt.current < 800) return;
    lastFinalAt.current = now;
    if (busyRef.current || speakingRef.current) {
      // AI belum selesai → MASUK ANTREAN FIFO (maks 2), tidak diserobot & tidak hilang.
      const q = pendingRef.current;
      if (q[q.length - 1] !== t) {
        q.push(t);
        if (q.length > 2) q.shift();
        setQueued([...q]);
      }
      return;
    }
    // AI sedang diam (mis. sapaan pembuka) → hentikan suara lalu proses.
    stopSpeaking();
    setInterim('');
    addTurn('user', t);
    historyRef.current.push({ role: 'user', content: t });
    if (historyRef.current.length > 40) historyRef.current = historyRef.current.slice(-40);
    sendToAIRef.current?.(t);
  }, [addTurn, stopSpeaking]);

  // ---- SpeechRecognition: id-ID, hidup terus, bisa menyela ----
  const setupRecognition = useCallback(() => {
    if (!supported) return null;
    const rec = new SpeechRecognitionImpl();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'id-ID';
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      if (Date.now() < coolUntilRef.current) return; // ekor gema speaker → abaikan
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const transcript = r[0]?.transcript?.trim() || '';
        if (r.isFinal) {
          if (transcript && !isEcho(transcript)) handleFinalSpeech(transcript);
        } else {
          interimText += transcript + ' ';
        }
      }
      interimText = interimText.trim();
      // Tampilkan omongan user hanya saat AI diam (jangan timpa caption jawaban AI).
      if (interimText && !busyRef.current && !speakingRef.current && !isEcho(interimText)) {
        setInterim(interimText);
      }
    };
    rec.onerror = (event) => {
      // no-speech/aborted/network = gangguan sesaat → diam-diam coba lagi via onend.
      if (event.error === 'no-speech' || event.error === 'aborted' || event.error === 'network') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setError('Mikrofon ditolak browser. Klik ikon gembok di address bar → izinkan mikrofon, lalu mulai lagi.');
        return;
      }
      setError(`Gangguan suara: ${event.error}. Coba lagi ya.`);
    };
    rec.onend = () => {
      // Chrome mematikan sesaat setelah hening → nyalakan lagi selama call aktif.
      // Tetap nyala juga saat AI mikir/bersuara (full-duplex + echo guard).
      if (callActiveRef.current && micEnabledRef.current) {
        try { rec.start(); } catch { /* noop */ }
      }
    };
    return rec;
  }, [supported, handleFinalSpeech]);

  const startCall = useCallback(async (withMic = true) => {
    // Buka kunci audio DULUAN (sinkron dalam klik) agar sapaan pasti BUNYI.
    try { unlockAudio(); } catch { /* noop */ }
    setError('');
    setShowWelcome(false);
    setTurns([]);
    setInterim('');
    setBrowser(null);
    setQueued([]);
    pendingRef.current = [];
    historyRef.current = [];
    callActiveRef.current = true;
    busyRef.current = false;
    micEnabledRef.current = withMic && supported;

    if (micEnabledRef.current) {
      try {
        // Minta izin mic eksplisit agar popup permission jelas.
        const stream = await navigator.mediaDevices?.getUserMedia({ audio: true }).catch(() => null);
        stream?.getTracks()?.forEach(t => t.stop());
      } catch { /* abaikan, recognition akan minta sendiri */ }
      if (!recognitionRef.current) recognitionRef.current = setupRecognition();
    }

    // Sapaan proaktif: AI ngomong DULUAN — formal khas AI agent pribadi, tetap santai.
    const hour = new Date().getHours();
    const salam = hour < 11 ? 'Selamat pagi' : hour < 15 ? 'Selamat siang' : hour < 19 ? 'Selamat sore' : 'Selamat malam';
    const saat = hour < 11 ? 'pagi ini' : hour < 15 ? 'siang ini' : hour < 19 ? 'sore ini' : 'malam ini';
    const greeting = `${salam}, Wisnu. Saya Wanar AI, AI agent pribadi Anda. Ada yang bisa saya bantu ${saat}? Kalau perlu membuka browser atau mencari informasi, tampilannya akan terbagi dua agar mudah diikuti.`;
    addTurn('assistant', greeting);
    historyRef.current.push({ role: 'assistant', content: greeting });
    // Hangatkan cache audio filler selagi sapaan bunyi → sahutan berikutnya instan.
    prefetchTTS(FILLERS);
    queueSpeak(greeting);
    // Mic langsung nyala walau sapaan bunyi — gema sapaan dibuang via echo guard.
    setCallState('listening');
    if (micEnabledRef.current && recognitionRef.current) {
      try { recognitionRef.current.start(); } catch { /* noop */ }
    } else {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [supported, setupRecognition, addTurn, queueSpeak]);

  const endCall = useCallback(() => {
    callActiveRef.current = false;
    busyRef.current = false;
    micEnabledRef.current = false;
    pendingRef.current = [];
    setQueued([]);
    try { abortRef.current?.abort(); } catch { /* noop */ }
    abortRef.current = null;
    try { recognitionRef.current?.stop(); } catch { /* noop */ }
    recognitionRef.current = null;
    stopSpeaking();
    setInterim('');
    setLoading(false);
    setSwitchNotice('');
    setElapsed(0);
    setLoadStage('');
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    turnStartRef.current = 0;
    setCallState('idle');
  }, [stopSpeaking]);

  useEffect(() => () => {
    callActiveRef.current = false;
    if (tickRef.current) clearInterval(tickRef.current);
    try { recognitionRef.current?.stop(); } catch { /* noop */ }
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    try { stopServerAudio(); } catch { /* noop */ }
  }, []);

  // Live screenshot browser server (Chromium visible di laptop) tiap 2,5 dtk.
  useEffect(() => {
    if (!inCall) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch('/api/browser/live');
        const d = await r.json();
        if (d?.open) {
          setBrowser(prev => ({
            label: d.title || prev?.label || 'Browser AI',
            url: d.url || prev?.url,
            title: d.title,
            screenshot: d.screenshot_base64 || prev?.screenshot,
            embed: prev?.embed, // pertahankan embed youtube bila ada
            links: prev?.links,
            kind: 'live',
          }));
        }
      } catch { /* polling best-effort */ }
    }, 2500);
    return () => clearInterval(t);
  }, [inCall]);

  const submitText = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    setText('');
    if (!callActiveRef.current) {
      // mode ketik: mulai sesi tanpa mic
      callActiveRef.current = true;
      setShowWelcome(false);
      setCallState('thinking');
    }
    if (busyRef.current || speakingRef.current) {
      // AI belum selesai → ketikan ikut antre FIFO seperti omongan.
      const q = pendingRef.current;
      if (q[q.length - 1] !== t) {
        q.push(t);
        if (q.length > 2) q.shift();
        setQueued([...q]);
      }
      return;
    }
    stopSpeaking();
    addTurn('user', t);
    historyRef.current.push({ role: 'user', content: t });
    sendToAIRef.current?.(t);
  }, [text, addTurn, stopSpeaking]);

  const openNewTab = useCallback(() => {
    const url = browserRef.current?.url;
    if (url) window.open(url, '_blank', 'noopener');
  }, []);

  const dualScreen = useCallback(() => {
    // Coba buka jendela browser di KANAN layar (separuh), window ini di kiri.
    // Browser modern membatasi resize, jadi fallback: tab baru.
    const url = browserRef.current?.url || 'https://www.youtube.com';
    try {
      const sw = window.screen?.availWidth || 1366;
      const sh = window.screen?.availHeight || 768;
      const win = window.open(url, 'wanar_browser_kanan', `width=${Math.floor(sw / 2)},height=${sh},left=${Math.floor(sw / 2)},top=0`);
      if (!win) window.open(url, '_blank', 'noopener');
      try { window.resizeTo(Math.floor(sw / 2), sh); window.moveTo(0, 0); } catch { /* dibatasi browser */ }
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  }, []);

  const closeBrowser = useCallback(async () => {
    setBrowser(null);
    try { await fetch('/api/browser/close', { method: 'POST' }); } catch { /* noop */ }
  }, []);

  const quickOpen = useCallback((label, url) => {
    setBrowser({ label, url });
    window.open(url, '_blank', 'noopener');
  }, []);

  return (
    <DashboardLayout>
      <div className="vt-page">
        <div className="vt-head">
          <h1>🎙️ Voice Talk <span className="vt-status"><span className={`vt-dot ${inCall ? 'live' : ''}`} />{stateLabel}</span></h1>
        </div>

        {/* Popup sambutan: selalu muncul tiap masuk halaman */}
        {showWelcome && (
          <div className="vt-modal-bg">
            <div className="vt-modal">
              <div style={{ fontSize: '46px' }}>🎙️</div>
              <h2>Halo, Wisnu. Mulai bicara?</h2>
              <p>
                Klik <b>Mulai Bicara</b>, izinkan mikrofon, lalu silakan berbicara dalam Bahasa Indonesia.
                Saya menjawab dengan suara dan dapat membuka browser di panel kanan layar bila diperlukan.
              </p>
              <div className="vt-btn-row">
                <button className="vt-btn primary" onClick={() => startCall(true)}>🎙️ Mulai Bicara</button>
                <button className="vt-btn ghost" onClick={() => startCall(false)}>⌨️ Ketik Saja</button>
              </div>
              <small>Pakai Chrome / Edge + izinkan mikrofon agar suaranya realtime.</small>
            </div>
          </div>
        )}

        <div className="vt-split">
          {/* KIRI: obrolan */}
          <div className="vt-card">
            {/* Model berjalan otomatis di belakang layar (FREE + failover),
                sama seperti chat UI — tanpa bar yang merusak tampilan. */}
            {switchNotice && <div className="vt-switch">{switchNotice}</div>}

            <div className="vt-mic-stage">
              <button
                className={`vt-orb ${callState === 'speaking' ? 'speaking' : callState === 'listening' ? 'listening' : callState === 'thinking' ? 'thinking' : ''}`}
                onClick={() => {
                  if (!inCall) startCall(true);
                  else if (speakingRef.current) stopSpeaking();
                }}
                title={inCall ? 'Klik untuk menghentikan suara' : 'Mulai bicara'}
              >
                {callState === 'thinking' ? '⏳' : callState === 'speaking' ? '🔊' : inCall ? '🎙️' : '☎️'}
              </button>
              {!inCall ? (
                <button className="vt-btn primary" onClick={() => startCall(true)}>🎙️ Mulai Bicara</button>
              ) : (
                <div className="vt-btn-row">
                  <button className="vt-btn danger" onClick={endCall}>Akhiri</button>
                </div>
              )}
              <div className="vt-hint">
                {!supported
                  ? 'Browser ini belum dukung suara — pakai Chrome/Edge, atau ketik di bawah.'
                  : inCall
                    ? 'Berbicara kapan saja — kalau saya belum selesai, ucapan akan masuk antrean. Ketuk orb untuk menyela.'
                    : 'Klik Mulai Bicara lalu berbicara.'}
              </div>
              {error && <div className="vt-err">{error}</div>}
              {queued.length > 0 && (
                <div className="vt-queue">
                  ⏳ Antre {queued.length}: “{queued[0].slice(0, 70)}{queued[0].length > 70 ? '…' : ''}” — mohon tunggu, saya selesaikan yang ini dulu…
                </div>
              )}
            </div>

            <div className="vt-transcript" ref={scrollRef}>
              {turns.length === 0 && !interim && !loading && (
                <div className="vt-hint">Transkrip obrolan muncul di sini.</div>
              )}
              {turns.map((t, i) => (
                t.role === 'system' ? (
                  <div key={i} className="vt-notice">{t.text}</div>
                ) : (
                  <div key={i} className={`vt-bubble ${t.role === 'user' ? 'user' : 'ai'}`}>
                    <div className="vt-who">{t.role === 'user' ? 'Wisnu' : 'Wanar AI'}</div>
                    <div className="vt-text">{t.text}</div>
                  </div>
                )
              ))}
              {/* Loading: kelihatan jelas saat AI lagi menyiapkan jawaban + detik berjalan */}
              {loading && !interim && (
                <div className="vt-bubble ai">
                  <div className="vt-who">Wanar AI</div>
                  <div className="vt-typing" aria-label="AI sedang berpikir">
                    <span /><span /><span />
                  </div>
                  <div className="vt-loadline">⏳ {elapsed.toFixed(1)} dtk{loadStage ? ` • ${loadStage}` : ''}</div>
                </div>
              )}
              {interim && <div className="vt-live">{interim}</div>}
            </div>
            {/* Ringkasan waktu giliran terakhir — transparan per tahap */}
            {lastTiming && (
              <div className="vt-timing">
                ⏱️ Token pertama {lastTiming.ttfb != null ? `${lastTiming.ttfb.toFixed(1)} dtk` : '—'}
                {' • '}Suara {lastTiming.firstAudio != null ? `${lastTiming.firstAudio.toFixed(1)} dtk` : '—'}
                {' • '}Total {lastTiming.total.toFixed(1)} dtk
              </div>
            )}

            <div className="vt-input-row">
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitText(); }}
                placeholder="Atau ketik di sini… (tetap dijawab pakai suara)"
              />
              <button className="vt-btn primary" onClick={submitText}>Kirim</button>
            </div>

            <div className="vt-voiceinfo">
              🔊 Suara: {getTTSEngine() === 'server' ? 'server (Google Indonesia, manusiawi)' : getTTSEngine() === 'browser' ? `browser (${getLastTTSVoice() || `${voices.filter(v => /^id/i.test(v.lang)).length} suara Indonesia terpasang`})` : 'menyiapkan…'}
              {' '}<button className="vt-btn ghost small" onClick={testSound} style={{ marginLeft: '6px' }}>🔊 Tes Suara</button>
              {ttsStatus && <div style={{ marginTop: '6px' }}>{ttsStatus}</div>}
            </div>
          </div>

          {/* KANAN: browser split */}
          <div className="vt-card">
            <div className="vt-browser-head">
              <strong>🌐 Browser AI</strong>
              {browser?.url && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button className="vt-btn ghost small" onClick={dualScreen}>🖥️ Mode 2 Layar</button>
                  <button className="vt-btn ghost small" onClick={openNewTab}>↗ Tab Baru</button>
                  <button className="vt-btn ghost small" onClick={closeBrowser}>✕ Tutup</button>
                </div>
              )}
            </div>

            {!browser ? (
              <div>
                <div className="vt-empty">
                  Browsernya muncul di sini tiap kamu suruh buka sesuatu.<br />
                  Coba ucapkan: <i>“buka YouTube cari tutorial masak”</i> atau <i>“carikan info kerja IT di Bekasi”</i>.
                </div>
                <div className="vt-quick">
                  <button className="vt-btn ghost small" onClick={() => quickOpen('YouTube', 'https://www.youtube.com')}>▶️ YouTube</button>
                  <button className="vt-btn ghost small" onClick={() => quickOpen('Google', 'https://www.google.com/?hl=id')}>🔍 Google</button>
                  <button className="vt-btn ghost small" onClick={() => setBrowser({ kind: 'jobs', label: 'Loker IT', query: 'IT', url: 'https://glints.com/id/opportunities?q=IT', links: [{ label: 'Glints', url: 'https://glints.com/id/opportunities?q=IT' }, { label: 'Jobstreet', url: 'https://www.jobstreet.co.id/id/job-search/IT-jobs/' }, { label: 'LinkedIn', url: 'https://www.linkedin.com/jobs/search/?keywords=IT&location=Indonesia' }] })}>💼 Cari Kerja</button>
                </div>
              </div>
            ) : (
              <div>
                <div className="vt-browser-url">📍 {browser.title || browser.label} — {browser.url}</div>
                {browser.links && (
                  <div className="vt-quick" style={{ justifyContent: 'flex-start', margin: '0 0 8px' }}>
                    {browser.links.map((l) => (
                      <button key={l.label} className="vt-btn ghost small" onClick={() => window.open(l.url, '_blank', 'noopener')}>{l.label} ↗</button>
                    ))}
                  </div>
                )}
                {browser.embed ? (
                  <iframe className="vt-frame" src={browser.embed} title={browser.label} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
                ) : browser.screenshot ? (
                  <img className="vt-shot" src={`data:image/jpeg;base64,${browser.screenshot}`} alt="Browser AI" />
                ) : (
                  <div className="vt-empty">Sedang saya bukakan… sebentar ya, jendela browser aslinya juga terbuka di layar. Klik <b>🖥️ Mode 2 Layar</b> agar tampil kiri-kanan dengan rapi.</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
