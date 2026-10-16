/**
 * Pusat Agen — everything the agent does on its own, in one place: a live activity feed (what it
 * did and why), the career radar (remote jobs it found, scored against the owner's real profile),
 * and the pipeline each posting moves through. It reads and reports; it never submits anything
 * on the owner's behalf from this screen.
 *
 * by Wisnu Alfian Nur Ashar
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import DashboardLayout from './DashboardLayout';
import { getAutomationToken } from '../lib/stream.js';
import './automation.css';
import './agent-center.css';

const TOKEN_KEY = 'automationToken';
const TZ = 'Asia/Jakarta';
const POLL_MS = 4000;

async function api(path, { method = 'GET', body } = {}, retried = false) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const t = getAutomationToken();
  if (t) headers['X-Automation-Token'] = t;
  const res = await fetch(`/api/career${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && !retried) {
    const entered = window.prompt('Masukkan token otomasi (AUTOMATION_TOKEN di .env server):');
    if (entered) {
      try { localStorage.setItem(TOKEN_KEY, entered.trim()); } catch { /* private mode */ }
      return api(path, { method, body }, true);
    }
  }
  if (!res.ok) throw new Error(data.error || data.message || `Permintaan gagal (HTTP ${res.status})`);
  return data;
}

const STATUS_LABEL = {
  new: 'Baru', shortlisted: 'Dipilih', applying: 'Sedang dilamar', applied: 'Sudah dilamar',
  interview: 'Wawancara', offer: 'Penawaran', rejected: 'Ditolak', skipped: 'Dilewati',
};
const VERDICT_LABEL = { apply: 'Layak dilamar', maybe: 'Perlu dicek', skip: 'Dilewati' };
const AGENT_LABEL = { career: 'Karir', market: 'Pasar', email: 'Email', system: 'Sistem' };

function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'baru saja';
  if (s < 3600) return `${Math.round(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86400)} hari lalu`;
}
const clock = (ts) => new Date(ts).toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

function Stat({ label, value, hint, tone }) {
  return (
    <div className={`ag-stat ${tone || ''}`}>
      <span className="ag-stat-v">{value}</span>
      <span className="ag-stat-l">{label}</span>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function Feed({ items }) {
  if (!items.length) return <p className="ag-empty">Belum ada aktivitas. Tekan "Pindai sekarang" atau tunggu pemindaian terjadwal.</p>;
  return (
    <ol className="ag-feed" aria-live="polite">
      {items.map((a) => (
        <li key={a.id} className={`ag-item lv-${a.level}`}>
          <span className="ag-dot" aria-hidden="true" />
          <div className="ag-body">
            <div className="ag-head">
              <strong>{a.title}</strong>
              <span className="ag-tag">{AGENT_LABEL[a.agent] || a.agent}</span>
            </div>
            {a.detail ? <pre className="ag-detail">{a.detail}</pre> : null}
          </div>
          <time title={new Date(a.ts).toLocaleString('id-ID', { timeZone: TZ })}>{clock(a.ts)}</time>
        </li>
      ))}
    </ol>
  );
}

function JobCard({ job, onStatus, busy }) {
  const [open, setOpen] = useState(false);
  return (
    <article className={`ag-job v-${job.verdict}`}>
      <div className="ag-score" title="Skor kecocokan 0–100"><b>{job.score}</b><small>cocok</small></div>
      <div className="ag-job-main">
        <h3>
          <a href={job.url} target="_blank" rel="noopener noreferrer">{job.title}</a>
        </h3>
        <p className="ag-meta">
          {[job.company, job.location, job.salary_text].filter(Boolean).join(' · ') || 'Detail tidak tersedia'}
          <span className="ag-src">{job.source.split(':')[0]}</span>
        </p>
        <div className="ag-chips">
          <span className={`ag-badge v-${job.verdict}`}>{VERDICT_LABEL[job.verdict]}</span>
          {job.reasons.slice(0, open ? 12 : 3).map((r) => <span key={r} className="ag-chip good">{r}</span>)}
          {job.warnings.slice(0, open ? 12 : 2).map((w) => <span key={w} className="ag-chip warn">{w}</span>)}
          {(job.reasons.length > 3 || job.warnings.length > 2) && (
            <button type="button" className="ag-more" onClick={() => setOpen((v) => !v)}>{open ? 'ringkas' : 'semua alasan'}</button>
          )}
        </div>
      </div>
      <label className="ag-status">
        <span>Status</span>
        <select value={job.status} disabled={busy} onChange={(e) => onStatus(job.id, e.target.value)}>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
    </article>
  );
}

export default function AgentCenter() {
  const [tab, setTab] = useState('feed');
  const [status, setStatus] = useState(null);
  const [feed, setFeed] = useState([]);
  const [jobs, setJobs] = useState({ total: 0, jobs: [] });
  const [verdict, setVerdict] = useState('apply');
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const lastId = useRef(0);
  const alive = useRef(true);

  const loadStatus = useCallback(async () => {
    try { setStatus(await api('/status')); setError(''); } catch (e) { setError(e.message); }
  }, []);

  const pollFeed = useCallback(async (first = false) => {
    try {
      const { items } = await api(`/activity?afterId=${first ? 0 : lastId.current}&limit=${first ? 80 : 40}`);
      if (!alive.current || !items.length) return;
      lastId.current = Math.max(lastId.current, ...items.map((i) => i.id));
      setFeed((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...items.filter((i) => !seen.has(i.id)), ...prev].slice(0, 200);
      });
    } catch (e) { setError(e.message); }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '60' });
      if (verdict) params.set('verdict', verdict);
      if (q.trim()) params.set('q', q.trim());
      setJobs(await api(`/jobs?${params}`));
    } catch (e) { setError(e.message); }
  }, [verdict, q]);

  useEffect(() => {
    alive.current = true;
    loadStatus(); pollFeed(true);
    const t = setInterval(() => {
      if (document.hidden) return;
      pollFeed(); loadStatus();
    }, POLL_MS);
    return () => { alive.current = false; clearInterval(t); };
  }, [loadStatus, pollFeed]);

  useEffect(() => {
    if (tab !== 'jobs') return undefined;
    const t = setTimeout(loadJobs, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [tab, loadJobs, q]);

  const scan = async () => {
    setBusy('scan');
    try {
      const r = await api('/scan', { method: 'POST', body: {} });
      if (!r.started) setError(r.message || 'Pemindaian sedang berjalan.');
      await pollFeed(); await loadStatus();
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const changeStatus = async (id, next) => {
    setBusy(`job${id}`);
    try {
      await api(`/jobs/${id}/status`, { method: 'POST', body: { status: next } });
      await Promise.all([loadJobs(), loadStatus(), pollFeed()]);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const by = status?.byStatus || {};
  return (
    <DashboardLayout>
      <div className="au-page ag-page">
        <header className="au-hero">
          <div>
            <h1>Pusat Agen</h1>
            <p className="au-sub">Apa yang dikerjakan agent Anda: dipantau langsung, dengan alasannya.</p>
          </div>
          <div className="ag-actions">
            <span className={`ag-live ${status?.running ? 'on' : ''}`}>
              <i aria-hidden="true" />{status?.running ? 'Sedang memindai…' : (status?.enabled === false ? 'Radar mati' : 'Radar aktif')}
            </span>
            <button type="button" className="ag-btn" onClick={scan} disabled={busy === 'scan' || status?.running}>
              {status?.running ? 'Memindai…' : 'Pindai sekarang'}
            </button>
          </div>
        </header>

        {error ? <div className="ag-error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Tutup">×</button></div> : null}

        <section className="ag-stats" aria-label="Ringkasan">
          <Stat label="Layak dilamar" value={status?.apply ?? '—'} tone="good" hint="belum diproses" />
          <Stat label="Perlu dicek" value={status?.maybe ?? '—'} tone="warn" />
          <Stat label="Baru 24 jam" value={status?.newToday ?? '—'} />
          <Stat label="Terpantau" value={status?.total ?? '—'} hint={status?.lastScan ? `dipindai ${ago(status.lastScan)}` : 'belum pernah'} />
          <Stat label="Sudah dilamar" value={by.applied || 0} />
          <Stat label="Wawancara / penawaran" value={(by.interview || 0) + (by.offer || 0)} tone="good" />
        </section>

        <div className="ag-tabs" role="tablist">
          {[['feed', 'Aktivitas'], ['jobs', 'Lowongan'], ['about', 'Cara kerja & batas']].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>

        {tab === 'feed' && <section className="au-card"><Feed items={feed} /></section>}

        {tab === 'jobs' && (
          <section>
            <div className="ag-filters">
              {[['apply', 'Layak dilamar'], ['maybe', 'Perlu dicek'], ['skip', 'Dilewati'], ['', 'Semua']].map(([k, label]) => (
                <button key={k || 'all'} type="button" className={verdict === k ? 'on' : ''} onClick={() => setVerdict(k)}>{label}</button>
              ))}
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari judul / perusahaan" aria-label="Cari lowongan" />
            </div>
            <p className="ag-count">{jobs.total} lowongan{verdict ? ` · ${VERDICT_LABEL[verdict].toLowerCase()}` : ''}</p>
            {jobs.jobs.length === 0
              ? <p className="ag-empty">Tidak ada lowongan di filter ini. Radar memindai tiap beberapa jam; lowongan junior remote yang terbuka untuk Indonesia memang tidak banyak.</p>
              : jobs.jobs.map((j) => <JobCard key={j.id} job={j} busy={busy === `job${j.id}`} onStatus={changeStatus} />)}
          </section>
        )}

        {tab === 'about' && (
          <section className="au-card ag-about">
            <h3>Yang dikerjakan agent sendiri</h3>
            <ul>
              <li>Membaca lowongan remote dari sumber resmi (API/RSS) tiap {status?.intervalHours || 6} jam.</li>
              <li>Menilai tiap lowongan terhadap profil Anda dengan aturan tertulis (bukan tebakan AI), lengkap dengan alasannya.</li>
              <li>Mengirim ke Telegram hanya yang layak dilamar, di luar jam tenang 22.00–06.00 WIB.</li>
              <li>Mencatat semua langkahnya di tab Aktivitas.</li>
            </ul>
            <h3>Batas yang sengaja dipasang</h3>
            <ul>
              <li>Tidak mengarang pengalaman, gelar, atau keahlian: hanya fakta dari profil Anda.</li>
              <li>Tidak melewati CAPTCHA dan tidak mengotomatisasi situs yang melarangnya (mis. LinkedIn, Indeed).</li>
              <li>Tidak mengirim lamaran dari layar ini. Tahap lamaran otomatis dibangun terpisah dengan bukti (tangkapan layar) dan pemeriksaan ganda.</li>
            </ul>
            <p className="ag-note">Perintah Telegram: <code>lowongan baru</code>, <code>pindai lowongan sekarang</code>, <code>status lamaran</code>.</p>
          </section>
        )}
      </div>
    </DashboardLayout>
  );
}
