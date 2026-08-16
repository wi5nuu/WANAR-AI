/**
 * Wanar AI - Job Application Agent UI
 * by Wisnu Alfian Nur Ashar
 *
 * Dashboard untuk mengelola auto-apply job agent:
 * Tab Queue | Review | History | New Session
 */

import React, { useState, useEffect, useCallback } from 'react';
import DashboardLayout from './DashboardLayout';

// ── Confirm Modal ─────────────────────────────────────────────────
function ConfirmModal({ message, onConfirm, onCancel }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 14, padding: 28, maxWidth: 360, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
        <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 20, lineHeight: 1.6 }}>{message}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel}
            style={{ padding: '8px 18px', fontSize: 12, fontWeight: 600, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            Batal
          </button>
          <button onClick={onConfirm}
            style={{ padding: '8px 18px', fontSize: 12, fontWeight: 700, borderRadius: 8, border: 'none', background: '#ef4444', color: 'white', cursor: 'pointer' }}>
            Hapus
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────
function fmtDate(str) {
  if (!str) return '-';
  return new Date(str).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
}

const STATUS_STYLE = {
  pending:      { bg: '#6366f118', color: '#6366f1', label: 'Menunggu' },
  processing:   { bg: '#f59e0b18', color: '#f59e0b', label: 'Diproses' },
  submitted:    { bg: '#22c55e18', color: '#22c55e', label: 'Terkirim' },
  needs_review: { bg: '#f9731618', color: '#f97316', label: 'Perlu Review' },
  skipped:      { bg: '#94a3b818', color: '#94a3b8', label: 'Dilewati' },
  failed:       { bg: '#ef444418', color: '#ef4444', label: 'Gagal' },
  approved:     { bg: '#22c55e18', color: '#22c55e', label: 'Disetujui' },
  rejected:     { bg: '#ef444418', color: '#ef4444', label: 'Ditolak' },
  idle:         { bg: '#6366f118', color: '#6366f1', label: 'Idle' },
  running:      { bg: '#22c55e18', color: '#22c55e', label: 'Berjalan' },
  paused:       { bg: '#f59e0b18', color: '#f59e0b', label: 'Dijeda' },
  completed:    { bg: '#22c55e18', color: '#22c55e', label: 'Selesai' },
};

function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || { bg: '#94a3b818', color: '#94a3b8', label: status };
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
      background: s.bg, color: s.color, border: `1px solid ${s.color}44`,
      whiteSpace: 'nowrap',
    }}>{s.label}</span>
  );
}

const thS = {
  padding: '9px 14px', fontSize: 11, fontWeight: 700,
  color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px',
  borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)',
  whiteSpace: 'nowrap', textAlign: 'left',
};
const tdS = {
  padding: '10px 14px', fontSize: 12, color: 'var(--text-primary)',
  borderBottom: '1px solid var(--border-secondary)', verticalAlign: 'middle',
};

// ── Tab: New Session ─────────────────────────────────────────────
function NewSessionTab({ onCreated }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [trustedMode, setTrustedMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [crawlPreview, setCrawlPreview] = useState(null);
  const [crawling, setCrawling] = useState(false);
  const [error, setError] = useState('');
  const [cdpStatus, setCdpStatus] = useState(null); // null | 'launching' | 'ok' | 'error'
  const [cdpMessage, setCdpMessage] = useState('');

  const handleLaunchChrome = async () => {
    setCdpStatus('launching'); setCdpMessage('');
    try {
      const res = await fetch('/api/job-agent/launch-chrome', { method: 'POST' });
      const data = await res.json();
      if (data.success) { setCdpStatus('ok'); setCdpMessage(data.message); }
      else { setCdpStatus('error'); setCdpMessage(data.message); }
    } catch (e) { setCdpStatus('error'); setCdpMessage(e.message); }
  };

  const handleCrawlPreview = async () => {
    if (!url) return;
    setCrawling(true); setCrawlPreview(null); setError('');
    try {
      const res = await fetch('/api/job-agent/crawl', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (data.success) setCrawlPreview(data);
      else setError(data.error || 'Gagal crawl');
    } catch (e) { setError(e.message); }
    finally { setCrawling(false); }
  };

  const handleCreate = async () => {
    if (!url) { setError('URL listing wajib diisi'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/job-agent/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || 'Job Scan Session', source_url: url, settings: { trustedMode } }),
      });
      const data = await res.json();
      if (data.success) onCreated(data.session);
      else setError(data.error || 'Gagal membuat session');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 20 }}>
        Buat Sesi Baru
      </h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Nama Sesi
          </label>
          <input value={name} onChange={e => setName(e.target.value)}
            placeholder="Job Scan - Agustus 2026"
            style={{ width: '100%', padding: '9px 12px', fontSize: 13, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', boxSizing: 'border-box' }} />
        </div>

        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            URL Halaman Listing Lowongan <span style={{ color: '#ef4444' }}>*</span>
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://glints.com/id/opportunities/jobs/explore?..."
              style={{ flex: 1, padding: '9px 12px', fontSize: 13, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }} />
            <button onClick={handleCrawlPreview} disabled={crawling || !url}
              style={{ padding: '9px 16px', fontSize: 12, fontWeight: 600, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', cursor: crawling || !url ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
              {crawling ? 'Memuat...' : 'Preview'}
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
            Halaman listing dari Glints, Jobstreet, LinkedIn, dll
          </div>
        </div>

        {/* Crawl preview */}
        {crawlPreview && (
          <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)', borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#22c55e', marginBottom: 10 }}>
              {crawlPreview.count} lowongan ditemukan
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
              {crawlPreview.jobs.map((j, i) => (
                <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', gap: 8 }}>
                  <span style={{ color: 'var(--brand-primary)', fontWeight: 600, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.company}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" id="trustedMode" checked={trustedMode} onChange={e => setTrustedMode(e.target.checked)}
            style={{ width: 15, height: 15, cursor: 'pointer' }} />
          <label htmlFor="trustedMode" style={{ fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            Trusted Mode — auto-submit langsung jika semua field confidence ≥85%
          </label>
        </div>

        {/* Chrome CDP launcher */}
        <div style={{ padding: 14, background: '#22c55e10', border: '1px solid #22c55e44', borderRadius: 10 }}>
          <div style={{ fontSize: 11, color: '#22c55e', fontWeight: 700, marginBottom: 8, letterSpacing: '0.5px', textTransform: 'uppercase' }}>
            Mode Pro: Gunakan Chrome yang Sudah Login
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 10 }}>
            Agent akan terhubung ke Chrome yang sudah login Google Anda — menghindari CAPTCHA dan deteksi bot secara maksimal.
          </div>
          <button onClick={handleLaunchChrome} disabled={cdpStatus === 'launching'}
            style={{ padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 8, border: 'none',
              background: cdpStatus === 'ok' ? '#22c55e' : '#22c55e22', color: cdpStatus === 'ok' ? 'white' : '#22c55e',
              cursor: cdpStatus === 'launching' ? 'not-allowed' : 'pointer', transition: 'all 0.2s' }}>
            {cdpStatus === 'launching' ? 'Meluncurkan Chrome...' : cdpStatus === 'ok' ? 'Chrome CDP Aktif' : 'Launch Chrome CDP'}
          </button>
          {cdpMessage && (
            <div style={{ marginTop: 8, fontSize: 11, color: cdpStatus === 'ok' ? '#22c55e' : '#ef4444', lineHeight: 1.5 }}>
              {cdpMessage}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-tertiary)' }}>
            Jika tidak pakai mode ini, agent akan buka Chromium baru (perlu login ulang Google)
          </div>
        </div>

        <div style={{ padding: 14, background: '#6366f110', border: '1px solid #6366f144', borderRadius: 10 }}>
          <div style={{ fontSize: 11, color: '#818cf8', fontWeight: 700, marginBottom: 8, letterSpacing: '0.5px', textTransform: 'uppercase' }}>Cara Kerja Agent</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            <span style={{ color: '#22c55e', fontWeight: 700 }}>1.</span> Crawl halaman listing → extract semua link lowongan<br />
            <span style={{ color: '#22c55e', fontWeight: 700 }}>2.</span> Buka setiap link → deteksi form lamaran<br />
            <span style={{ color: '#22c55e', fontWeight: 700 }}>3.</span> Map field form → data profil Anda (nama, email, CV, dll)<br />
            <span style={{ color: '#22c55e', fontWeight: 700 }}>4.</span> Isi form otomatis + generate cover letter personal<br />
            <span style={{ color: '#22c55e', fontWeight: 700 }}>5.</span> Submit + verifikasi halaman konfirmasi<br />
          </div>
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #6366f144', fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
            <span style={{ color: '#f59e0b' }}>⚠</span> CAPTCHA terdeteksi → browser tetap terbuka, tunggu Anda solve manual<br />
            <span style={{ color: '#f59e0b' }}>⚠</span> Confidence &lt;85% atau submit gagal → masuk Review Queue<br />
            <span style={{ color: '#94a3b8' }}>·</span> Jeda 8–20 detik acak antar navigasi (anti-bot detection)<br />
            <span style={{ color: '#94a3b8' }}>·</span> Max 2x retry per halaman · Cek robots.txt sebelum apply<br />
            <span style={{ color: '#94a3b8' }}>·</span> OCR aktif untuk baca teks dari gambar di form
          </div>
        </div>

        {error && <div style={{ fontSize: 12, color: '#ef4444', padding: '8px 12px', background: '#ef444410', borderRadius: 6 }}>{error}</div>}

        <button onClick={handleCreate} disabled={loading || !url}
          style={{
            padding: '11px 24px', fontSize: 13, fontWeight: 700, borderRadius: 10,
            border: 'none', background: loading || !url ? 'var(--bg-tertiary)' : 'var(--brand-primary)',
            color: loading || !url ? 'var(--text-tertiary)' : 'white',
            cursor: loading || !url ? 'not-allowed' : 'pointer', alignSelf: 'flex-start',
          }}>
          {loading ? 'Membuat...' : 'Buat & Mulai Scan'}
        </button>
      </div>
    </div>
  );
}

// ── Live Feed Panel ──────────────────────────────────────────────
const EVENT_ICON = {
  'session:start':        { icon: '▶', color: '#22c55e' },
  'session:crawling':     { icon: '🔍', color: '#6366f1' },
  'session:crawled':      { icon: '📋', color: '#6366f1' },
  'session:progress':     { icon: '⟳', color: '#f59e0b' },
  'session:completed':    { icon: '✓', color: '#22c55e' },
  'session:paused':       { icon: '⏸', color: '#f59e0b' },
  'session:error':        { icon: '✕', color: '#ef4444' },
  'job:start':            { icon: '→', color: '#6366f1' },
  'job:navigate':         { icon: '⊙', color: '#94a3b8' },
  'job:form_detected':    { icon: '◈', color: '#6366f1' },
  'job:fields':           { icon: '≡', color: '#94a3b8' },
  'job:filling':          { icon: '✎', color: '#6366f1' },
  'job:submitted':        { icon: '✓', color: '#22c55e' },
  'job:review':           { icon: '⚠', color: '#f59e0b' },
  'job:skip':             { icon: '↷', color: '#94a3b8' },
  'job:captcha':          { icon: '🔒', color: '#f59e0b' },
  'job:captcha_solved':   { icon: '🔓', color: '#22c55e' },
  'job:captcha_timeout':  { icon: '⏱', color: '#ef4444' },
  'job:failed':           { icon: '⛔', color: '#ef4444' },
  'job:retry':            { icon: '↺', color: '#f59e0b' },
  'session:browser':      { icon: '🌐', color: '#6366f1' },
};

function eventToText(event) {
  const { type, payload: p } = event;
  switch (type) {
    case 'session:start':     return `Sesi dimulai: ${p.name}`;
    case 'session:crawling':  return `Crawling listing: ${p.url}`;
    case 'session:crawled':   return `${p.count} lowongan ditemukan`;
    case 'session:progress':  return `[${p.current}/${p.total}] ${p.company} — ${p.title}`;
    case 'session:completed': return `Selesai! ${p.submitted} terkirim, ${p.needs_review} review, ${p.skipped} skip, ${p.failed} gagal`;
    case 'session:paused':    return `Dijeda setelah ${p.processed} item`;
    case 'session:error':     return `Error: ${p.error}`;
    case 'job:start':         return `Mulai proses: ${p.company} — ${p.title}`;
    case 'job:navigate':      return `Navigasi ke ${p.url}`;
    case 'job:form_detected': return `Form terdeteksi: ${p.formType} (${p.url})`;
    case 'job:fields':        return `${p.fieldCount} field form ditemukan`;
    case 'job:filling':       return `Mengisi ${p.fieldCount} field untuk ${p.company}`;
    case 'job:submitted':     return `✓ TERKIRIM: ${p.company} — ${p.title} (confidence ${p.confidence}%)`;
    case 'job:review':        return `Review dibutuhkan: ${p.company} — ${p.reason}`;
    case 'job:skip':          return `Dilewati: ${p.company} — ${p.reason}`;
    case 'job:captcha':         return p.solving ? `🤖 CAPTCHA di ${p.company} — mencoba solve otomatis via audio...` : `⚠ CAPTCHA di ${p.company} — selesaikan di browser lalu agent lanjut otomatis`;
    case 'job:captcha_solved':  return p.method === 'audio_auto' ? `✓ CAPTCHA solved otomatis: ${p.company} — melanjutkan proses` : `✓ CAPTCHA solved manual: ${p.company} — melanjutkan proses`;
    case 'job:captcha_timeout': return `Timeout CAPTCHA: ${p.company} — dilewati setelah 3 menit`;
    case 'session:browser':     return p.message || 'Browser siap';
    case 'job:failed':        return `Gagal: ${p.company} — ${p.reason}`;
    case 'job:retry':         return `Retry: ${p.company}`;
    default:                  return type;
  }
}

function LiveFeed({ sessionId }) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const [captchaPending, setCaptchaPending] = useState(null); // { company, url }
  const bottomRef = React.useRef(null);

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/job-agent/sessions/${sessionId}/live`);
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'connected') return;
        // Track CAPTCHA state
        if (data.type === 'job:captcha') {
          if (data.payload?.waitingUser) {
            setCaptchaPending({ company: data.payload?.company, url: data.payload?.url, solving: false });
          } else if (data.payload?.solving) {
            setCaptchaPending({ company: data.payload?.company, url: data.payload?.url, solving: true });
          }
        }
        if (data.type === 'job:captcha_solved' || data.type === 'job:captcha_timeout') setCaptchaPending(null);
        setEvents(prev => [...prev.slice(-199), { ...data, id: Date.now() + Math.random() }]);
      } catch {}
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  return (
    <div style={{
      background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border-primary)',
      overflow: 'hidden', fontFamily: 'monospace',
    }}>
      {/* CAPTCHA banner */}
      {captchaPending && (
        <div style={{ padding: '12px 16px', background: captchaPending.solving ? '#3b82f618' : '#f59e0b18', borderBottom: `1px solid ${captchaPending.solving ? '#3b82f644' : '#f59e0b44'}` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <span style={{ fontSize: 16, flexShrink: 0 }}>{captchaPending.solving ? '🤖' : '🔒'}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: captchaPending.solving ? '#3b82f6' : '#f59e0b', marginBottom: 4 }}>
                {captchaPending.solving ? 'CAPTCHA — Solving Otomatis...' : 'CAPTCHA — Tindakan Diperlukan'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <strong style={{ color: captchaPending.solving ? '#3b82f6' : '#f59e0b' }}>{captchaPending.company}</strong>
                {captchaPending.solving
                  ? ' — Agent sedang mencoba solve CAPTCHA via audio challenge secara otomatis.'
                  : ' — Auto-solve gagal. Silakan selesaikan CAPTCHA secara manual.'}
              </div>
              {!captchaPending.solving && (
                <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 6, border: '1px solid var(--border-primary)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, fontWeight: 600 }}>Cara menyelesaikan:</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                    1. Cari window <strong style={{ color: 'var(--text-primary)' }}>Chromium</strong> yang terbuka di taskbar<br/>
                    2. Klik window tersebut untuk membukanya<br/>
                    3. Selesaikan CAPTCHA yang muncul di sana<br/>
                    4. Agent akan lanjut otomatis setelah solved
                  </div>
                </div>
              )}
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 6 }}>
                {captchaPending.solving ? 'Harap tunggu...' : `Timeout dalam 3 menit · ${captchaPending.url || ''}`}
              </div>
            </div>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: captchaPending.solving ? '#3b82f6' : '#f59e0b', flexShrink: 0, marginTop: 4,
              animation: captchaPending.solving ? 'pulse 1.5s infinite' : 'none' }} />
          </div>
        </div>
      )}
      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? '#22c55e' : '#ef4444', boxShadow: connected ? '0 0 6px #22c55e' : 'none' }} />
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '0.5px' }}>
          LIVE FEED {connected ? '· CONNECTED' : '· DISCONNECTED'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-tertiary)' }}>{events.length} events</span>
      </div>

      {/* Events */}
      <div style={{ height: 320, overflowY: 'auto', padding: '8px 0' }}>
        {events.length === 0 ? (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
            {connected ? 'Menunggu aktivitas agent...' : 'Menghubungkan...'}
          </div>
        ) : (
          events.map(ev => {
            const meta = EVENT_ICON[ev.type] || { icon: '·', color: 'var(--text-tertiary)' };
            const isImportant = ['job:submitted', 'session:completed', 'job:captcha', 'job:failed'].includes(ev.type);
            return (
              <div key={ev.id} style={{
                padding: '4px 16px', display: 'flex', alignItems: 'flex-start', gap: 10,
                background: isImportant ? `${meta.color}18` : 'transparent',
                borderLeft: isImportant ? `2px solid ${meta.color}` : '2px solid transparent',
              }}>
                <span style={{ color: meta.color, fontSize: 13, minWidth: 14, lineHeight: 1.6 }}>{meta.icon}</span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', minWidth: 60, lineHeight: 1.6 }}>
                  {ev.ts ? new Date(ev.ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
                </span>
                <span style={{ fontSize: 12, color: isImportant ? 'var(--text-primary)' : 'var(--text-secondary)', lineHeight: 1.6, wordBreak: 'break-all' }}>
                  {eventToText(ev)}
                </span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Tab: Sessions ────────────────────────────────────────────────
function SessionsTab({ onSelect }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch('/api/job-agent/sessions').then(r => r.json()).catch(() => ({ sessions: [] }));
    setSessions(res.sessions || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [load]);

  const handleStart = async (id) => {
    await fetch(`/api/job-agent/sessions/${id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    load();
  };
  const handleStop = async (id) => {
    await fetch(`/api/job-agent/sessions/${id}/stop`, { method: 'POST' });
    load();
  };
  const [confirmDelete, setConfirmDelete] = useState(null); // session id to delete
  const handleDelete = async (id) => {
    await fetch(`/api/job-agent/sessions/${id}`, { method: 'DELETE' });
    setConfirmDelete(null);
    load();
  };

  if (loading) return <div style={{ padding: 40, color: 'var(--text-tertiary)', fontSize: 13 }}>Memuat...</div>;

  if (sessions.length === 0) return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
      Belum ada sesi. Buat sesi baru untuk mulai scan lowongan.
    </div>
  );

  return (
    <>
      {confirmDelete && (
        <ConfirmModal
          message="Hapus sesi ini beserta semua data job-nya? Aksi ini tidak dapat dibatalkan."
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {sessions.map(s => {
        const settings = s.settings ? JSON.parse(s.settings) : {};
        const isRunning = s.status === 'running';
        return (
          <div key={s.id} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 12, padding: 16, cursor: 'pointer' }}
            onClick={() => onSelect(s)}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{s.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{s.source_url}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <StatusBadge status={s.status} />
                {(s.status === 'idle' || s.status === 'paused') && (
                  <button onClick={e => { e.stopPropagation(); handleStart(s.id); }}
                    style={{ padding: '5px 14px', fontSize: 11, fontWeight: 700, borderRadius: 7, border: 'none', background: 'var(--brand-primary)', color: 'white', cursor: 'pointer' }}>
                    Mulai
                  </button>
                )}
                {isRunning && (
                  <button onClick={e => { e.stopPropagation(); handleStop(s.id); }}
                    style={{ padding: '5px 14px', fontSize: 11, fontWeight: 700, borderRadius: 7, border: 'none', background: '#ef4444', color: 'white', cursor: 'pointer' }}>
                    Stop
                  </button>
                )}
                <button onClick={e => { e.stopPropagation(); setConfirmDelete(s.id); }}
                  style={{ padding: '5px 10px', fontSize: 11, fontWeight: 700, borderRadius: 7, border: '1px solid #ef444466', background: 'transparent', color: '#ef4444', cursor: 'pointer' }}
                  title="Hapus sesi">
                  ✕
                </button>
              </div>
            </div>
            {/* Progress bar */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 }}>
              {[
                { label: 'Total', value: s.total, color: 'var(--text-secondary)' },
                { label: 'Terkirim', value: s.submitted, color: '#22c55e' },
                { label: 'Review', value: s.needs_review, color: '#f97316' },
                { label: 'Gagal', value: s.failed_count, color: '#ef4444' },
              ].map(stat => (
                <div key={stat.label} style={{ textAlign: 'center', padding: '8px 4px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: stat.color }}>{stat.value}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 600 }}>{stat.label}</div>
                </div>
              ))}
            </div>
            {s.total > 0 && (
              <div style={{ height: 4, background: 'var(--bg-tertiary)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.round(((s.submitted + s.skipped + s.failed_count) / s.total) * 100)}%`, background: 'var(--brand-primary)', borderRadius: 4, transition: 'width 0.6s' }} />
              </div>
            )}
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 6 }}>
              Dibuat: {fmtDate(s.created_at)} {s.started_at && `· Mulai: ${fmtDate(s.started_at)}`}
              {settings.trustedMode && <span style={{ marginLeft: 8, color: '#f59e0b', fontWeight: 600 }}>TRUSTED MODE</span>}
            </div>
          </div>
        );
      })}
    </div>
    </>
  );
}

// ── Tab: Queue ───────────────────────────────────────────────────
function QueueTab() {
  const [jobs, setJobs] = useState([]);
  const [stats, setStats] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    const url = filter === 'all' ? '/api/job-agent/queue?limit=200' : `/api/job-agent/queue?status=${filter}&limit=200`;
    const res = await fetch(url).then(r => r.json()).catch(() => ({ jobs: [], stats: [] }));
    setJobs(res.jobs || []);
    setStats(res.stats || []);
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [load]);

  const handleClearAll = async () => {
    if (!window.confirm('Hapus semua job dari queue? Aksi ini tidak dapat dibatalkan.')) return;
    setClearing(true);
    await fetch('/api/job-agent/queue', { method: 'DELETE' });
    await load();
    setClearing(false);
  };

  const totalByStatus = {};
  stats.forEach(s => { totalByStatus[s.status] = s.count; });

  const statusFilters = ['all', 'pending', 'processing', 'submitted', 'needs_review', 'skipped', 'failed'];

  return (
    <div>
      {/* Stats bar + clear button */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {statusFilters.map(s => {
          const count = s === 'all' ? jobs.length : (totalByStatus[s] || 0);
          const style = STATUS_STYLE[s] || { bg: 'var(--bg-tertiary)', color: 'var(--text-secondary)', label: s };
          return (
            <button key={s} onClick={() => setFilter(s)}
              style={{
                padding: '5px 14px', fontSize: 11, fontWeight: 700, borderRadius: 20, cursor: 'pointer',
                border: `1px solid ${filter === s ? style.color : 'var(--border-primary)'}`,
                background: filter === s ? style.bg : 'var(--bg-secondary)',
                color: filter === s ? style.color : 'var(--text-tertiary)',
              }}>
              {s === 'all' ? 'Semua' : style.label} ({count})
            </button>
          );
        })}
        </div>
        {jobs.length > 0 && (
          <button onClick={handleClearAll} disabled={clearing}
            style={{ padding: '5px 14px', fontSize: 11, fontWeight: 700, borderRadius: 20, cursor: clearing ? 'not-allowed' : 'pointer',
              border: '1px solid #ef444466', background: 'transparent', color: '#ef4444', whiteSpace: 'nowrap' }}>
            {clearing ? 'Menghapus...' : '✕ Hapus Semua Queue'}
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ padding: 40, color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center' }}>Memuat...</div>
      ) : jobs.length === 0 ? (
        <div style={{ padding: 40, color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center' }}>
          Belum ada lowongan di queue. Buat sesi baru untuk mulai scan.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Group jobs by company */}
          {Object.entries(
            jobs.reduce((acc, j) => {
              const key = j.company || 'Unknown';
              if (!acc[key]) acc[key] = [];
              acc[key].push(j);
              return acc;
            }, {})
          ).map(([company, companyJobs]) => (
            <div key={company} style={{ border: '1px solid var(--border-primary)', borderRadius: 12, overflow: 'hidden' }}>
              {/* Company header */}
              <div style={{ padding: '10px 16px', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-primary)' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{company}</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{companyJobs.length} posisi</span>
                  {companyJobs.filter(j => j.status === 'submitted').length > 0 && (
                    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44', fontWeight: 700 }}>
                      {companyJobs.filter(j => j.status === 'submitted').length} terkirim
                    </span>
                  )}
                </div>
              </div>
              {/* Positions list */}
              {companyJobs.map(j => (
                <React.Fragment key={j.id}>
                  <div onClick={() => setExpanded(expanded === j.id ? null : j.id)}
                    style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
                      borderBottom: '1px solid var(--border-primary)', background: expanded === j.id ? 'var(--bg-tertiary)' : 'transparent' }}
                    onMouseEnter={e => { if (expanded !== j.id) e.currentTarget.style.background = 'var(--hover-bg)'; }}
                    onMouseLeave={e => { if (expanded !== j.id) e.currentTarget.style.background = 'transparent'; }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.title}>
                        {j.title}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {j.link}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      {j.form_type && j.form_type !== 'unknown' && (
                        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: 'var(--bg-secondary)', color: 'var(--text-tertiary)', border: '1px solid var(--border-primary)' }}>
                          {j.form_type}
                        </span>
                      )}
                      {j.confidence && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: j.confidence >= 0.85 ? '#22c55e' : j.confidence >= 0.6 ? '#f59e0b' : '#ef4444' }}>
                          {Math.round(j.confidence * 100)}%
                        </span>
                      )}
                      <StatusBadge status={j.status} />
                      <a href={j.link} target="_blank" rel="noreferrer"
                        onClick={e => e.stopPropagation()}
                        style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, background: 'var(--brand-primary)', color: 'white', textDecoration: 'none', fontWeight: 700, flexShrink: 0 }}>
                        Apply →
                      </a>
                    </div>
                  </div>
                  {expanded === j.id && (
                    <div style={{ padding: '10px 16px', background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border-primary)' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6 }}>
                        <strong>Link:</strong> <a href={j.link} target="_blank" rel="noreferrer" style={{ color: 'var(--brand-primary)', wordBreak: 'break-all' }}>{j.link}</a>
                      </div>
                      {j.notes && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>Catatan: {j.notes}</div>}
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                        Retry: {j.retry_count} · {fmtDate(j.created_at)}
                      </div>
                      {j.cover_letter && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: 4 }}>Cover Letter</div>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 100, overflowY: 'auto', background: 'var(--bg-secondary)', padding: 8, borderRadius: 6 }}>{j.cover_letter}</div>
                        </div>
                      )}
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tab: Review Queue ────────────────────────────────────────────
function ReviewTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/job-agent/review').then(r => r.json()).catch(() => ({ items: [] }));
    setItems(res.items || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleApprove = async (id) => {
    await fetch(`/api/job-agent/review/${id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    load();
  };
  const handleReject = async (id) => {
    await fetch(`/api/job-agent/review/${id}/reject`, { method: 'POST' });
    load();
  };

  if (loading) return <div style={{ padding: 40, color: 'var(--text-tertiary)', fontSize: 13 }}>Memuat...</div>;

  if (items.length === 0) return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
      Tidak ada item yang perlu direview.
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map(item => {
        const mapping = item.field_mapping ? JSON.parse(item.field_mapping) : [];
        const lowConf = mapping.filter(f => !f.mappedValue || f.confidence < 0.85);
        return (
          <div key={item.id} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 12, overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{item.company} — {item.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{item.reason}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => handleReject(item.id)}
                  style={{ padding: '6px 14px', fontSize: 11, fontWeight: 700, borderRadius: 7, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', cursor: 'pointer' }}>
                  Tolak
                </button>
                <button onClick={() => handleApprove(item.id)}
                  style={{ padding: '6px 14px', fontSize: 11, fontWeight: 700, borderRadius: 7, border: 'none', background: '#22c55e', color: 'white', cursor: 'pointer' }}>
                  Setujui
                </button>
              </div>
            </div>

            {/* Field mapping */}
            <div style={{ padding: '12px 16px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: 10 }}>
                Field Mapping ({mapping.length} field, {lowConf.length} perlu perhatian)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
                {mapping.map((f, i) => (
                  <div key={i} style={{
                    padding: '8px 10px', borderRadius: 8,
                    border: `1px solid ${f.mappedValue && f.confidence >= 0.85 ? 'var(--border-secondary)' : '#f97316'}`,
                    background: f.mappedValue && f.confidence >= 0.85 ? 'var(--bg-tertiary)' : '#f9731608',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 2 }}>{f.label}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: f.mappedValue ? 'var(--text-primary)' : '#ef4444' }}>
                      {f.mappedValue || (f.needsManual ? '⚠ Perlu isi manual' : '— Tidak ditemukan')}
                    </div>
                    {f.confidence > 0 && (
                      <div style={{ fontSize: 9, color: f.confidence >= 0.85 ? '#22c55e' : '#f97316', marginTop: 2 }}>
                        Confidence: {Math.round(f.confidence * 100)}%
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <a href={item.link} target="_blank" rel="noreferrer"
                style={{ display: 'inline-block', marginTop: 10, fontSize: 11, color: 'var(--brand-primary)' }}>
                Lihat halaman lowongan →
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────
export default function JobAgent() {
  const [tab, setTab] = useState('sessions');
  const [liveSessionId, setLiveSessionId] = useState(null);

  const tabs = [
    { id: 'sessions', label: 'Sesi Scan' },
    { id: 'queue', label: 'Queue' },
    { id: 'review', label: 'Review' },
    { id: 'new', label: '+ Sesi Baru' },
  ];

  return (
    <DashboardLayout>
      <div style={{ padding: '24px 20px', maxWidth: 1200, margin: '0 auto', width: '100%' }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
            Job Application Agent
          </h1>
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 4 }}>
            Otomatisasi scan lowongan dan pengisian form lamaran kerja
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg-secondary)', borderRadius: 10, padding: 4, border: '1px solid var(--border-primary)', marginBottom: 24, width: 'fit-content' }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{
                padding: '7px 18px', fontSize: 12, fontWeight: 700, borderRadius: 7, border: 'none', cursor: 'pointer',
                background: tab === t.id ? 'var(--brand-primary)' : 'transparent',
                color: tab === t.id ? 'white' : 'var(--text-secondary)',
                transition: 'all 0.15s',
              }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Live Feed — tampil saat ada session aktif */}
        {liveSessionId && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                Live Monitor — Sesi #{liveSessionId}
              </div>
              <button onClick={() => setLiveSessionId(null)}
                style={{ fontSize: 11, color: 'var(--text-tertiary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 8px' }}>
                Tutup
              </button>
            </div>
            <LiveFeed sessionId={liveSessionId} />
          </div>
        )}

        {/* Content */}
        {tab === 'sessions' && <SessionsTab onSelect={(s) => { setLiveSessionId(String(s.id)); }} onLive={(id) => setLiveSessionId(String(id))} />}
        {tab === 'queue' && <QueueTab />}
        {tab === 'review' && <ReviewTab />}
        {tab === 'new' && <NewSessionTab onCreated={(s) => { setLiveSessionId(String(s.id)); setTab('sessions'); }} />}
      </div>
    </DashboardLayout>
  );
}
