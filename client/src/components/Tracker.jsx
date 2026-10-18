/**
 * Tracker — the phone page behind "/track".
 * by Wisnu Alfian Nur Ashar
 *
 * Opens on the phone, holds nothing but a device token, and does one honest
 * job: capture this phone's GPS fixes and send them to the server. Everything
 * the phone reports is real (navigator.geolocation, and DeviceMotion only when
 * the browser really provides it) — no data is invented.
 *
 * Also the emergency surface on the phone itself:
 *   - red SOS button  -> POST /api/location/device/sos
 *   - when the server has an open incident awaiting the owner, a countdown with
 *     "Saya aman" / "Butuh bantuan" appears and answers via /device/respond.
 *   - a local impact watch (DeviceMotion) can *suggest* SOS after a hard jolt;
 *     it is explicitly labelled as a phone feature, not certified crash
 *     detection, and it only ever sends when the owner confirms (or enabled the
 *     auto option on this page).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import './automation.css';
import './tracking.css';

const TOKEN_KEY = 'trackerDeviceToken';
const QUEUE_KEY = 'trackerOfflineQueue';
const OPT_KEY = 'trackerOptions';

const getStored = (k, fallback = null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const setStored = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

async function deviceFetch(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/location${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Device-Token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || data.success === false) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

export default function Tracker() {
  const [token, setToken] = useState(() => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } });
  const [tokenDraft, setTokenDraft] = useState('');
  const [device, setDevice] = useState(null);
  const [authError, setAuthError] = useState('');

  const [running, setRunning] = useState(false);
  const [hint, setHint] = useState({ intervalMs: 15000, reason: 'menunggu server' });
  const [lastFix, setLastFix] = useState(null);
  const [lastSent, setLastSent] = useState(null);
  const [sentCount, setSentCount] = useState(0);
  const [queueLen, setQueueLen] = useState(() => (getStored(QUEUE_KEY, []) || []).length);
  const [wakeState, setWakeState] = useState('belum diminta');
  const [motionState, setMotionState] = useState('belum diaktifkan');
  const [battery, setBattery] = useState(null);
  const [log, setLog] = useState([]);
  const [installHint, setInstallHint] = useState(false);

  const [emg, setEmg] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [impact, setImpact] = useState(null);        // local sensor warning {mag, at}
  const [autoSos, setAutoSos] = useState(() => (getStored(OPT_KEY, {}) || {}).autoSos === true);
  const [sosBusy, setSosBusy] = useState(false);

  const watchRef = useRef(null);
  const wakeRef = useRef(null);
  const lastSampleRef = useRef({ ts: 0, lat: null, lon: null });
  const motionRef = useRef(null);
  const queueRef = useRef(getStored(QUEUE_KEY, []) || []);
  const bufferRef = useRef([]);
  const runningRef = useRef(false);
  const hintRef = useRef(hint);
  hintRef.current = hint;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const say = useCallback((text) => setLog((l) => [`${new Date().toLocaleTimeString('id-ID')} ${text}`, ...l].slice(0, 30)), []);

  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  useEffect(() => { setStored(OPT_KEY, { autoSos }); }, [autoSos]);
  useEffect(() => {
    let on = true;
    try {
      navigator.getBattery?.().then((b) => {
        if (!on) return;
        setBattery({ level: b.level, charging: b.charging });
        b.addEventListener('levelchange', () => setBattery({ level: b.level, charging: b.charging }));
      });
    } catch { /* not supported */ }
    return () => { on = false; };
  }, []);

  // ------------------------------------------------------------- queue + send

  const saveQueue = () => { queueRef.current = queueRef.current.slice(-800); setQueueLen(queueRef.current.length); setStored(QUEUE_KEY, queueRef.current); };

  const sendBatch = useCallback(async (samples) => {
    if (!samples.length) return true;
    try {
      const r = await deviceFetch(tokenRef.current, '/device/ingest', { method: 'POST', body: { samples } });
      setSentCount((c) => c + (r.inserted || 0));
      setLastSent(Date.now());
      return true;
    } catch (e) {
      if (e.code === 'device_token_required') {
        setAuthError('Token perangkat ditolak. Buat token baru di halaman /tracking (tab Live) lalu tempel di sini.');
        stop();
        return false;
      }
      // Network problem: keep the samples locally and try again later.
      queueRef.current = [...queueRef.current, ...samples];
      saveQueue();
      return false;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback(async () => {
    if (queueRef.current.length) {
      const batch = queueRef.current.slice(0, 40);
      try {
        await deviceFetch(tokenRef.current, '/device/ingest', { method: 'POST', body: { samples: batch } });
        queueRef.current = queueRef.current.slice(batch.length);
        saveQueue();
        setLastSent(Date.now());
      } catch { /* still offline */ }
    }
    if (bufferRef.current.length) {
      const batch = bufferRef.current.splice(0, bufferRef.current.length);
      const ok = await sendBatch(batch);
      if (!ok) bufferRef.current.unshift(...batch);
    }
  }, [sendBatch]);

  useEffect(() => {
    const i = setInterval(flush, 20000);
    const onOnline = () => { say('Jaringan kembali — mengirim antrean.'); flush(); };
    window.addEventListener('online', onOnline);
    return () => { clearInterval(i); window.removeEventListener('online', onOnline); };
  }, [flush, say]);

  // ------------------------------------------------------------- permissions

  const checkAuth = useCallback(async () => {
    if (!token) return false;
    try {
      const r = await deviceFetch(token, '/device/status');
      setDevice(r.device);
      setHint(r.hint || { intervalMs: 15000 });
      setEmg(r.emergency || null);
      setAuthError('');
      return true;
    } catch (e) {
      if (e.code === 'device_token_required') setAuthError('Token perangkat tidak dikenal atau sudah dicabut. Buat token baru di halaman /tracking, tab Live.');
      else setAuthError(`Server tidak terjangkau: ${e.message}`);
      return false;
    }
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    checkAuth();
    const i = setInterval(checkAuth, 15000);
    return () => clearInterval(i);
  }, [token, checkAuth]);

  // ------------------------------------------------------------------ wake
  const requestWake = useCallback(async () => {
    try {
      if (!('wakeLock' in navigator)) { setWakeState('tidak didukung browser ini'); return; }
      wakeRef.current = await navigator.wakeLock.request('screen');
      setWakeState('aktif — layar ditahan menyala selama pelacakan');
      wakeRef.current.addEventListener?.('release', () => setWakeState('dilepas oleh sistem/browser'));
    } catch (e) {
      setWakeState(`gagal: ${e.message}`);
    }
  }, []);

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible' && runningRef.current && wakeRef.current?.released) requestWake(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [requestWake]);

  useEffect(() => {
    if (!('wakeLock' in navigator)) setWakeState('tidak didukung browser ini');
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches;
    setInstallHint(!standalone);
  }, []);

  // ---------------------------------------------------------------- tracking

  const onPosition = useCallback((pos) => {
    const c = pos.coords;
    const s = {
      ts: Math.round(pos.timestamp || Date.now()),
      lat: c.latitude,
      lon: c.longitude,
      accuracy: Number.isFinite(c.accuracy) ? Math.round(c.accuracy) : null,
      speed: Number.isFinite(c.speed) ? c.speed : null,
      heading: Number.isFinite(c.heading) ? c.heading : null,
      altitude: Number.isFinite(c.altitude) ? c.altitude : null,
      battery: battery ? Math.round(battery.level * 100) : null,
      source: 'phone-gps',
    };
    const m = motionRef.current;
    // Sensor data is attached only when the browser actually delivered it.
    if (m && Date.now() - m.ts < 20000) s.motion = { mag: m.mag, rot: m.rot };

    // Honour the server's adaptive interval: while the owner barely moves,
    // only send on the slower cadence. Real movement (>= 25 m) always goes in.
    const prev = lastSampleRef.current;
    const dt = s.ts - prev.ts;
    if (prev.lat != null && dt < (hintRef.current.intervalMs || 15000)) {
      const R = 6371008.8;
      const rad = (d) => (d * Math.PI) / 180;
      const dLat = rad(s.lat - prev.lat);
      const dLon = rad(s.lon - prev.lon);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(prev.lat)) * Math.cos(rad(s.lat)) * Math.sin(dLon / 2) ** 2;
      const dist = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
      if (dist < 25) return;
    }
    lastSampleRef.current = { ts: s.ts, lat: s.lat, lon: s.lon };

    setLastFix(s);
    bufferRef.current.push(s);
    if (bufferRef.current.length >= 10) flush();
  }, [battery, flush]);

  const start = useCallback(async () => {
    if (!navigator.geolocation) { say('Browser ini tidak menyediakan GPS (navigator.geolocation).'); return; }
    const ok = await checkAuth();
    if (!ok) return;
    runningRef.current = true;
    setRunning(true);
    say('Pelacakan dimulai.');
    requestWake();
    watchRef.current = navigator.geolocation.watchPosition(
      onPosition,
      (err) => say(`GPS error: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );
  }, [checkAuth, onPosition, requestWake, say]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (watchRef.current != null) { try { navigator.geolocation.clearWatch(watchRef.current); } catch { /* fine */ } watchRef.current = null; }
    wakeRef.current?.release?.().catch?.(() => {});
    wakeRef.current = null;
    flush();
    say('Pelacakan dihentikan.');
  }, [flush, say]);

  useEffect(() => () => { if (watchRef.current != null) navigator.geolocation?.clearWatch(watchRef.current); wakeRef.current?.release?.().catch?.(() => {}); }, []);

  // ----------------------------------------------------------- device motion

  const motionOnRef = useRef(false);
  const enableMotion = useCallback(async () => {
    try {
      const DME = window.DeviceMotionEvent;
      if (!DME) { setMotionState('sensor gerak tidak tersedia di browser ini'); return; }
      if (typeof DME.requestPermission === 'function') {
        const p = await DME.requestPermission();
        if (p !== 'granted') { setMotionState('izin sensor ditolak'); return; }
      }
      if (motionOnRef.current) { setMotionState('aktif — akselerometer HP ikut dikirim sebagai {mag, rot}'); return; }
      const g = 9.80665;
      const handler = (e) => {
        const a = e.acceleration || e.accelerationIncludingGravity;
        if (!a) return;
        const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2) / g;
        const rr = e.rotationRate || {};
        const rot = Math.sqrt((rr.alpha || 0) ** 2 + (rr.beta || 0) ** 2 + (rr.gamma || 0) ** 2);
        motionRef.current = { mag: Number(mag.toFixed(3)), rot: Math.round(rot), ts: Date.now() };
        if (mag >= 3) setImpact((cur) => cur || { mag: Number(mag.toFixed(2)), at: Date.now() });
      };
      window.addEventListener('devicemotion', handler);
      motionOnRef.current = true;
      motionRef.current = { mag: 0, rot: 0, ts: Date.now() };
      setMotionState('aktif — akselerometer HP ikut dikirim sebagai {mag, rot}');
      say('Sensor gerak aktif. Ini sensor HP, bukan crash-detector tersertifikasi.');
      return () => window.removeEventListener('devicemotion', handler);
    } catch (e) {
      setMotionState(`gagal: ${e.message}`);
      return undefined;
    }
  }, [say]);

  // --------------------------------------------------------------- emergency

  const sendSos = useCallback(async (note) => {
    setSosBusy(true);
    try {
      const r = await deviceFetch(tokenRef.current, '/device/sos', { method: 'POST', body: { note } });
      say(`SOS dibuat (${r.event?.status}). Mode server: ${r.event?.mode}.`);
      setImpact(null);
      checkAuth();
    } catch (e) {
      say(`SOS gagal: ${e.message}`);
    } finally {
      setSosBusy(false);
    }
  }, [checkAuth, say]);

  const respond = useCallback(async (answer) => {
    setSosBusy(true);
    try {
      await deviceFetch(tokenRef.current, '/device/respond', { method: 'POST', body: { answer } });
      say(answer === 'safe' ? 'Dijawab aman — eskalasi dibatalkan.' : 'Dijawab butuh bantuan — eskalasi berjalan.');
      setImpact(null);
      checkAuth();
    } catch (e) {
      say(`Jawaban gagal: ${e.message}`);
    } finally {
      setSosBusy(false);
    }
  }, [checkAuth, say]);

  // auto-SOS after the local sensor warning, only when explicitly enabled here
  useEffect(() => {
    if (!impact || !autoSos) return undefined;
    const t = setTimeout(() => { if (impact) { say('Auto-SOS: mengirim karena benturan keras (opsi aktif).'); sendSos('benturan keras terdeteksi sensor HP (auto-SOS diaktifkan pemilik)'); } }, 20000);
    return () => clearTimeout(t);
  }, [impact, autoSos, sendSos, say]);

  const remainMs = emg?.confirmDeadline ? emg.confirmDeadline - now : null;

  // ----------------------------------------------------------------- render

  if (!token) {
    return (
      <div className="trk-track-root">
        <h2 style={{ marginBottom: 4 }}>Pelacak HP</h2>
        <p className="trk-muted">
          Halaman ini berjalan di HP Anda dan mengirim posisi GPS ke server Wanar AI Anda sendiri.
          Token dibuat di halaman <b>/tracking</b> → tab <b>Live</b> → "Perangkat & token".
        </p>
        <input className="au-input" placeholder="Tempel token perangkat" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value.trim())} />
        <button className="au-btn primary trk-track-btn" style={{ marginTop: 10 }} disabled={!tokenDraft} onClick={() => {
          try { localStorage.setItem(TOKEN_KEY, tokenDraft); } catch { /* private mode */ }
          setToken(tokenDraft);
        }}>Simpan token</button>
        <div className="trk-honesty" style={{ marginTop: 12 }}>
          Yang merekam GPS adalah HP ini, bukan server. Tutup halaman ini = pelacakan berhenti,
          kecuali Anda memakai aplikasi latar terpisah yang memang Anda pasang sendiri.
        </div>
      </div>
    );
  }

  return (
    <div className="trk-track-root">
      <div className="trk-row between">
        <h2 style={{ margin: 0 }}>Pelacak HP</h2>
        <button className="au-btn trk-small" onClick={() => { setToken(''); setTokenDraft(''); try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }}>Ganti token</button>
      </div>
      <div className="trk-muted" style={{ marginBottom: 10 }}>
        {device ? <>Perangkat: <b>{device.name}</b> · server: <span className="trk-mono">{device.id}</span></> : 'Menghubungi server…'}
      </div>

      {authError && <div className="au-alert err" style={{ marginBottom: 10 }}>{authError}</div>}

      {/* emergency surfaces first — this is the thing you need fastest */}
      {remainMs != null && remainMs > 0 && (
        <div className="trk-countdown" style={{ marginBottom: 12 }}>
          <div className="num">{Math.ceil(remainMs / 1000)}</div>
          <div className="cap">{emg.trigger || 'Ada indikasi kejadian.'} — jawab dari HP ini:</div>
          <div className="trk-row" style={{ marginTop: 10, justifyContent: 'center' }}>
            <button className="au-btn primary" disabled={sosBusy} onClick={() => respond('safe')}>Saya aman</button>
            <button className="au-btn" disabled={sosBusy} onClick={() => respond('help')}>Butuh bantuan</button>
          </div>
        </div>
      )}

      {impact && (
        <div className="trk-countdown" style={{ marginBottom: 12, borderColor: 'rgba(245,158,11,.6)', background: 'rgba(245,158,11,.12)' }}>
          <div className="cap" style={{ marginTop: 0 }}>
            Sensor HP mencatat guncangan ±{impact.mag} g pada {fmtTime(impact.at)}. Kalau Anda baik-baik saja, abaikan.
          </div>
          <div className="trk-row" style={{ marginTop: 8, justifyContent: 'center' }}>
            <button className="au-btn primary" onClick={() => setImpact(null)}>Saya baik-baik saja</button>
            <button className="au-btn" disabled={sosBusy} onClick={() => sendSos('benturan keras dari sensor HP')}>Kirim SOS</button>
          </div>
          <label className="au-check" style={{ justifyContent: 'center', marginTop: 6 }}>
            <input type="checkbox" checked={autoSos} onChange={(e) => setAutoSos(e.target.checked)} />
            <span>Kirim SOS otomatis 20 detik setelah guncangan keras (opsional)</span>
          </label>
        </div>
      )}

      <button className="trk-track-sos" disabled={sosBusy} onClick={() => {
        if (window.confirm('Kirim permintaan bantuan sekarang?')) sendSos('tombol darurat dari HP (halaman /track)');
      }}>SOS — MINTA BANTUAN</button>
      <div className="trk-muted trk-small" style={{ marginTop: 6, marginBottom: 14 }}>
        Mengikuti mode server saat ini. Bila server dalam mode simulasi, tidak ada pesan nyata yang keluar — statusnya akan muncul di halaman /tracking.
      </div>

      {/* tracking control */}
      <div className="au-card">
        <div className="trk-row between">
          <b>Pelacakan GPS</b>
          <span className={`trk-live-dot ${running ? 'on' : ''}`} />
        </div>
        <div className="trk-row" style={{ marginTop: 8 }}>
          <button className="au-btn primary trk-track-btn" disabled={running} onClick={start}>Mulai mengirim</button>
          <button className="au-btn trk-track-btn" disabled={!running} onClick={stop}>Berhenti</button>
        </div>
        <dl className="trk-kv" style={{ marginTop: 10 }}>
          <dt>Titik terakhir</dt><dd>{lastFix ? `${lastFix.lat.toFixed(5)}, ${lastFix.lon.toFixed(5)} ±${lastFix.accuracy ?? '?'} m · ${fmtTime(lastFix.ts)}` : 'belum ada'}</dd>
          <dt>Kiriman terakhir</dt><dd>{lastSent ? `${fmtTime(lastSent)} · total diterima server: ${sentCount} titik` : 'belum'}</dd>
          <dt>Antrean offline</dt><dd>{queueLen} titik menunggu koneksi</dd>
          <dt>Interval saran server</dt><dd>{Math.round((hint.intervalMs || 15000) / 1000)} detik — {hint.reason || ''}</dd>
          <dt>Layar (wake lock)</dt><dd>{wakeState}</dd>
          <dt>Baterai</dt><dd>{battery ? `${Math.round(battery.level * 100)}%${battery.charging ? ' (mengisi)' : ''}` : 'tidak dilaporkan browser'}</dd>
          <dt>Sensor gerak</dt><dd>{motionState} {motionState.startsWith('aktif') ? '' : <button className="au-btn trk-small" onClick={enableMotion}>Aktifkan</button>}</dd>
        </dl>
        <div className="trk-honesty" style={{ marginTop: 8 }}>
          GPS hanya jalan selama halaman ini terbuka dan disetujui. Server tidak bisa menyalakan GPS dari jauh —
          pelacakan latar tanpa aplikasi khusus bukan hal yang bisa dijanjikan browser biasa.
        </div>
        {installHint && <div className="trk-muted trk-small" style={{ marginTop: 6 }}>Tip: "Tambahkan ke layar utama" supaya lebih tahan dibuka lama.</div>}
      </div>

      <div className="au-card" style={{ marginTop: 12 }}>
        <b>Catatan aktivitas</b>
        <div className="trk-small trk-mono" style={{ marginTop: 6, maxHeight: 180, overflow: 'auto' }}>
          {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <span className="trk-muted">belum ada aktivitas</span>}
        </div>
      </div>
    </div>
  );
}
