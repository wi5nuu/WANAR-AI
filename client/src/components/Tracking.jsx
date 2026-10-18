/**
 * Tracking — "Pelacakan & Motor"
 * by Wisnu Alfian Nur Ashar
 *
 * One realtime page for the whole personal-tracking feature set:
 *   - Live      : current/last-known position on a map, track session control,
 *                 phone device tokens, simulator, notices and privacy tools.
 *   - Riwayat   : a day's timeline, trips with their GPS route, range summary,
 *                 and "di mana saya tadi?".
 *   - Tempat    : named places (geofences) and correction of stop labels.
 *   - Darurat   : emergency status, contacts (verify + test), event history and
 *                 the end-to-end simulation. Live sending only when configured.
 *   - Kendaraan : fuel estimate (model, not sensor), fill-ups, odometer,
 *                 maintenance due list and calibration approval.
 *   - Memori    : the personal memory the AI may use, with edit/forget tools.
 *
 * Everything on this page is backed by the real APIs (/api/location,
 * /api/emergency, /api/vehicle, /api/memory). Nothing is fabricated: when data
 * does not exist the UI says so.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { openStream } from '../lib/stream.js';
import DashboardLayout from './DashboardLayout';
import './automation.css';
import './tracking.css';
import {
  IconMap, IconPin, IconBike, IconFuel, IconAlert, IconRefresh,
  IconPlay, IconPause, IconStop, IconTrash, IconPlus, IconCheck, IconClock, IconSparkles,
} from './icons';

// ---------------------------------------------------------------- api helper

const TOKEN_KEY = 'automationToken';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };

async function api(path, { method = 'GET', body } = {}, retried = false) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const t = getToken();
  if (t) headers['X-Automation-Token'] = t;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }

  if (res.status === 401 && data.code === 'token_required' && !retried) {
    const entered = window.prompt('Masukkan token otomasi (AUTOMATION_TOKEN di .env server):');
    if (entered) {
      try { localStorage.setItem(TOKEN_KEY, entered.trim()); } catch { /* private mode */ }
      return api(path, { method, body }, true);
    }
  }
  if (!res.ok || data.success === false) {
    const err = new Error(data.error || `Permintaan gagal (HTTP ${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------- helpers

const TZ = 'Asia/Jakarta';
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString('id-ID', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtAge = (ms) => {
  if (ms == null) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} detik`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} menit`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam ${m % 60} menit`;
  return `${Math.floor(h / 24)} hari`;
};
const fmtDist = (m) => {
  if (m == null) return '—';
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
};
const fmtDur = (sec) => {
  if (sec == null) return '—';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} jam ${m} mnt` : `${m} mnt`;
};
const kmh = (mps) => (Number.isFinite(mps) ? `${(mps * 3.6).toFixed(1)} km/j` : '—');
const rupiah = (n) => (n == null ? '—' : `Rp${Math.round(n).toLocaleString('id-ID')}`);
const localInput = (ms) => {
  const d = new Date(ms || Date.now());
  // datetime-local wants local wall time; the browser timezone is what the owner types in.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const EMG_STATUS = {
  confirming: ['warn', 'menunggu jawaban'],
  escalating: ['err', 'sedang dieskalasi'],
  escalated: ['err', 'tereskalasi'],
  escalated_no_contacts: ['err', 'eskalasi tanpa kontak'],
  awaiting_owner: ['warn', 'menunggu pemilik'],
  resolved: ['ok', 'selesai'],
  cancelled: ['muted', 'dibatalkan'],
};
const ATTEMPT_STATUS = { sent: ['ok', 'terkirim'], simulated: ['sim', 'simulasi'], failed: ['err', 'gagal'], pending: ['warn', 'menunggu'], unavailable: ['muted', 'kanal mati'], skipped: ['muted', 'dilewati'] };
const DUE_STATUS = { overdue: ['err', 'terlambat'], due: ['err', 'waktunya'], due_soon: ['warn', 'segera'], ok: ['ok', 'aman'], no_data: ['muted', 'tanpa data'] };

const Chip = ({ kind = 'muted', children }) => <span className={`trk-chip ${kind}`}>{children}</span>;

function Field({ label, hint, children }) {
  return (
    <div className="au-field">
      <label>{label}</label>
      {children}
      {hint ? <div className="trk-muted" style={{ marginTop: 3 }}>{hint}</div> : null}
    </div>
  );
}

function Stat({ v, l }) {
  return <div className="trk-stat"><div className="v">{v}</div><div className="l">{l}</div></div>;
}

// --------------------------------------------------------------- leaflet map

function drawLayers(map, group, { center, zoom, trail, stops, markers, fit }) {
  group.clearLayers();
  const pts = [];
  if (Array.isArray(trail) && trail.length > 1) {
    const latlngs = trail.map((s) => [s.lat, s.lon]);
    L.polyline(latlngs, { color: '#38bdf8', weight: 4, opacity: 0.9 }).addTo(group);
    L.circleMarker(latlngs[0], { radius: 6, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 1 }).addTo(group).bindTooltip('mulai', { direction: 'top' });
    L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 1 }).addTo(group).bindTooltip('akhir', { direction: 'top' });
    pts.push(...latlngs);
  }
  for (const st of stops || []) {
    if (!Number.isFinite(st.lat) || !Number.isFinite(st.lon)) continue;
    const ll = [st.lat, st.lon];
    pts.push(ll);
    L.circleMarker(ll, { radius: 6, color: '#a78bfa', fillColor: '#a78bfa', fillOpacity: 0.9 })
      .addTo(group)
      .bindTooltip(st.corrected_label || st.label || 'perhentian', { direction: 'top' });
  }
  for (const m of markers || []) {
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) continue;
    const ll = [m.lat, m.lon];
    pts.push(ll);
    if (Number.isFinite(m.accuracy) && m.accuracy > 25 && m.accuracy < 3000) {
      L.circle(ll, { radius: m.accuracy, color: m.color || '#38bdf8', weight: 1, opacity: 0.35, fillOpacity: 0.08 }).addTo(group);
    }
    L.circleMarker(ll, { radius: 8, color: m.color || '#38bdf8', fillColor: m.color || '#38bdf8', fillOpacity: 1, weight: 2 })
      .addTo(group)
      .bindTooltip(m.label || 'posisi', { direction: 'top' });
  }
  if (pts.length && (fit || pts.length > 1)) {
    try { map.fitBounds(L.latLngBounds(pts), { padding: [34, 34], maxZoom: 16 }); } catch { /* fine */ }
  } else if (center) {
    map.setView(center, zoom);
  }
}

/**
 * A Leaflet map with OpenStreetMap tiles — free, no API key.
 * The map instance is created once; layers are redrawn when `rev` changes.
 */
function MapView({ height = 320, center = null, zoom = 15, trail = null, stops = [], markers = [], fit = false, rev = 0 }) {
  const holder = useRef(null);
  const mapRef = useRef(null);
  const groupRef = useRef(null);
  const propsRef = useRef({});
  propsRef.current = { center, zoom, trail, stops, markers, fit };

  useEffect(() => {
    if (!holder.current || mapRef.current) return undefined;
    const map = L.map(holder.current, { zoomControl: true });
    map.setView(center || [-6.2383, 106.9756], zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const group = L.layerGroup().addTo(map);
    mapRef.current = map;
    groupRef.current = group;
    drawLayers(map, group, propsRef.current);
    return () => { map.remove(); mapRef.current = null; groupRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const group = groupRef.current;
    if (!map || !group) return;
    drawLayers(map, group, propsRef.current);
  }, [rev]);

  return <div ref={holder} className="trk-map" style={{ height }} />;
}

// ------------------------------------------------------------------- chips

const PlaceKindChip = ({ kind }) => {
  const label = String(kind || 'unknown');
  const tone = label === 'unknown' ? 'muted' : label === 'road' || label === 'vacant' ? 'info' : 'ok';
  return <Chip kind={tone}>{label}</Chip>;
};

const EmgChip = ({ status }) => {
  const [kind, label] = EMG_STATUS[status] || ['muted', status || '—'];
  return <Chip kind={kind}>{label}</Chip>;
};

const AttemptChip = ({ status }) => {
  const [kind, label] = ATTEMPT_STATUS[status] || ['muted', status || '—'];
  return <Chip kind={kind}>{label}</Chip>;
};

const DueChip = ({ status }) => {
  const [kind, label] = DUE_STATUS[status] || ['muted', status || '—'];
  return <Chip kind={kind}>{label}</Chip>;
};

// ================================================================== LIVE TAB

function LiveTab({ loc, refresh, notify, tick }) {
  const status = loc.status;
  const settings = loc.settings;
  const [busy, setBusy] = useState('');
  const [devName, setDevName] = useState('');
  const [newToken, setNewToken] = useState(null);
  const [trail, setTrail] = useState(null);
  const [openTripStops, setOpenTripStops] = useState([]);
  const [simPoints, setSimPoints] = useState(40);
  const [form, setForm] = useState(null);
  const [purgeDays, setPurgeDays] = useState(90);

  const openTrip = status.openTrip;
  useEffect(() => {
    let on = true;
    if (!openTrip?.id) { setTrail(null); setOpenTripStops([]); return undefined; }
    api(`/location/trips/${openTrip.id}`)
      .then((r) => { if (on) { setTrail(r.samples || []); setOpenTripStops(r.stops || []); } })
      .catch(() => { /* trail is optional */ });
    return () => { on = false; };
  }, [openTrip?.id, status.position?.ts]);

  useEffect(() => {
    if (form === null && settings) {
      setForm({
        enabled: settings.enabled,
        adaptiveIntervalMs: settings.adaptiveIntervalMs,
        idleIntervalMs: settings.idleIntervalMs,
        minMoveM: settings.minMoveM,
        maxAccuracyM: settings.maxAccuracyM,
        accuracyWarnM: settings.accuracyWarnM,
        staleAfterMs: Math.round(settings.staleAfterMs / 1000),
        tripStartMoveM: settings.tripStartMoveM,
        stopMinMs: Math.round(settings.stopMinMs / 60000),
        tripEndStopMs: Math.round(settings.tripEndStopMs / 60000),
        sampleRetentionDays: settings.sampleRetentionDays,
        tripRetentionDays: settings.tripRetentionDays,
        geocodeEnabled: settings.geocode.enabled,
        poiSearch: settings.geocode.poiSearch,
        quietHours: settings.notify.quietHours,
        notifyTripStart: settings.notify.tripStart,
        notifyTripEnd: settings.notify.tripEnd,
        notifyArrival: settings.notify.arrival,
        notifyUnknownStop: settings.notify.unknownStop,
        maxPerHour: settings.notify.maxPerHour,
      });
    }
  }, [form, settings]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) notify('ok', ok);
      await refresh();
      return r;
    } catch (e) {
      notify('err', e.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  const session = (action, msg) => run(action, () => api(`/location/session/${action}`, { method: 'POST', body: {} }), msg);
  const pos = status.position;

  const saveSettings = () => run('save-settings', () => api('/location/settings', {
    method: 'PUT',
    body: {
      enabled: form.enabled,
      adaptiveIntervalMs: Number(form.adaptiveIntervalMs),
      idleIntervalMs: Number(form.idleIntervalMs),
      minMoveM: Number(form.minMoveM),
      maxAccuracyM: Number(form.maxAccuracyM),
      accuracyWarnM: Number(form.accuracyWarnM),
      staleAfterMs: Number(form.staleAfterMs) * 1000,
      tripStartMoveM: Number(form.tripStartMoveM),
      stopMinMs: Number(form.stopMinMs) * 60000,
      tripEndStopMs: Number(form.tripEndStopMs) * 60000,
      sampleRetentionDays: Number(form.sampleRetentionDays),
      tripRetentionDays: Number(form.tripRetentionDays),
      geocode: { enabled: form.geocodeEnabled, poiSearch: form.poiSearch },
      notify: {
        quietHours: form.quietHours,
        tripStart: form.notifyTripStart,
        tripEnd: form.notifyTripEnd,
        arrival: form.notifyArrival,
        unknownStop: form.notifyUnknownStop,
        maxPerHour: Number(form.maxPerHour),
      },
    },
  }), 'Pengaturan pelacakan disimpan.');

  if (!form) return <div className="au-card au-empty">Memuat status pelacakan…</div>;

  return (
    <div className="trk-grid">
      {/* ------------------------------------------------ position + map */}
      <div className="au-card">
        <div className="trk-row between">
          <div className="trk-row">
            <span className={`trk-live-dot ${!pos ? '' : pos.fresh ? 'on' : 'stale'}`} />
            <b>{pos ? pos.label : 'Belum ada data lokasi'}</b>
            {pos && <span className="trk-muted">· {fmtAge(tick - pos.ts)} lalu</span>}
          </div>
          <div className="trk-row">
            <Chip kind={status.tracking.status === 'active' ? 'ok' : status.tracking.status === 'paused' ? 'warn' : 'muted'}>
              sesi: {status.tracking.status}
            </Chip>
          </div>
        </div>
        {pos ? (
          <>
            <MapView
              height={340}
              center={[pos.lat, pos.lon]}
              zoom={15}
              trail={trail}
              stops={openTripStops}
              markers={[{ lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy, label: pos.label }]}
              rev={`${pos.ts}|${openTrip?.id || ''}|${trail ? trail.length : 0}|${Math.floor(tick / 5000)}`}
            />
            <div className="trk-grid trk-cols-3" style={{ marginTop: '0.8rem' }}>
              <Stat v={`${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`} l="koordinat" />
              <Stat v={pos.accuracy == null ? '—' : `±${Math.round(pos.accuracy)} m`} l={`akurasi (${status.quality.level})`} />
              <Stat v={kmh(pos.speedMps)} l={`gerak: ${status.movement.state}`} />
            </div>
            <div className="trk-muted" style={{ marginTop: 6 }}>
              {status.quality.message} · sumber data: {pos.source || 'gps'} · baterai pelapor: {pos.battery == null ? 'tidak dilaporkan' : `${Math.round(pos.battery)}%`}
              {pos.fresh ? '' : ' · data ini sudah lewat batas kesegaran, jadi hanya posisi terakhir yang diketahui.'}
            </div>
          </>
        ) : (
          <>
            <MapView height={200} center={null} zoom={13} rev="empty" />
            <div className="trk-muted" style={{ marginTop: 8 }}>
              Belum ada titik lokasi tersimpan. Yang merekam GPS adalah HP (buka halaman <b>/track</b> di HP dengan token perangkat di bawah).
              Server hanya menyimpan kiriman itu — server tidak punya GPS sendiri.
            </div>
          </>
        )}
        {pos && <div className="trk-honesty" style={{ marginTop: 8 }}>{status.place ? <>Tempat terdeteksi: <b>{status.place.label || 'belum teridentifikasi'}</b> ({status.place.kind})</> : 'Tempat belum bisa diidentifikasi dari titik ini.'}</div>}
      </div>

      {/* ------------------------------------------------ session control */}
      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Sesi pelacakan</h3>
        <div className="trk-row">
          <button className="au-btn primary" disabled={busy} onClick={() => session('start', 'Pelacakan dimulai.')}><IconPlay size={15} /> Mulai</button>
          <button className="au-btn" disabled={busy} onClick={() => session('pause', 'Pelacakan dijeda.')}><IconPause size={15} /> Jeda</button>
          <button className="au-btn" disabled={busy} onClick={() => session('resume', 'Pelacakan dilanjutkan.')}><IconPlay size={15} /> Lanjut</button>
          <button className="au-btn" disabled={busy} onClick={() => session('stop', 'Sesi pelacakan dihentikan.')}><IconStop size={15} /> Stop</button>
          <span className="trk-spacer" />
          <button className="au-btn" disabled={busy} title="Membuat perjalanan sintetis untuk menguji alur" onClick={() => run('sim', () => api('/location/simulate/ride', { method: 'POST', body: { points: Number(simPoints) } }), 'Simulasi perjalanan dimasukkan (data sintetis).')}>
            <IconRefresh size={15} /> Uji simulasi
          </button>
          <input className="au-input" style={{ width: 70 }} type="number" min="20" max="400" value={simPoints} onChange={(e) => setSimPoints(e.target.value)} />
        </div>
        <div className="trk-muted" style={{ marginTop: 6 }}>
          Mulai/Jeda/Stop mengendalikan penyimpanan data. "Uji simulasi" memasukkan lintasan sintetis (bukan GPS nyata) untuk memeriksa peta, klasifikasi, dan laporan.
        </div>
        {status.hint && (
          <div className="trk-row" style={{ marginTop: 8 }}>
            <Chip kind="info">saran interval HP: {Math.round(status.hint.intervalMs / 1000)} dtk</Chip>
            <span className="trk-muted">{status.hint.reason}</span>
          </div>
        )}
        {!settings.enabled && <div className="au-alert err" style={{ marginTop: 8 }}>Pelacakan dimatikan di pengaturan. Kiriman dari HP akan ditolak sampai dinyalakan lagi.</div>}
      </div>

      {/* ------------------------------------------------ devices */}
      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Perangkat & token</h3>
        <div className="trk-muted" style={{ marginBottom: 8 }}>
          Buat token untuk HP pelacak. Token ditampilkan SEKALI; server hanya menyimpan hash-nya. Buka halaman <b>/track</b> di HP dan tempel token itu.
        </div>
        <div className="trk-row">
          <input className="au-input" placeholder='Nama perangkat, mis. "HP Vivo Y17s"' value={devName} onChange={(e) => setDevName(e.target.value)} />
          <button className="au-btn primary" disabled={busy || !devName.trim()} onClick={() => run('dev', async () => {
            const r = await api('/location/devices', { method: 'POST', body: { name: devName.trim() } });
            setNewToken({ token: r.token, name: r.device.name });
            setDevName('');
            return r;
          }, 'Perangkat dibuat.')}><IconPlus size={15} /> Buat token</button>
        </div>
        {newToken && (
          <div style={{ marginTop: 8 }}>
            <div className="trk-muted">Token untuk <b>{newToken.name}</b> (salin sekarang, tidak akan ditampilkan lagi):</div>
            <code className="trk-token">{newToken.token}</code>
            <div className="trk-row" style={{ marginTop: 6 }}>
              <button className="au-btn" onClick={() => { try { navigator.clipboard.writeText(newToken.token); notify('ok', 'Token disalin.'); } catch { notify('err', 'Tidak bisa menyalin otomatis — salin manual.'); } }}>Salin</button>
              <button className="au-btn" onClick={() => setNewToken(null)}>Sudah disimpan, sembunyikan</button>
            </div>
          </div>
        )}
        <table className="trk-table" style={{ marginTop: 10 }}>
          <thead><tr><th>Nama</th><th>Token</th><th>Kiriman terakhir</th><th /></tr></thead>
          <tbody>
            {(loc.devices || []).map((d) => (
              <tr key={d.id}>
                <td>{d.name}{d.revoked ? ' (dicabut)' : ''}</td>
                <td className="trk-mono">{d.token_prefix}…</td>
                <td>{d.last_seen_at ? fmtDateTime(d.last_seen_at) : 'belum pernah'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="au-btn" disabled={busy} onClick={() => run('revoke', () => api(`/location/devices/${d.id}`, { method: 'DELETE' }), 'Token perangkat dicabut.')}>Cabut</button>
                </td>
              </tr>
            ))}
            {!(loc.devices || []).length && <tr><td colSpan={4} className="trk-muted">Belum ada perangkat. Buat satu, lalu tempel tokennnya di halaman /track pada HP.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* ------------------------------------------------ notices */}
      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Notifikasi penting</h3>
        {!(loc.notices || []).length ? <div className="trk-muted">Belum ada notifikasi.</div> : (
          <div className="au-feed">
            {loc.notices.map((n) => (
              <div key={n.id} className="au-row" style={{ alignItems: 'flex-start' }}>
                <span className="trk-muted trk-small" style={{ minWidth: 96 }}>{fmtDateTime(n.ts)}</span>
                <div style={{ flex: 1 }}>{n.text}<div className="trk-muted trk-small">{n.kind} · {n.delivered ? 'terkirim ke kanal pemilik' : 'dicatat lokal'}</div></div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------------ settings */}
      <div className="au-card">
        <div className="trk-row between"><h3 style={{ margin: 0 }}>Pengaturan pelacakan</h3>
          <button className="au-btn primary" disabled={busy} onClick={saveSettings}><IconCheck size={15} /> Simpan</button>
        </div>
        <label className="au-check" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          <span><b>Pelacakan menyala</b> <span className="au-muted">saklar utama penyimpanan lokasi</span></span>
        </label>
        <div className="au-grid" style={{ marginTop: 6 }}>
          <Field label="Interval saat bergerak (detik)"><input className="au-input" type="number" min="3" max="600" value={form.adaptiveIntervalMs / 1000} onChange={(e) => setForm({ ...form, adaptiveIntervalMs: Number(e.target.value) * 1000 })} /></Field>
          <Field label="Interval saat diam (detik)"><input className="au-input" type="number" min="5" max="3600" value={form.idleIntervalMs / 1000} onChange={(e) => setForm({ ...form, idleIntervalMs: Number(e.target.value) * 1000 })} /></Field>
          <Field label="Jitter minimal (m)" hint="Gerakan lebih kecil dari ini diabaikan (noise GPS)."><input className="au-input" type="number" min="0" max="500" value={form.minMoveM} onChange={(e) => setForm({ ...form, minMoveM: e.target.value })} /></Field>
          <Field label="Akurasi dianggap kasar di atas (m)"><input className="au-input" type="number" min="5" max="2000" value={form.accuracyWarnM} onChange={(e) => setForm({ ...form, accuracyWarnM: e.target.value })} /></Field>
          <Field label="Data dianggap basi setelah (detik)"><input className="au-input" type="number" min="30" max="86400" value={form.staleAfterMs} onChange={(e) => setForm({ ...form, staleAfterMs: e.target.value })} /></Field>
          <Field label="Perjalanan dimulai setelah (m)"><input className="au-input" type="number" min="50" max="10000" value={form.tripStartMoveM} onChange={(e) => setForm({ ...form, tripStartMoveM: e.target.value })} /></Field>
          <Field label="Perhentian minimal (menit)" hint="Berhenti lebih singkat dari ini dianggap lampu merah, bukan kunjungan."><input className="au-input" type="number" min="1" max="360" value={form.stopMinMs} onChange={(e) => setForm({ ...form, stopMinMs: e.target.value })} /></Field>
          <Field label="Perjalanan selesai setelah diam (menit)"><input className="au-input" type="number" min="1" max="360" value={form.tripEndStopMs} onChange={(e) => setForm({ ...form, tripEndStopMs: e.target.value })} /></Field>
          <Field label="Simpan titik mentah (hari)"><input className="au-input" type="number" min="0" max="3650" value={form.sampleRetentionDays} onChange={(e) => setForm({ ...form, sampleRetentionDays: e.target.value })} /></Field>
          <Field label="Simpan perjalanan (hari)"><input className="au-input" type="number" min="0" max="3650" value={form.tripRetentionDays} onChange={(e) => setForm({ ...form, tripRetentionDays: e.target.value })} /></Field>
          <Field label="Maks notifikasi per jam"><input className="au-input" type="number" min="0" max="60" value={form.maxPerHour} onChange={(e) => setForm({ ...form, maxPerHour: e.target.value })} /></Field>
        </div>
        <label className="au-check"><input type="checkbox" checked={form.quietHours} onChange={(e) => setForm({ ...form, quietHours: e.target.checked })} /><span>Jam tenang 22:00–06:00 WIB untuk notifikasi rutin</span></label>
        <label className="au-check"><input type="checkbox" checked={form.geocodeEnabled} onChange={(e) => setForm({ ...form, geocodeEnabled: e.target.checked })} /><span><b>Geocoding</b> <span className="au-muted">nama jalan/daerah dari OpenStreetMap (Nominatim), gratis</span></span></label>
        <label className="au-check"><input type="checkbox" checked={form.poiSearch} onChange={(e) => setForm({ ...form, poiSearch: e.target.checked })} /><span><b>Cari POI sekitar</b> <span className="au-muted">Overpass API untuk menebak tempat berhenti</span></span></label>
        <label className="au-check"><input type="checkbox" checked={form.notifyTripStart} onChange={(e) => setForm({ ...form, notifyTripStart: e.target.checked })} /><span>Notifikasi mulai perjalanan</span></label>
        <label className="au-check"><input type="checkbox" checked={form.notifyTripEnd} onChange={(e) => setForm({ ...form, notifyTripEnd: e.target.checked })} /><span>Notifikasi perjalanan selesai</span></label>
        <label className="au-check"><input type="checkbox" checked={form.notifyArrival} onChange={(e) => setForm({ ...form, notifyArrival: e.target.checked })} /><span>Notifikasi tiba di tempat dikenal</span></label>
        <label className="au-check"><input type="checkbox" checked={form.notifyUnknownStop} onChange={(e) => setForm({ ...form, notifyUnknownStop: e.target.checked })} /><span>Notifikasi berhenti di tempat tak dikenal</span></label>
      </div>

      {/* ------------------------------------------------ privacy */}
      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Privasi data</h3>
        <div className="trk-muted">
          Titik mentah: {loc.counts.samples} · perjalanan: {loc.counts.trips} · perhentian: {loc.counts.stops} · perangkat: {loc.counts.devices}
        </div>
        <div className="trk-row" style={{ marginTop: 8 }}>
          <input className="au-input" style={{ width: 90 }} type="number" min="1" value={purgeDays} onChange={(e) => setPurgeDays(e.target.value)} />
          <span className="trk-muted">hari —</span>
          <button className="au-btn" disabled={busy} onClick={() => {
            if (!window.confirm(`Hapus titik lokasi lebih tua dari ${purgeDays} hari?`)) return;
            run('purge', () => api('/location/privacy/purge', { method: 'POST', body: { confirm: 'HAPUS', olderThanDays: Number(purgeDays) } }), 'Purge selesai.');
          }}>Hapus data lama</button>
          <span className="trk-spacer" />
          <button className="au-btn" disabled={busy} onClick={() => {
            if (!window.confirm('Hapus SELURUH riwayat lokasi (titik, perjalanan, perhentian)? Tempat dan perangkat tetap.')) return;
            run('reset', () => api('/location/privacy/reset', { method: 'POST', body: { confirm: 'HAPUS SEMUA' } }), 'Riwayat lokasi dihapus.');
          }}><IconTrash size={15} /> Hapus semua riwayat</button>
        </div>
      </div>
    </div>
  );
}

// =============================================================== HISTORY TAB

function HistoryTab({ loc, notify, refreshKey }) {
  const [date, setDate] = useState(loc.day.date);
  const [day, setDay] = useState(null);
  const [tripId, setTripId] = useState(null);
  const [tripData, setTripData] = useState(null);
  const [range, setRange] = useState({ from: loc.day.date, to: loc.day.date, data: null, busy: false });
  const [wwi, setWwi] = useState(null);

  useEffect(() => {
    let on = true;
    api(`/location/day?date=${date}`)
      .then((r) => { if (on) setDay(r.day); })
      .catch((e) => notify('err', e.message));
    return () => { on = false; };
  }, [date, refreshKey, notify]);

  useEffect(() => {
    if (!tripId) { setTripData(null); return undefined; }
    let on = true;
    api(`/location/trips/${tripId}`)
      .then((r) => { if (on) setTripData(r); })
      .catch((e) => notify('err', e.message));
    return () => { on = false; };
  }, [tripId, notify]);

  const loadRange = async () => {
    setRange((r) => ({ ...r, busy: true }));
    try {
      const r = await api(`/location/range?from=${range.from}&to=${range.to}`);
      setRange((x) => ({ ...x, data: r, busy: false }));
    } catch (e) {
      notify('err', e.message);
      setRange((x) => ({ ...x, busy: false }));
    }
  };

  const loadWwi = async () => {
    try { setWwi(await api(`/location/where-was-i?date=${date}`)); }
    catch (e) { notify('err', e.message); }
  };

  const trip = tripData?.trip;

  return (
    <div className="trk-grid">
      <div className="au-card">
        <div className="trk-row">
          <b>Hari:</b>
          <input className="au-input" type="date" value={date} max={todayStr()} onChange={(e) => { setDate(e.target.value); setTripId(null); }} />
          <button className="au-btn" onClick={() => setDate(todayStr())}>Hari ini</button>
          <span className="trk-spacer" />
          <button className="au-btn" onClick={loadWwi}><IconClock size={15} /> Di mana saya tadi?</button>
        </div>
        {wwi && (
          <div className="trk-honesty" style={{ marginTop: 8 }}>
            {wwi.lastKnown
              ? <>Titik terakhir {date === todayStr() ? 'hari ini' : 'pada tanggal itu'}: <b>{wwi.lastKnown.lat.toFixed(5)}, {wwi.lastKnown.lon.toFixed(5)}</b> ({wwi.lastKnown.time}{wwi.lastKnown.label ? ` · ${wwi.lastKnown.label}` : ''}) · jarak lintasan GPS {fmtDist(wwi.distanceM)} · {wwi.trips} perjalanan.</>
              : 'Tidak ada titik lokasi yang tersimpan pada tanggal itu.'}
            {wwi.note ? <div className="trk-muted">{wwi.note}</div> : null}
          </div>
        )}
      </div>

      {!day ? <div className="au-card au-empty">Memuat ringkasan hari…</div> : (
        <>
          <div className="au-card">
            <div className="trk-grid trk-cols-3">
              <Stat v={fmtDist(day.distanceM)} l="jarak lintasan GPS (bukan odometer)" />
              <Stat v={day.trips.length} l="perjalanan" />
              <Stat v={day.stops.length} l="perhentian bermakna" />
            </div>
            <div className="trk-muted" style={{ marginTop: 6 }}>
              {day.dataQuality.note} · {day.sampleCount} titik tersimpan · pertama bergerak {fmtTime(day.firstMoveAt)} · terakhir {fmtTime(day.lastMoveAt)}
            </div>
            {day.dataQuality.gaps > 0 && <div className="au-alert err" style={{ marginTop: 6 }}>Ada {day.dataQuality.gaps} jeda data &gt; 5 menit — jarak bisa lebih kecil dari yang sebenarnya.</div>}
          </div>

          <div className="au-card">
            <h3 style={{ marginTop: 0 }}>Lini masa</h3>
            {!day.timeline.length ? <div className="trk-muted">Tidak ada aktivitas yang tercatat pada hari ini.</div> : (
              <div className="trk-timeline">
                {day.timeline.map((row, i) => (
                  <div key={`${row.kind}-${i}`} className={`trk-tl-row ${row.kind}${row.unknown ? ' unknown' : ''}`}>
                    <div className="trk-tl-time">{fmtTime(row.at)}{row.endAt ? `–${fmtTime(row.endAt)}` : '…'}</div>
                    <div className="trk-tl-body">
                      {row.kind === 'trip'
                        ? <>Perjalanan · {row.label}{row.toLabel ? ` → ${row.toLabel}` : ''} · {fmtDist(row.distanceM)}
                          <button className="au-btn trk-small" style={{ marginLeft: 8, padding: '2px 8px' }} onClick={() => setTripId(row.tripId)}>Lihat rute</button>
                        </>
                        : <>Berhenti di <b>{row.label}</b> <PlaceKindChip kind={row.stopKind} /> <span className="trk-muted">· {fmtDur((row.durationMs || 0) / 1000)}</span></>}
                      <div className="trk-tl-sub">{row.kind === 'stop' && row.confidence != null ? `keyakinan klasifikasi ${Math.round((row.confidence || 0) * 100)}%` : ''}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tripId && tripData && (
        <div className="au-card">
          <div className="trk-row between">
            <h3 style={{ margin: 0 }}>Rute perjalanan</h3>
            <button className="au-btn" onClick={() => setTripId(null)}>Tutup</button>
          </div>
          {trip && (
            <div className="trk-grid trk-cols-3" style={{ marginTop: 8 }}>
              <Stat v={fmtDist(trip.distance_m)} l="jarak lintasan GPS" />
              <Stat v={fmtDur((trip.moving_s || trip.duration_s) / 1)} l={trip.moving_s ? 'durasi bergerak' : 'durasi'} />
              <Stat v={kmh(trip.avg_speed_mps)} l={`rata-rata (maks ${kmh(trip.max_speed_mps)})`} />
            </div>
          )}
          {trip && <div className="trk-muted" style={{ marginTop: 6 }}>{trip.start_label || 'awal'} → {trip.end_label || 'akhir'} · {trip.sample_count} titik · kualitas: {trip.quality || '—'}</div>}
          <div style={{ marginTop: 8 }}>
            <MapView height={380} trail={tripData.samples} stops={tripData.stops} fit rev={`${tripId}|${tripData.samples.length}`} />
          </div>
        </div>
      )}

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Rentang tanggal (mingguan)</h3>
        <div className="trk-row">
          <input className="au-input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <span className="trk-muted">s/d</span>
          <input className="au-input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          <button className="au-btn" disabled={range.busy} onClick={loadRange}>Hitung</button>
        </div>
        {range.data && (
          <>
            <div className="trk-row" style={{ marginTop: 8 }}>
              <Stat v={fmtDist(range.data.totalDistanceM)} l="total lintasan GPS" />
              <Stat v={range.data.totalTrips} l="total perjalanan" />
            </div>
            <table className="trk-table" style={{ marginTop: 8 }}>
              <thead><tr><th>Tanggal</th><th>Jarak GPS</th><th>Perjalanan</th><th>Perhentian</th></tr></thead>
              <tbody>
                {range.data.days.map((d) => (
                  <tr key={d.date}><td>{d.date}</td><td>{fmtDist(d.distanceM)}</td><td>{d.trips}</td><td>{d.stops}</td></tr>
                ))}
                {!range.data.days.length && <tr><td colSpan={4} className="trk-muted">Tidak ada data pada rentang itu.</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

// ================================================================ PLACES TAB

const KINDS = ['home', 'office', 'mall', 'fuel', 'food', 'minimarket', 'workshop', 'campus', 'parking', 'road', 'pharmacy', 'bank', 'clinic', 'worship', 'laundry', 'public', 'vacant', 'unknown'];

function PlacesTab({ loc, notify, refresh }) {
  const status = loc.status;
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ name: '', kind: 'public', lat: '', lon: '', radiusM: 120 });
  const [stops, setStops] = useState([]);
  const [corr, setCorr] = useState({});
  const [focus, setFocus] = useState(null);

  const loadStops = useCallback(() => {
    api(`/location/stops?date=${loc.day.date}`)
      .then((r) => setStops(r.stops || []))
      .catch(() => { /* optional */ });
  }, [loc.day.date]);
  useEffect(() => { loadStops(); }, [loadStops, loc.day.date]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); if (ok) notify('ok', ok); await refresh(); loadStops(); }
    catch (e) { notify('err', e.message); }
    finally { setBusy(''); }
  };

  const useCurrent = () => {
    if (!status.position) return notify('err', 'Belum ada posisi terkini untuk dipakai.');
    setForm((f) => ({ ...f, lat: status.position.lat.toFixed(6), lon: status.position.lon.toFixed(6) }));
  };

  return (
    <div className="trk-grid">
      <div className="au-card">
        <div className="trk-row between">
          <h3 style={{ margin: 0 }}>Tempat yang dikenal (geofence)</h3>
          <span className="trk-muted">dipakai untuk mengenali kunjungan dan memberi nama lokasi</span>
        </div>
        <div style={{ marginTop: 8 }}>
          <MapView
            height={260}
            center={focus ? [focus.lat, focus.lon] : (status.position ? [status.position.lat, status.position.lon] : null)}
            zoom={14}
            markers={(loc.places || []).filter((p) => p.active).map((p) => ({ lat: p.lat, lon: p.lon, label: `${p.name} (${p.kind})`, color: '#a78bfa' }))}
            rev={`${(loc.places || []).length}|${focus ? focus.id : ''}`}
          />
        </div>
        <table className="trk-table" style={{ marginTop: 10 }}>
          <thead><tr><th>Nama</th><th>Kategori</th><th>Radius</th><th>Kunjungan</th><th>Terakhir</th><th>Sumber</th><th /></tr></thead>
          <tbody>
            {(loc.places || []).map((p) => (
              <tr key={p.id}>
                <td>{p.name}{!p.active ? ' (nonaktif)' : ''}{p.confirm_state !== 'confirmed' ? ` ${p.confirm_state}` : ''}</td>
                <td>
                  <select className="au-input" value={p.kind} onChange={(e) => run('', () => api(`/location/places/${p.id}`, { method: 'PATCH', body: { kind: e.target.value } }), 'Kategori tempat disimpan.')}>
                    {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </td>
                <td>{p.radius_m} m</td>
                <td>{p.visits}</td>
                <td>{p.last_visit_at ? fmtDateTime(p.last_visit_at) : '—'}</td>
                <td className="trk-muted">{p.source}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="au-btn trk-small" onClick={() => setFocus(p)}>Peta</button>{' '}
                  <button className="au-btn trk-small" disabled={busy} onClick={() => run('', () => api(`/location/places/${p.id}`, { method: 'PATCH', body: { active: !p.active } }), p.active ? 'Tempat dinonaktifkan.' : 'Tempat diaktifkan.')}>{p.active ? 'Matikan' : 'Aktifkan'}</button>{' '}
                  <button className="au-btn trk-small" disabled={busy} onClick={() => { if (window.confirm(`Hapus tempat "${p.name}"?`)) run('', () => api(`/location/places/${p.id}`, { method: 'DELETE' }), 'Tempat dihapus.'); }}><IconTrash size={13} /></button>
                </td>
              </tr>
            ))}
            {!(loc.places || []).length && <tr><td colSpan={7} className="trk-muted">Belum ada tempat. Tambahkan rumah/kantor lewat formulir di bawah, atau beri nama perhentian terakhir.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Tambah tempat</h3>
        <div className="au-grid trk-cols-2">
          <Field label="Nama"><input className="au-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder='mis. "Rumah"' /></Field>
          <Field label="Kategori">
            <select className="au-input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </Field>
          <Field label="Latitude"><input className="au-input" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} placeholder="-6.2383" /></Field>
          <Field label="Longitude"><input className="au-input" value={form.lon} onChange={(e) => setForm({ ...form, lon: e.target.value })} placeholder="106.9756" /></Field>
          <Field label="Radius (m)"><input className="au-input" type="number" min="25" max="2000" value={form.radiusM} onChange={(e) => setForm({ ...form, radiusM: e.target.value })} /></Field>
        </div>
        <div className="trk-row" style={{ marginTop: 8 }}>
          <button className="au-btn" onClick={useCurrent} disabled={!status.position}>Pakai posisi terkini</button>
          <button className="au-btn primary" disabled={busy || !form.name.trim() || !form.lat || !form.lon} onClick={() => run('place', async () => {
            await api('/location/places', { method: 'POST', body: { name: form.name.trim(), kind: form.kind, lat: Number(form.lat), lon: Number(form.lon), radiusM: Number(form.radiusM) } });
            setForm({ name: '', kind: 'public', lat: '', lon: '', radiusM: 120 });
          }, 'Tempat disimpan.')}><IconPlus size={15} /> Simpan tempat</button>
        </div>
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Perbaiki perhentian hari ini</h3>
        <div className="trk-muted" style={{ marginBottom: 6 }}>
          Beri nama perhentian yang salah/belum dikenal. Centang "jadikan tempat" untuk membuat geofence agar kunjungan berikutnya langsung dikenali.
        </div>
        {!stops.length ? <div className="trk-muted">Belum ada perhentian bermakna pada tanggal ini.</div> : (
          <div className="trk-timeline">
            {stops.map((st) => {
              const c = corr[st.id] || { kind: st.corrected_kind || st.kind, label: st.corrected_label || st.label || '', savePlace: true, busy: false };
              return (
                <div key={st.id} className={`trk-tl-row stop${(st.corrected_kind || st.kind) === 'unknown' ? ' unknown' : ''}`}>
                  <div className="trk-tl-time">{fmtTime(st.started_at)}{st.ended_at ? `–${fmtTime(st.ended_at)}` : '…'}</div>
                  <div className="trk-tl-body">
                    <div className="trk-row">
                      <select className="au-input" style={{ maxWidth: 170 }} value={c.kind} onChange={(e) => setCorr({ ...corr, [st.id]: { ...c, kind: e.target.value } })}>
                        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                      <input className="au-input" style={{ flex: 1, minWidth: 140 }} placeholder="Nama tempat (opsional)" value={c.label} onChange={(e) => setCorr({ ...corr, [st.id]: { ...c, label: e.target.value } })} />
                      <label className="au-check trk-small"><input type="checkbox" checked={c.savePlace} onChange={(e) => setCorr({ ...corr, [st.id]: { ...c, savePlace: e.target.checked } })} /><span>jadikan tempat</span></label>
                      <button className="au-btn primary trk-small" disabled={busy} onClick={() => run('corr', () => api(`/location/stops/${st.id}/correct`, { method: 'POST', body: { kind: c.kind, label: c.label || null, savePlace: c.savePlace, radiusM: 120 } }), 'Perhentian diperbaiki.')}>Simpan</button>
                    </div>
                    <div className="trk-tl-sub">saat ini: {st.corrected_label || st.label || 'belum bernama'} <PlaceKindChip kind={st.corrected_kind || st.kind} /> · keyakinan {Math.round((st.confidence || 0) * 100)}% · sumber {st.source}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================= EMERGENCY TAB

const PRESETS = [['sudden_stop', 'Tiba-tiba berhenti (GPS)'], ['impact_sensors', 'Benturan (akselerometer)'], ['manual', 'Tombol darurat']];

function EmergencyTab({ emg, loc, notify, refresh, refreshKey }) {
  const status = emg.status;
  const [busy, setBusy] = useState('');
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [test, setTest] = useState({ preset: 'sudden_stop', answer: '', auto: true, result: null });
  const [contact, setContact] = useState({ name: '', phone: '', email: '', telegramChatId: '', relation: '', priority: 10, whatsapp: true, emailOk: true, telegramOk: true });
  const [settings, setSettings] = useState(null);
  const [tick, setTick] = useState(Date.now());

  useEffect(() => { const i = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(i); }, []);
  useEffect(() => {
    let on = true;
    api('/emergency/history?limit=30').then((r) => { if (on) setEvents(r.events || []); }).catch(() => { /* optional */ });
    return () => { on = false; };
  }, [refreshKey]);

  useEffect(() => {
    if (settings === null && status) {
      setSettings({
        enabled: status.enabled,
        mode: status.mode,
        countdownS: Math.round(status.countdownMs / 1000),
        sensitivity: status.sensitivity,
        requireConfirmation: status.requireConfirmation,
        autoEscalateOnTimeout: status.autoEscalateOnTimeout,
        notifyOwnerFirst: true,
        includeLastKnownLocation: true,
        maxAttemptsPerContact: status.maxAttemptsPerContact,
        retryDelayS: Math.round(status.retryDelayMs / 1000),
      });
    }
  }, [settings, status]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { const r = await fn(); if (ok) notify('ok', typeof ok === 'function' ? ok(r) : ok); await refresh(); return r; }
    catch (e) { notify('err', e.message); return null; }
    finally { setBusy(''); }
  };

  const open = status.openEvent;
  const remainMs = open?.confirm_deadline ? open.confirm_deadline - tick : null;

  const saveSettings = () => {
    const body = {
      enabled: settings.enabled,
      countdownMs: Number(settings.countdownS) * 1000,
      sensitivity: settings.sensitivity,
      requireConfirmation: settings.requireConfirmation,
      autoEscalateOnTimeout: settings.autoEscalateOnTimeout,
      notifyOwnerFirst: settings.notifyOwnerFirst,
      includeLastKnownLocation: settings.includeLastKnownLocation,
      maxAttemptsPerContact: Number(settings.maxAttemptsPerContact),
      retryDelayMs: Number(settings.retryDelayS) * 1000,
    };
    if (settings.mode !== status.mode) {
      if (settings.mode === 'live') {
        const typed = window.prompt('Menyalakan mode LIVE berarti pesan darurat BENAR-BENAR dikirim ke kontak terverifikasi. Ketik LIVE untuk konfirmasi:');
        if (typed !== 'LIVE') { notify('err', 'Mode live tidak diaktifkan (konfirmasi tidak cocok).'); setSettings({ ...settings, mode: status.mode }); return; }
        body.mode = 'live';
        body.confirmLive = 'LIVE';
      } else {
        body.mode = 'simulate';
      }
    }
    return run('emg-settings', () => api('/emergency/settings', { method: 'PUT', body }), 'Pengaturan darurat disimpan.');
  };

  return (
    <div className="trk-grid">
      <div className={`au-card ${status.mode === 'live' ? '' : 'au-alert'}`} style={status.mode === 'live' ? {} : { borderColor: 'rgba(168,85,247,.45)' }}>
        <div className="trk-row between">
          <div className="trk-row">
            {status.mode === 'live' ? <Chip kind="live">MODE LIVE</Chip> : <Chip kind="sim">MODE SIMULASI</Chip>}
            <b>{status.notice}</b>
          </div>
          <div className="trk-row">
            <Chip kind={status.channels.telegram ? 'ok' : 'muted'}>Telegram {status.channels.telegram ? 'siap' : 'belum'}</Chip>
            <Chip kind={status.channels.whatsapp ? 'ok' : 'muted'}>WhatsApp {status.channels.whatsapp ? 'siap' : 'belum'}</Chip>
            <Chip kind={status.channels.email ? 'ok' : 'muted'}>Email {status.channels.email ? 'siap' : 'belum'}</Chip>
            <Chip kind={status.channels.webhook ? 'ok' : 'muted'}>Webhook {status.channels.webhook ? 'siap' : 'belum'}</Chip>
          </div>
        </div>
        <div className="trk-muted" style={{ marginTop: 6 }}>
          Kontak: {status.contacts.total} total, {status.contacts.reachable} siap dihubungi. Kanal bertanda "belum" tidak dikonfigurasi — pesan darurat lewat kanal itu tidak mungkin terkirim, dan itu dilaporkan apa adanya.
        </div>
      </div>

      {open && (
        <div className="au-card">
          <h3 style={{ marginTop: 0 }}><IconAlert size={17} /> Kejadian darurat sedang berjalan</h3>
          <div className="trk-row" style={{ marginBottom: 6 }}><EmgChip status={open.status} /> <span className="trk-muted">dibuat {fmtTime(open.ts)} · asal {open.origin}</span></div>
          <div className="trk-muted" style={{ marginBottom: 8 }}>{open.trigger?.summary || '—'}</div>
          {remainMs != null && remainMs > 0 && open.status === 'confirming' && (
            <div className="trk-countdown">
              <div className="num">{Math.ceil(remainMs / 1000)}</div>
              <div className="cap">detik menuju eskalasi — jawab dari sini atau dari HP (halaman /track)</div>
            </div>
          )}
          <div className="trk-row" style={{ marginTop: 8 }}>
            <button className="au-btn primary" disabled={busy} onClick={() => run('resp', () => api('/emergency/respond', { method: 'POST', body: { answer: 'safe' } }), 'Ditandai aman. Kejadian dibatalkan tanpa menghubungi siapa pun.')}><IconCheck size={15} /> Saya aman</button>
            <button className="au-btn" disabled={busy} onClick={() => { if (window.confirm('Jawab "butuh bantuan"? Eskalasi berjalan sesuai mode sekarang.')) run('resp', () => api('/emergency/respond', { method: 'POST', body: { answer: 'help' } }), 'Eskalasi dijalankan.'); }}><IconAlert size={15} /> Butuh bantuan</button>
            <span className="trk-spacer" />
            <button className="au-btn" disabled={busy} onClick={() => run('resolve', () => api('/emergency/resolve', { method: 'POST', body: { eventId: open.id, resolution: 'ditutup dari dashboard' } }), 'Kejadian ditutup.')}>Tutup kejadian</button>
          </div>
          {open.location?.lat != null && (
            <div style={{ marginTop: 8 }}>
              <MapView height={220} center={[open.location.lat, open.location.lon]} markers={[{ lat: open.location.lat, lon: open.location.lon, accuracy: open.location.accuracy, label: open.location.label || 'lokasi kejadian', color: '#f87171' }]} rev={open.id} />
              <div className="trk-muted" style={{ marginTop: 4 }}>{open.location.label || `${open.location.lat.toFixed(5)}, ${open.location.lon.toFixed(5)}`} · {open.location.fresh ? 'live' : 'titik terakhir yang diketahui'}</div>
            </div>
          )}
        </div>
      )}

      <div className="au-card">
        <div className="trk-row between"><h3 style={{ margin: 0 }}>Kontak darurat</h3><span className="trk-muted">hanya kontak terverifikasi yang dihubungi saat live</span></div>
        <div className="trk-people" style={{ marginTop: 8 }}>
          {(emg.contacts || []).map((c) => (
            <div key={c.id} className="trk-person">
              <div className="grow">
                <div className="name">{c.name} {c.verified ? <Chip kind="ok">terverifikasi</Chip> : <Chip kind="warn">belum diverifikasi</Chip>} {!c.active ? <Chip kind="muted">nonaktif</Chip> : null}</div>
                <div className="meta">
                  prioritas {c.priority} · {c.relation || 'relasi belum diisi'} · {[c.phone && 'WA/telepon', c.telegram_chat_id && 'Telegram', c.email && 'email'].filter(Boolean).join(', ') || 'belum ada kanal'}
                  {c.last_attempt_at ? ` · upaya terakhir ${fmtDateTime(c.last_attempt_at)} (${c.last_status || '-'})` : ''}
                </div>
              </div>
              <button className="au-btn trk-small" disabled={busy || c.verified} onClick={() => {
                if (!window.confirm(`Verifikasi ${c.name}? Dengan ini Anda menyatakan orang ini tahu dan bersedia dihubungi saat darurat.`)) return;
                run('verify', () => api(`/emergency/contacts/${c.id}/verify`, { method: 'POST', body: { consent: true } }), 'Kontak diverifikasi.');
              }}>Verifikasi</button>
              <button className="au-btn trk-small" disabled={busy} onClick={() => {
                const typed = window.prompt(`Kirim SATU pesan UJI ke ${c.name} lewat kanal yang aktif? (mode sekarang: ${status.mode}). Ketik UJI untuk konfirmasi:`);
                if (typed !== 'UJI') return;
                run('ctest', () => api(`/emergency/contacts/${c.id}/test`, { method: 'POST', body: { confirm: 'UJI' } }), (r) => {
                  const rows = (r.results || []).map((x) => `${x.channel}=${x.status}${x.error ? ` (${x.error})` : ''}`);
                  return rows.length ? `Hasil uji: ${rows.join(', ')}` : 'Tidak ada kanal aktif untuk kontak ini.';
                });
              }}>Uji kanal</button>
              <button className="au-btn trk-small" disabled={busy} onClick={() => run('cact', () => api(`/emergency/contacts/${c.id}`, { method: 'PATCH', body: { active: !c.active } }), c.active ? 'Kontak dinonaktifkan.' : 'Kontak diaktifkan.')}>{c.active ? 'Nonaktifkan' : 'Aktifkan'}</button>
              <button className="au-btn trk-small" disabled={busy} onClick={() => { if (window.confirm(`Hapus kontak ${c.name}?`)) run('cdel', () => api(`/emergency/contacts/${c.id}`, { method: 'DELETE' }), 'Kontak dihapus.'); }}><IconTrash size={13} /></button>
            </div>
          ))}
          {!(emg.contacts || []).length && <div className="trk-muted">Belum ada kontak darurat. Tambahkan satu di bawah, lalu verifikasi setelah memastikan orangnya bersedia.</div>}
        </div>

        <h4 style={{ marginBottom: 4 }}>Tambah kontak</h4>
        <div className="au-grid trk-cols-2">
          <Field label="Nama"><input className="au-input" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} /></Field>
          <Field label="Hubungan (opsional)"><input className="au-input" value={contact.relation} onChange={(e) => setContact({ ...contact, relation: e.target.value })} placeholder="mis. kakak" /></Field>
          <Field label="Nomor WA/telepon"><input className="au-input" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} placeholder="08xx…" /></Field>
          <Field label="Telegram chat id"><input className="au-input" value={contact.telegramChatId} onChange={(e) => setContact({ ...contact, telegramChatId: e.target.value })} /></Field>
          <Field label="Email"><input className="au-input" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} /></Field>
          <Field label="Prioritas (kecil = didahulukan)"><input className="au-input" type="number" min="1" value={contact.priority} onChange={(e) => setContact({ ...contact, priority: e.target.value })} /></Field>
        </div>
        <div className="trk-row" style={{ marginTop: 6 }}>
          <label className="au-check"><input type="checkbox" checked={contact.whatsapp} onChange={(e) => setContact({ ...contact, whatsapp: e.target.checked })} /><span>WA aktif</span></label>
          <label className="au-check"><input type="checkbox" checked={contact.telegramOk} onChange={(e) => setContact({ ...contact, telegramOk: e.target.checked })} /><span>Telegram aktif</span></label>
          <label className="au-check"><input type="checkbox" checked={contact.emailOk} onChange={(e) => setContact({ ...contact, emailOk: e.target.checked })} /><span>Email aktif</span></label>
          <button className="au-btn primary" disabled={busy || !contact.name.trim()} onClick={() => run('cadd', async () => {
            await api('/emergency/contacts', { method: 'POST', body: contact });
            setContact({ name: '', phone: '', email: '', telegramChatId: '', relation: '', priority: 10, whatsapp: true, emailOk: true, telegramOk: true });
          }, 'Kontak ditambahkan. Langkah berikutnya: verifikasi.')}><IconPlus size={15} /> Tambah</button>
        </div>
        <div className="trk-honesty" style={{ marginTop: 8 }}>
          Pastikan orangnya tahu dan setuju dihubungi. Sistem tidak memverifikasi nomor secara diam-diam; verifikasi adalah pernyataan Anda.
        </div>
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Uji alur darurat (tidak mengirim pesan nyata)</h3>
        <div className="trk-row">
          <select className="au-input" value={test.preset} onChange={(e) => setTest({ ...test, preset: e.target.value })}>
            {PRESETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="au-input" value={test.answer} onChange={(e) => setTest({ ...test, answer: e.target.value })}>
            <option value="">tanpa jawaban (hitung mundur habis)</option>
            <option value="safe">jawab "aman"</option>
            <option value="help">jawab "butuh bantuan"</option>
          </select>
          <button className="au-btn primary" disabled={busy} onClick={() => run('sim', async () => {
            const r = await api('/emergency/test', { method: 'POST', body: { preset: test.preset, auto: true, answer: test.answer || null, countdownMs: 5000 } });
            setTest((t) => ({ ...t, result: r }));
            return r;
          }, 'Simulasi alur darurat selesai — tidak ada pesan nyata.')}>Jalankan uji</button>
        </div>
        {test.result && (
          <div style={{ marginTop: 8 }}>
            <div className="trk-row"><EmgChip status={test.result.event?.status} /><span className="trk-muted">kejadian {test.result.event?.id}</span></div>
            <ol className="trk-small" style={{ margin: '6px 0 0 18px', padding: 0 }}>{(test.result.steps || []).map((s, i) => <li key={i}>{s}</li>)}</ol>
            {!!(test.result.attempts || []).length && (
              <table className="trk-attempts" style={{ marginTop: 6 }}>
                <thead><tr><th>Kanal</th><th>Tujuan</th><th>Status</th><th>Catatan</th></tr></thead>
                <tbody>
                  {test.result.attempts.map((a) => (
                    <tr key={a.id}><td>{a.channel}</td><td>{a.target || '—'}</td><td><AttemptChip status={a.status} /></td><td>{a.error || a.provider_response || '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="trk-honesty" style={{ marginTop: 6 }}>{test.result.guarantee}</div>
          </div>
        )}
        <div className="trk-row" style={{ marginTop: 10 }}>
          <button className="au-btn" disabled={busy} onClick={() => run('sos', () => api('/emergency/sos', { method: 'POST', body: { mode: 'simulate', note: 'uji SOS dari dashboard (simulasi)' } }), 'SOS simulasi dibuat.')}>SOS simulasi</button>
          <button className="au-btn" disabled={busy || status.mode !== 'live'} title={status.mode === 'live' ? 'Membuat kejadian darurat nyata' : 'Hanya aktif pada mode LIVE'} onClick={() => {
            if (!window.confirm('Buat kejadian darurat NYATA sekarang? Eskalasi akan mengirim pesan ke kontak terverifikasi.')) return;
            run('sos-live', () => api('/emergency/sos', { method: 'POST', body: { note: 'tombol darurat dashboard' } }), 'Kejadian darurat dibuat (mode live).');
          }}>SOS LIVE</button>
          <span className="trk-muted">SOS LIVE hanya bisa ditekan saat mode LIVE.</span>
        </div>
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Riwayat kejadian</h3>
        {!events.length ? <div className="trk-muted">Belum ada kejadian tercatat.</div> : (
          <table className="trk-table">
            <thead><tr><th>Waktu</th><th>Status</th><th>Asal</th><th>Ringkasan</th><th /></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDateTime(e.ts)}</td>
                  <td><EmgChip status={e.status} /></td>
                  <td className="trk-muted">{e.origin}</td>
                  <td>{e.trigger?.summary?.slice(0, 90) || e.resolution || e.notes || '—'}</td>
                  <td style={{ textAlign: 'right' }}><button className="au-btn trk-small" onClick={() => setSelected(selected?.id === e.id ? null : e)}>{selected?.id === e.id ? 'Tutup' : 'Detail'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {selected && (
          <div style={{ marginTop: 10 }}>
            <div className="trk-muted trk-small">Kejadian {selected.id} · mode {selected.mode} · {fmtDateTime(selected.ts)} · respons: {selected.response || 'belum ada'} · retakan: {selected.resolution || '—'}</div>
            {!!(selected.attempts || []).length && (
              <table className="trk-attempts" style={{ marginTop: 6 }}>
                <thead><tr><th>Waktu</th><th>Kanal</th><th>Tujuan</th><th>Status</th><th>Catatan</th></tr></thead>
                <tbody>
                  {selected.attempts.map((a) => (
                    <tr key={a.id}><td>{fmtDateTime(a.created_at)}</td><td>{a.channel}</td><td>{a.target || '—'}</td><td><AttemptChip status={a.status} /></td><td>{a.error || a.provider_response || '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {!(selected.attempts || []).length && <div className="trk-muted trk-small" style={{ marginTop: 4 }}>Tidak ada upaya pengiriman pada kejadian ini.</div>}
            {selected.trigger?.signals?.length ? (
              <ul className="trk-small" style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {selected.trigger.signals.map((s, i) => <li key={i}>{s.name}: {s.detail}{s.weight != null ? ` (bobot ${s.weight})` : ''}</li>)}
              </ul>
            ) : null}
            {selected.trigger?.guards?.length ? <div className="trk-honesty" style={{ marginTop: 6 }}>Batasan saat itu: {selected.trigger.guards.join(' · ')}</div> : null}
          </div>
        )}
      </div>

      {settings && (
        <div className="au-card">
          <div className="trk-row between"><h3 style={{ margin: 0 }}>Pengaturan darurat</h3>
            <button className="au-btn primary" disabled={busy} onClick={saveSettings}><IconCheck size={15} /> Simpan</button>
          </div>
          <div className="au-grid trk-cols-2" style={{ marginTop: 8 }}>
            <Field label="Mode"><select className="au-input" value={settings.mode} onChange={(e) => setSettings({ ...settings, mode: e.target.value })}>
              <option value="simulate">simulate — tidak mengirim pesan nyata</option>
              <option value="live">live — benar-benar mengirim</option>
            </select></Field>
            <Field label="Hitung mundur (detik)"><input className="au-input" type="number" min="5" max="300" value={settings.countdownS} onChange={(e) => setSettings({ ...settings, countdownS: e.target.value })} /></Field>
            <Field label="Sensitivitas deteksi"><select className="au-input" value={settings.sensitivity} onChange={(e) => setSettings({ ...settings, sensitivity: e.target.value })}>
              <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
            </select></Field>
            <Field label="Maks upaya per kontak"><input className="au-input" type="number" min="1" max="10" value={settings.maxAttemptsPerContact} onChange={(e) => setSettings({ ...settings, maxAttemptsPerContact: e.target.value })} /></Field>
            <Field label="Jeda antar upaya (detik)"><input className="au-input" type="number" min="5" max="3600" value={settings.retryDelayS} onChange={(e) => setSettings({ ...settings, retryDelayS: e.target.value })} /></Field>
          </div>
          <label className="au-check"><input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} /><span>Modul darurat aktif</span></label>
          <label className="au-check"><input type="checkbox" checked={settings.requireConfirmation} onChange={(e) => setSettings({ ...settings, requireConfirmation: e.target.checked })} /><span>Minta konfirmasi dulu (hitung mundur + tombol "Saya aman")</span></label>
          <label className="au-check"><input type="checkbox" checked={settings.autoEscalateOnTimeout} onChange={(e) => setSettings({ ...settings, autoEscalateOnTimeout: e.target.checked })} /><span>Eskalasi otomatis bila tidak ada jawaban</span></label>
          <label className="au-check"><input type="checkbox" checked={settings.notifyOwnerFirst} onChange={(e) => setSettings({ ...settings, notifyOwnerFirst: e.target.checked })} /><span>Kabari pemilik dulu sebelum menghubungi kontak</span></label>
          <label className="au-check"><input type="checkbox" checked={settings.includeLastKnownLocation} onChange={(e) => setSettings({ ...settings, includeLastKnownLocation: e.target.checked })} /><span>Sertakan lokasi terakhir (bila ada) di pesan darurat</span></label>
          <div className="trk-honesty" style={{ marginTop: 8 }}>
            Deteksi berjalan murni dari data yang benar-benar diterima (GPS HP, dan akselerometer bila HP mengirimkannya lewat halaman /track).
            Tanpa data sensor, tingkat tertinggi adalah "perlu diperhatikan" — sistem tidak akan berpura-pura yakin.
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================== VEHICLE TAB

function VehicleTab({ veh, loc, notify, refresh }) {
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState(null);
  const [fill, setFill] = useState({ ts: localInput(), odoKm: '', liters: '', pricePerLiter: '', totalCost: '', fullTank: true, station: '', note: '' });
  const [odo, setOdo] = useState({ odoKm: '', note: '', allowRegression: false });
  const [svcForm, setSvcForm] = useState(null);
  const [logFor, setLogFor] = useState(null);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    let on = true;
    api('/vehicle/health')
      .then((r) => { if (on) setHealth(r.report); })
      .catch(() => { /* laporan hanya muncul saat berhasil dimuat */ });
    return () => { on = false; };
  }, [veh]);

  useEffect(() => {
    if (form === null && veh.vehicle) {
      const v = veh.vehicle;
      setForm({ name: v.name || '', model: v.model || '', plate: v.plate || '', fuelType: v.fuel_type || 'Pertamax', baselineKmpl: v.baseline_kmpl ?? '', tankLiters: v.tank_liters ?? '', reserveKm: v.reserve_km ?? '', pricePerLiter: v.price_per_liter ?? '', warnLiterThreshold: v.warn_liter_threshold ?? 2 });
    }
  }, [form, veh.vehicle]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); if (ok) notify('ok', ok); await refresh(); }
    catch (e) { notify('err', e.message); }
    finally { setBusy(''); }
  };

  const num = (v) => (v === '' || v == null ? null : Number(v));
  const f = veh.fuel;
  const odoStatus = veh.odometer;

  return (
    <div className="trk-grid">
      <div className="au-card">
        <div className="trk-row between">
          <h3 style={{ margin: 0 }}><IconBike size={18} /> {veh.vehicle.name}</h3>
          <span className="trk-muted">{veh.vehicle.model || 'model belum diisi'}{veh.vehicle.plate ? ` · ${veh.vehicle.plate}` : ''} · bahan bakar {veh.vehicle.fuel_type}</span>
        </div>
        {form && (
          <>
            <div className="au-grid trk-cols-2" style={{ marginTop: 8 }}>
              <Field label="Nama"><input className="au-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Model"><input className="au-input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></Field>
              <Field label="Plat"><input className="au-input" value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} /></Field>
              <Field label="Jenis BBM"><input className="au-input" value={form.fuelType} onChange={(e) => setForm({ ...form, fuelType: e.target.value })} /></Field>
              <Field label="Konsumsi acuan (km/L)" hint="Acuan awal 50 km/L dari Anda. Ubah hanya bila yakin; kalibrasi dari pengisian juga tersedia di bawah."><input className="au-input" type="number" step="0.1" value={form.baselineKmpl} onChange={(e) => setForm({ ...form, baselineKmpl: e.target.value })} /></Field>
              <Field label="Kapasitas tangki (L)" hint="Belum diketahui dari sumber resmi — isi dari buku manual motor Anda agar estimasi sisa masuk akal."><input className="au-input" type="number" step="0.1" value={form.tankLiters} onChange={(e) => setForm({ ...form, tankLiters: e.target.value })} /></Field>
              <Field label="Jarak cadangan (km)"><input className="au-input" type="number" value={form.reserveKm} onChange={(e) => setForm({ ...form, reserveKm: e.target.value })} /></Field>
              <Field label="Harga BBM (Rp/L)" hint="Kosongkan bila belum yakin; estimasi rupiah akan ditandai tidak tersedia."><input className="au-input" type="number" value={form.pricePerLiter} onChange={(e) => setForm({ ...form, pricePerLiter: e.target.value })} /></Field>
            </div>
            <button className="au-btn primary" disabled={busy} onClick={() => run('v', () => api('/vehicle', { method: 'PUT', body: { name: form.name, model: form.model, plate: form.plate, fuelType: form.fuelType, baselineKmpl: num(form.baselineKmpl), tankLiters: num(form.tankLiters), reserveKm: num(form.reserveKm), pricePerLiter: num(form.pricePerLiter), warnLiterThreshold: num(form.warnLiterThreshold) } }), 'Data motor disimpan.')}><IconCheck size={15} /> Simpan</button>
          </>
        )}
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}><IconFuel size={18} /> Estimasi bahan bakar <span className="trk-muted trk-small">(model matematis, bukan sensor)</span></h3>
        <div className="trk-grid trk-cols-3">
          <Stat v={f.sinceFull.km == null ? '—' : `${f.sinceFull.km} km`} l={`sejak pengisian penuh penuh (${f.sinceFull.kmSource || 'belum ada titik awal'})`} />
          <Stat v={f.estimate.litersUsed == null ? '—' : `${f.estimate.litersUsed} L`} l={f.estimate.labels.used} />
          <Stat v={f.estimate.remainingL == null ? '—' : `${f.estimate.remainingL} L`} l={f.estimate.remainingKm == null ? f.estimate.labels.remaining : `sisa ±${f.estimate.remainingKm} km (${f.estimate.workingKmpl} km/L)`} />
        </div>
        <div className="trk-muted" style={{ marginTop: 6 }}>
          Acuan aktif: {f.estimate.workingKmpl} km/L — {f.estimate.workingKmplSource}. {f.actualConsumption.kmpl ? `Konsumsi aktual: ${f.actualConsumption.kmpl} km/L dari ${f.actualConsumption.samples} pengisian penuh.` : 'Belum cukup data pengisian penuh-ke-penuh untuk konsumsi aktual.'}
        </div>
        {f.warnings.map((w, i) => <div key={i} className={`au-alert ${w.level === 'warn' ? 'err' : ''}`} style={{ marginTop: 6 }}>{w.text}</div>)}
        <div className="trk-honesty" style={{ marginTop: 6 }}>{f.estimate.labels.sensor}</div>
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Catat isi bensin</h3>
        <div className="au-grid trk-cols-2">
          <Field label="Waktu"><input className="au-input" type="datetime-local" value={fill.ts} onChange={(e) => setFill({ ...fill, ts: e.target.value })} /></Field>
          <Field label="Odometer saat isi (km, opsional)" hint="Mengisi angka panel membuat konsumsi hl-hl bisa dihitung."><input className="au-input" type="number" value={fill.odoKm} onChange={(e) => setFill({ ...fill, odoKm: e.target.value })} /></Field>
          <Field label="Liter"><input className="au-input" type="number" step="0.01" value={fill.liters} onChange={(e) => setFill({ ...fill, liters: e.target.value })} /></Field>
          <Field label="Harga per liter (Rp)"><input className="au-input" type="number" value={fill.pricePerLiter} onChange={(e) => setFill({ ...fill, pricePerLiter: e.target.value })} /></Field>
          <Field label="SPBU (opsional)"><input className="au-input" value={fill.station} onChange={(e) => setFill({ ...fill, station: e.target.value })} /></Field>
          <Field label="Catatan"><input className="au-input" value={fill.note} onChange={(e) => setFill({ ...fill, note: e.target.value })} /></Field>
        </div>
        <label className="au-check"><input type="checkbox" checked={fill.fullTank} onChange={(e) => setFill({ ...fill, fullTank: e.target.checked })} /><span><b>Isi penuh</b> <span className="au-muted">konsumsi km/L hanya dihitung dari penuh-ke-penuh</span></span></label>
        <button className="au-btn primary" disabled={busy || !fill.liters} style={{ marginTop: 6 }} onClick={() => run('fill', async () => {
          await api('/vehicle/fuel', { method: 'POST', body: { ts: fill.ts ? new Date(fill.ts).getTime() : undefined, odoKm: num(fill.odoKm), liters: Number(fill.liters), pricePerLiter: num(fill.pricePerLiter), fullTank: fill.fullTank, station: fill.station || null, note: fill.note || null } });
          setFill({ ts: localInput(), odoKm: '', liters: '', pricePerLiter: '', totalCost: '', fullTank: true, station: '', note: '' });
        }, 'Pengisian dicatat.')}><IconPlus size={15} /> Catat pengisian</button>

        <table className="trk-table" style={{ marginTop: 10 }}>
          <thead><tr><th>Waktu</th><th>Liter</th><th>Odometer</th><th>Penuh?</th><th>km sejak lalu</th><th>km/L</th><th>Biaya</th><th>SPBU</th><th /></tr></thead>
          <tbody>
            {(veh.fuelLogs || []).map((r) => (
              <tr key={r.id}>
                <td>{fmtDateTime(r.ts)}</td>
                <td>{r.liters} L</td>
                <td>{r.odo_km == null ? '—' : `${r.odo_km} km`}</td>
                <td>{r.full_tank ? <Chip kind="ok">penuh</Chip> : <Chip kind="muted">sebagian</Chip>}</td>
                <td>{r.km_since_prev == null ? '—' : `${r.km_since_prev} km`}</td>
                <td>{r.consumption_kmpl == null ? '—' : r.consumption_kmpl}</td>
                <td>{rupiah(r.total_cost ?? (r.liters && r.price_per_liter ? r.liters * r.price_per_liter : null))}</td>
                <td className="trk-muted">{r.station || '—'}</td>
                <td style={{ textAlign: 'right' }}><button className="au-btn trk-small" disabled={busy} onClick={() => { if (window.confirm('Hapus catatan pengisian ini?')) run('del', () => api(`/vehicle/fuel/${r.id}`, { method: 'DELETE' }), 'Catatan dihapus.'); }}><IconTrash size={13} /></button></td>
              </tr>
            ))}
            {!(veh.fuelLogs || []).length && <tr><td colSpan={9} className="trk-muted">Belum ada catatan pengisian.</td></tr>}
          </tbody>
        </table>

        {veh.calibration && (
          <div className="trk-honesty" style={{ marginTop: 10 }}>
            <b>Kalibrasi acuan:</b> {veh.calibration.available ? (
              <>usulan {veh.calibration.proposedKmpl} km/L (acuan sekarang {veh.calibration.currentKmpl}, perubahan {veh.calibration.changePct}%). <button className="au-btn trk-small" disabled={busy} style={{ marginLeft: 6 }} onClick={() => { if (window.confirm(`Pakai ${veh.calibration.proposedKmpl} km/L sebagai acuan baru?`)) run('cal', () => api('/vehicle/calibration/apply', { method: 'POST' }), 'Acuan konsumsi diperbarui.'); }}>Setujui usulan</button></>
            ) : veh.calibration.reason}
          </div>
        )}
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Odometer</h3>
        <div className="trk-row">
          <Stat v={odoStatus.lastReading ? `${odoStatus.lastReading.odo_km} km` : '—'} l={odoStatus.lastReading ? `pembacaan ${fmtDateTime(odoStatus.lastReading.ts)}` : 'belum pernah dibaca'} />
          <Stat v={odoStatus.ageDays == null ? '—' : `${odoStatus.ageDays} hari`} l="umur catatan" />
          <Stat v={odoStatus.gpsDistanceSinceKm == null ? '—' : `${odoStatus.gpsDistanceSinceKm} km`} l="perkiraan jarak GPS sejak catatan" />
        </div>
        {odoStatus.suggestion && <div className="au-alert" style={{ marginTop: 6 }}>{odoStatus.suggestion}</div>}
        <div className="trk-row" style={{ marginTop: 8 }}>
          <input className="au-input" type="number" style={{ width: 130 }} placeholder="Odometer km" value={odo.odoKm} onChange={(e) => setOdo({ ...odo, odoKm: e.target.value })} />
          <input className="au-input" style={{ flex: 1 }} placeholder="Catatan (mis. foto panel)" value={odo.note} onChange={(e) => setOdo({ ...odo, note: e.target.value })} />
          <label className="au-check trk-small"><input type="checkbox" checked={odo.allowRegression} onChange={(e) => setOdo({ ...odo, allowRegression: e.target.checked })} /><span>panel baru / angka lebih kecil</span></label>
          <button className="au-btn primary" disabled={busy || odo.odoKm === ''} onClick={() => run('odo', async () => {
            await api('/vehicle/odometer', { method: 'POST', body: { odoKm: Number(odo.odoKm), note: odo.note || null, allowRegression: odo.allowRegression } });
            setOdo({ odoKm: '', note: '', allowRegression: false });
          }, 'Pembacaan odometer dicatat.')}>Catat</button>
        </div>
        <div className="trk-muted" style={{ marginTop: 6 }}>{odoStatus.gpsNote}</div>
        {!!(odoStatus.readings || []).length && (
          <table className="trk-table" style={{ marginTop: 8 }}>
            <thead><tr><th>Waktu</th><th>Odometer</th><th>Catatan</th></tr></thead>
            <tbody>{odoStatus.readings.map((r) => <tr key={r.id}><td>{fmtDateTime(r.ts)}</td><td>{r.odo_km} km</td><td className="trk-muted">{r.note || '—'}</td></tr>)}</tbody>
          </table>
        )}
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Jadwal servis</h3>
        <div className="trk-muted" style={{ marginBottom: 6 }}>
          Odometer acuan: {veh.maintenance.odometer.km == null ? 'belum ada' : `${Math.round(veh.maintenance.odometer.km)} km`} ({veh.maintenance.odometer.source}){veh.maintenance.odometer.estimated ? ' — angka pakai perkiraan, bukan pembacaan panel' : ''}.
        </div>
        <table className="trk-table">
          <thead><tr><th>Komponen</th><th>Interval</th><th>Terakhir</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(veh.maintenance.items || []).map((it) => (
              <tr key={it.key}>
                <td>{it.name}{it.safetyCritical ? ' ⚠' : ''} {it.verified ? <Chip kind="info">interval terverifikasi</Chip> : <Chip kind="muted">usulan awal</Chip>}</td>
                <td>{it.intervalKm ? `${it.intervalKm} km` : '—'}{it.intervalMonths ? ` / ${it.intervalMonths} bln` : ''}</td>
                <td>{it.lastServiceAt ? `${fmtDateTime(it.lastServiceAt)}${it.lastServiceOdoKm != null ? ` @ ${it.lastServiceOdoKm} km` : ''}` : 'belum ada'}</td>
                <td><DueChip status={it.status} /><div className="trk-muted trk-small">{it.reason}</div></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="au-btn trk-small" onClick={() => setLogFor(logFor === it.key ? null : it.key)}>Catat servis</button>{' '}
                  <button className="au-btn trk-small" onClick={() => setSvcForm(svcForm?.key === it.key ? null : { key: it.key, intervalKm: it.intervalKm ?? '', intervalMonths: it.intervalMonths ?? '' })}>Ubah interval</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {logFor && (
          <ServiceLogForm
            item={(veh.maintenance.items || []).find((i) => i.key === logFor)}
            busy={busy}
            onCancel={() => setLogFor(null)}
            onSubmit={(body) => run('svc', async () => {
              await api(`/vehicle/maintenance/${logFor}/log`, { method: 'POST', body });
              setLogFor(null);
            }, 'Servis dicatat.')}
          />
        )}
        {svcForm && (
          <div className="au-card" style={{ marginTop: 8 }}>
            <b>Ubah interval: {svcForm.key}</b>
            <div className="trk-row" style={{ marginTop: 4 }}>
              <input className="au-input" type="number" style={{ width: 110 }} placeholder="km" value={svcForm.intervalKm} onChange={(e) => setSvcForm({ ...svcForm, intervalKm: e.target.value })} />
              <input className="au-input" type="number" style={{ width: 110 }} placeholder="bulan" value={svcForm.intervalMonths} onChange={(e) => setSvcForm({ ...svcForm, intervalMonths: e.target.value })} />
              <button className="au-btn primary" disabled={busy} onClick={() => run('item', async () => {
                await api(`/vehicle/maintenance/${svcForm.key}`, { method: 'PATCH', body: { intervalKm: num(svcForm.intervalKm), intervalMonths: num(svcForm.intervalMonths) } });
                setSvcForm(null);
              }, 'Interval disimpan sebagai angka dari Anda.')}>Simpan</button>
              <button className="au-btn" onClick={() => setSvcForm(null)}>Batal</button>
            </div>
            <div className="trk-honesty" style={{ marginTop: 6 }}>Angka yang Anda isi sendiri ditandai "interval terverifikasi" karena bersumber dari Anda — bukan dari sistem.</div>
          </div>
        )}

        <h4 style={{ marginTop: 12, marginBottom: 4 }}>Riwayat servis</h4>
        {!(veh.serviceRecords || []).length ? <div className="trk-muted">Belum ada catatan servis.</div> : (
          <table className="trk-table">
            <thead><tr><th>Waktu</th><th>Komponen</th><th>Odometer</th><th>Bengkel</th><th>Biaya</th><th>Catatan</th><th /></tr></thead>
            <tbody>
              {veh.serviceRecords.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.ts)}</td>
                  <td>{r.item_key || 'umum'}</td>
                  <td>{r.odo_km == null ? '—' : `${r.odo_km} km`}</td>
                  <td>{r.workshop || '—'}</td>
                  <td>{rupiah(r.cost)}</td>
                  <td className="trk-muted">{r.notes || '—'}</td>
                  <td style={{ textAlign: 'right' }}><button className="au-btn trk-small" disabled={busy} onClick={() => { if (window.confirm('Hapus catatan servis ini?')) run('sd', () => api(`/vehicle/services/${r.id}`, { method: 'DELETE' }), 'Catatan servis dihapus.'); }}><IconTrash size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="trk-honesty" style={{ marginTop: 8 }}>
          Interval "usulan awal" disalin dari nilai yang lazim disebutkan untuk Honda Vario 160, tetapi belum berhasil diverifikasi ke sumber resmi Honda dari lingkungan ini.
          Sistem menyimpannya sebagai usulan berstatus belum terverifikasi — jangan pakai sebagai keputusan final: cek buku manual/teknisi.
        </div>
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Catat servis bebas</h3>
        <LogServiceGeneric busy={busy} onSave={(body) => run('svcg', () => api('/vehicle/services', { method: 'POST', body }), 'Catatan servis disimpan.')} items={veh.maintenance.items || []} />
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Laporan kesehatan armada</h3>
        {!health ? <div className="trk-muted">Laporan belum tersedia.</div> : (
          <>
            <div className="trk-row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <Chip kind={health.due.length ? 'err' : 'ok'}>jatuh tempo: {health.due.length ? health.due.map((d) => d.name).join(', ') : 'tidak ada'}</Chip>
              <Chip kind={health.upcoming.length ? 'warn' : 'ok'}>mendekati: {health.upcoming.length ? health.upcoming.map((d) => d.name).join(', ') : 'tidak ada'}</Chip>
              <Chip kind={health.missingData.length ? 'muted' : 'ok'}>tanpa data: {health.missingData.length}</Chip>
            </div>
            {!!health.safetyWarnings.length && health.safetyWarnings.map((w, i) => <div key={i} className="au-alert err" style={{ marginTop: 6 }}>{w}</div>)}
            {!!health.recommendations.length && (
              <ul className="trk-small" style={{ margin: '8px 0 0 18px', padding: 0 }}>
                {health.recommendations.map((r, i) => <li key={i}><b>[{r.priority}]</b> {r.text}</li>)}
              </ul>
            )}
            <div className="trk-honesty" style={{ marginTop: 8 }}>{(health.honesty || []).join(' · ')}</div>
          </>
        )}
      </div>
    </div>
  );
}

function ServiceLogForm({ item, busy, onCancel, onSubmit }) {
  const [f, setF] = useState({ ts: localInput(), odoKm: '', workshop: '', cost: '', notes: '' });
  return (
    <div className="au-card" style={{ marginTop: 8 }}>
      <b>Catat servis: {item?.name || '—'}</b>
      <div className="au-grid trk-cols-2" style={{ marginTop: 6 }}>
        <Field label="Waktu"><input className="au-input" type="datetime-local" value={f.ts} onChange={(e) => setF({ ...f, ts: e.target.value })} /></Field>
        <Field label="Odometer (km)" hint="Kosongkan untuk memakai odometer acuan sekarang."><input className="au-input" type="number" value={f.odoKm} onChange={(e) => setF({ ...f, odoKm: e.target.value })} /></Field>
        <Field label="Bengkel"><input className="au-input" value={f.workshop} onChange={(e) => setF({ ...f, workshop: e.target.value })} /></Field>
        <Field label="Biaya (Rp)"><input className="au-input" type="number" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
      </div>
      <Field label="Catatan / part"><input className="au-input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div className="trk-row" style={{ marginTop: 6 }}>
        <button className="au-btn primary" disabled={busy} onClick={() => onSubmit({ ts: f.ts ? new Date(f.ts).getTime() : undefined, odoKm: f.odoKm === '' ? null : Number(f.odoKm), workshop: f.workshop || null, cost: f.cost === '' ? null : Number(f.cost), notes: f.notes || null })}>Simpan servis</button>
        <button className="au-btn" onClick={onCancel}>Batal</button>
      </div>
    </div>
  );
}

function LogServiceGeneric({ items, busy, onSave }) {
  const [f, setF] = useState({ itemKey: '', ts: localInput(), odoKm: '', workshop: '', cost: '', notes: '' });
  return (
    <>
      <div className="au-grid trk-cols-2">
        <Field label="Komponen (opsional)"><select className="au-input" value={f.itemKey} onChange={(e) => setF({ ...f, itemKey: e.target.value })}>
          <option value="">— umum —</option>
          {items.map((i) => <option key={i.key} value={i.key}>{i.name}</option>)}
        </select></Field>
        <Field label="Waktu"><input className="au-input" type="datetime-local" value={f.ts} onChange={(e) => setF({ ...f, ts: e.target.value })} /></Field>
        <Field label="Odometer (km)"><input className="au-input" type="number" value={f.odoKm} onChange={(e) => setF({ ...f, odoKm: e.target.value })} /></Field>
        <Field label="Bengkel"><input className="au-input" value={f.workshop} onChange={(e) => setF({ ...f, workshop: e.target.value })} /></Field>
        <Field label="Biaya (Rp)"><input className="au-input" type="number" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
        <Field label="Catatan / part"><input className="au-input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
      <button className="au-btn primary" disabled={busy} style={{ marginTop: 4 }} onClick={() => onSave({ itemKey: f.itemKey || null, ts: f.ts ? new Date(f.ts).getTime() : undefined, odoKm: f.odoKm === '' ? null : Number(f.odoKm), workshop: f.workshop || null, cost: f.cost === '' ? null : Number(f.cost), notes: f.notes || null })}><IconPlus size={15} /> Simpan catatan</button>
    </>
  );
}

// =============================================================== MEMORY TAB

const MEM_KIND_LABEL = { preference: 'preferensi', fact: 'fakta', place: 'tempat', person: 'orang', routine: 'rutinitas', note: 'catatan' };

function MemoryTab({ mem, notify, refresh, refreshKey }) {
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [items, setItems] = useState(mem.items || []);
  const [form, setForm] = useState({ kind: 'fact', key: '', value: '', tags: '' });
  const [forgetText, setForgetText] = useState('');
  const [about, setAbout] = useState(null);
  const [editing, setEditing] = useState(null);
  const [history, setHistory] = useState(null);

  useEffect(() => {
    let on = true;
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (kind) params.set('kind', kind);
    api(`/memory/items?${params.toString()}`)
      .then((r) => { if (on) setItems(r.items || []); })
      .catch(() => { /* optional */ });
    return () => { on = false; };
  }, [q, kind, refreshKey]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); if (ok) notify('ok', ok); await refresh(); }
    catch (e) { notify('err', e.message); }
    finally { setBusy(''); }
  };

  const counts = mem.counts;

  return (
    <div className="trk-grid">
      <div className="au-card">
        <div className="trk-row between">
          <h3 style={{ margin: 0 }}>Memori pribadi</h3>
          <span className="trk-muted">{mem.note}</span>
        </div>
        <div className="trk-row" style={{ marginTop: 6 }}>
          {(counts.byKind ? Object.entries(counts.byKind) : []).map(([k, n]) => <Chip key={k} kind="info">{MEM_KIND_LABEL[k] || k}: {n}</Chip>)}
          <Chip kind="muted">total aktif: {counts.total}</Chip>
        </div>
        <div className="trk-row" style={{ marginTop: 8 }}>
          <input className="au-input" style={{ flex: 1 }} placeholder="Cari memori…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="au-input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">semua jenis</option>
            {['preference', 'fact', 'place', 'person', 'routine', 'note'].map((k) => <option key={k} value={k}>{MEM_KIND_LABEL[k]}</option>)}
          </select>
          <button className="au-btn" onClick={async () => {
            try { setAbout(await api(`/memory/about?q=${encodeURIComponent(q)}`)); }
            catch (e) { notify('err', e.message); }
          }}>Lihat yang dibaca AI</button>
        </div>
        {about && (
          <div style={{ marginTop: 8 }}>
            <div className="trk-muted">Blok konteks yang mungkin dipakai AI untuk pertanyaan ini ({about.ids.length} item):</div>
            <pre className="au-pre" style={{ whiteSpace: 'pre-wrap' }}>{about.block || '(kosong — memori belum berisi apa pun yang relevan)'}</pre>
          </div>
        )}
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Tambah memori</h3>
        <div className="au-grid trk-cols-2">
          <Field label="Jenis"><select className="au-input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {['preference', 'fact', 'place', 'person', 'routine', 'note'].map((k) => <option key={k} value={k}>{MEM_KIND_LABEL[k]}</option>)}
          </select></Field>
          <Field label="Kata kunci"><input className="au-input" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder='mis. "kopi favorit"' /></Field>
        </div>
        <Field label="Isi"><textarea className="au-input au-textarea" rows={2} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></Field>
        <Field label="Tag (pisah koma)"><input className="au-input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></Field>
        <button className="au-btn primary" disabled={busy || !form.key.trim() || !form.value.trim()} onClick={() => run('m', async () => {
          await api('/memory/items', { method: 'POST', body: { kind: form.kind, key: form.key.trim(), value: form.value.trim(), tags: form.tags.split(',').map((s) => s.trim()).filter(Boolean) } });
          setForm({ kind: 'fact', key: '', value: '', tags: '' });
        }, 'Memori disimpan.')}><IconPlus size={15} /> Simpan</button>
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Daftar memori ({items.length})</h3>
        {!items.length ? <div className="trk-muted">Tidak ada item yang cocok.</div> : (
          <table className="trk-table">
            <thead><tr><th>Jenis</th><th>Kata kunci</th><th>Isi</th><th>Dipakai</th><th /></tr></thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td><Chip kind="info">{MEM_KIND_LABEL[it.kind] || it.kind}</Chip></td>
                  <td>{it.key}</td>
                  <td>{it.value}{!!(it.tags || []).length && <div className="trk-muted trk-small">{it.tags.join(', ')}</div>}</td>
                  <td className="trk-muted trk-small">{it.times_used}× · {fmtDateTime(it.updated_at)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="au-btn trk-small" onClick={() => setEditing(editing?.id === it.id ? null : { id: it.id, key: it.key, value: it.value, tags: (it.tags || []).join(', ') })}>{editing?.id === it.id ? 'Batal' : 'Ubah'}</button>{' '}
                    <button className="au-btn trk-small" onClick={async () => {
                      if (history?.id === it.id) { setHistory(null); return; }
                      try { const r = await api(`/memory/items/${it.id}/history`); setHistory({ id: it.id, rows: r.history || [] }); }
                      catch (e) { notify('err', e.message); }
                    }}>{history?.id === it.id ? 'Tutup riwayat' : 'Riwayat'}</button>{' '}
                    <button className="au-btn trk-small" disabled={busy} onClick={() => { if (window.confirm(`Lupakan "${it.key}"?`)) run('d', () => api(`/memory/items/${it.id}`, { method: 'DELETE' }), 'Memori dihapus.'); }}><IconTrash size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {editing && (
          <div className="au-card" style={{ marginTop: 8 }}>
            <b>Ubah memori</b>
            <div className="au-row" style={{ marginTop: 6 }}>
              <input className="au-input" value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value })} />
              <input className="au-input" value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} placeholder="tag, dipisah koma" />
            </div>
            <textarea className="au-input au-textarea" rows={2} style={{ marginTop: 6 }} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
            <div className="trk-row" style={{ marginTop: 6 }}>
              <button className="au-btn primary" disabled={busy} onClick={() => run('u', async () => {
                await api(`/memory/items/${editing.id}`, { method: 'PATCH', body: { key: editing.key, value: editing.value, tags: editing.tags.split(',').map((s) => s.trim()).filter(Boolean) } });
                setEditing(null);
              }, 'Memori diperbarui.')}>Simpan perubahan</button>
              <button className="au-btn" onClick={() => setEditing(null)}>Batal</button>
            </div>
          </div>
        )}
        {history && (
          <div style={{ marginTop: 8 }}>
            {!history.rows.length ? <div className="trk-muted">Belum ada riwayat perubahan.</div> : (
              <table className="trk-attempts">
                <thead><tr><th>Waktu</th><th>Aksi</th><th>Nilai lama</th><th>Nilai baru</th></tr></thead>
                <tbody>{history.rows.map((h) => <tr key={h.id}><td>{fmtDateTime(h.ts)}</td><td>{h.action}</td><td>{h.old_value || '—'}</td><td>{h.new_value || '—'}</td></tr>)}</tbody>
              </table>
            )}
          </div>
        )}
        {!items.length && <div className="trk-muted" style={{ marginTop: 6 }}>Memori kosong. AI tidak akan mengarang — ia hanya mengingat yang tercatat di sini.</div>}
      </div>

      <div className="au-card">
        <h3 style={{ marginTop: 0 }}>Lupakan berdasarkan frasa</h3>
        <div className="trk-row">
          <input className="au-input" style={{ flex: 1 }} placeholder='mis. "kopi" atau "nomor polisi"' value={forgetText} onChange={(e) => setForgetText(e.target.value)} />
          <button className="au-btn" disabled={busy || !forgetText.trim()} onClick={() => run('f', async () => {
            const r = await api('/memory/forget', { method: 'POST', body: { q: forgetText.trim() } });
            if (!r.forgotten) notify('err', 'Tidak ada memori yang cocok dengan frasa itu.');
            return r;
          }, 'Memori yang cocok dihapus.')}>Lupakan yang cocok</button>
          <button className="au-btn" disabled={busy} onClick={() => {
            const typed = window.prompt('Ketik LUPA SEMUA untuk menghapus seluruh memori pribadi:');
            if (typed !== 'LUPA SEMUA') return;
            run('fa', () => api('/memory/forget', { method: 'POST', body: { all: true, confirm: 'LUPA SEMUA' } }), 'Seluruh memori dihapus.');
          }}>Hapus semua</button>
        </div>
      </div>
    </div>
  );
}

// ==================================================================== PAGE

const TABS = [
  ['live', 'Live', IconMap],
  ['history', 'Riwayat', IconClock],
  ['places', 'Tempat', IconPin],
  ['emergency', 'Darurat', IconAlert],
  ['vehicle', 'Kendaraan', IconBike],
  ['memory', 'Memori', IconSparkles],
];

export default function Tracking() {
  const [tab, setTab] = useState('live');
  const [data, setData] = useState({ loc: null, emg: null, veh: null, mem: null });
  const [error, setError] = useState('');
  const [toasts, setToasts] = useState([]);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(Date.now());
  const [rev, setRev] = useState(0);
  const timer = useRef(null);

  const notify = useCallback((kind, text) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const load = useCallback(async () => {
    try {
      const [loc, emg, veh, mem] = await Promise.all([
        api('/location/overview'),
        api('/emergency/overview'),
        api('/vehicle/overview'),
        api('/memory/overview'),
      ]);
      setData({ loc, emg, veh, mem });
      setRev((r) => r + 1);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Realtime: every module's change events trigger one debounced reload.
  useEffect(() => {
    const bump = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 900);
    };
    const closers = [
      openStream('/api/location/events', { onOpen: () => setLive(true), onDown: () => setLive(false), events: { change: bump } }),
      openStream('/api/emergency/events', { events: { change: bump, score: bump } }),
      openStream('/api/vehicle/events', { events: { change: bump } }),
      openStream('/api/memory/events', { events: { change: bump } }),
    ];
    return () => { closers.forEach((c) => c()); clearTimeout(timer.current); };
  }, [load]);

  useEffect(() => { const i = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(i); }, []);

  const refresh = useCallback(async () => { await load(); }, [load]);

  return (
    <DashboardLayout>
      <div className="au-page">
        <div className="au-hero">
          <div>
            <h1><span>Pelacakan</span> & motor</h1>
            <p>Posisi terkini, riwayat perjalanan, tempat yang dikenal, alur darurat, perawatan motor, dan memori pribadi — semuanya dari data nyata, tanpa klaim palsu.</p>
          </div>
          <span className={`au-live ${live ? 'on' : ''}`}><i className="au-dot" /> {live ? 'Realtime aktif' : 'Menyambungkan…'}</span>
        </div>

        {error && <div className="au-alert err">{error} — periksa apakah server web berjalan dan token otomasi sudah diisi.</div>}

        <div className="au-tabs" role="tablist">
          {TABS.map(([k, l, Ico]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`au-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
              <Ico size={14} style={{ marginRight: 5, verticalAlign: '-2px' }} />{l}
            </button>
          ))}
        </div>

        {!data.loc ? <div className="au-card au-empty">Memuat data pelacakan…</div> : (
          <>
            {tab === 'live' && <LiveTab loc={data.loc} refresh={refresh} notify={notify} tick={tick} />}
            {tab === 'history' && <HistoryTab loc={data.loc} notify={notify} refreshKey={rev} />}
            {tab === 'places' && <PlacesTab loc={data.loc} notify={notify} refresh={refresh} />}
            {tab === 'emergency' && <EmergencyTab emg={data.emg} loc={data.loc} notify={notify} refresh={refresh} refreshKey={rev} />}
            {tab === 'vehicle' && <VehicleTab veh={data.veh} loc={data.loc} notify={notify} refresh={refresh} />}
            {tab === 'memory' && <MemoryTab mem={data.mem} notify={notify} refresh={refresh} refreshKey={rev} />}
          </>
        )}
      </div>

      <div className="au-toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`au-toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </DashboardLayout>
  );
}
