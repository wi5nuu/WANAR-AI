/**
 * Automation — jadwal otomatis, email massal, dan penulisan dengan AI.
 * by Wisnu Alfian Nur Ashar
 *
 * Satu halaman, lima tab:
 *   Ringkasan · Jadwal · Email Massal · Tulis dengan AI · Pengaturan
 *
 * Realtime: satu koneksi SSE (/api/automation/events) menggerakkan progres
 * kampanye, status job, dan peringatan tanpa polling.
 *
 * Prinsip keselamatan yang terlihat di UI:
 *   - tidak ada email keluar sebelum Anda menekan "Setujui & Kirim"
 *   - job usulan agen berstatus "Menunggu persetujuan" sampai Anda setujui
 *   - hasil AI masuk sebagai draf untuk di-review, kecuali Anda memilih kirim otomatis
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { openStream } from '../lib/stream.js';
import DashboardLayout from './DashboardLayout';
import './automation.css';

// ------------------------------------------------------------------ helpers

const TOKEN_KEY = 'automationToken';

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

async function api(path, { method = 'GET', body } = {}, retried = false) {
  const token = getToken();
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Automation-Token'] = token;

  const res = await fetch(`/api/automation${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }

  // Remote access (not localhost) needs AUTOMATION_TOKEN: ask once, then retry.
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

const TZ = 'Asia/Jakarta';

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function uploadAttachment(file) {
  const fd = new FormData();
  fd.append('file', file);
  const token = getToken();
  const res = await fetch('/api/automation/attachments', {
    method: 'POST',
    headers: token ? { 'X-Automation-Token': token } : undefined,
    body: fd,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || data.success === false) throw new Error(data.error || `Unggahan gagal (HTTP ${res.status})`);
  return data.attachment;
}

function fmtDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('id-ID', {
    timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function fromNow(ms) {
  if (!ms) return '';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  let label;
  if (abs < 45_000) return diff >= 0 ? 'sebentar lagi' : 'baru saja';
  if (m < 60) label = `${m} menit`;
  else if (m < 60 * 36) label = `${Math.round(m / 60)} jam`;
  else label = `${Math.round(m / 1440)} hari`;
  return diff >= 0 ? `dalam ${label}` : `${label} lalu`;
}

const JOB_STATUS = {
  active: ['ok', 'Aktif'],
  pending_approval: ['warn', 'Menunggu persetujuan'],
  paused: ['info', 'Dijeda'],
  completed: ['', 'Selesai'],
};
const CAMPAIGN_STATUS = {
  draft: ['', 'Draf'],
  running: ['brand', 'Berjalan'],
  paused: ['warn', 'Dijeda'],
  completed: ['ok', 'Selesai'],
  cancelled: ['err', 'Dibatalkan'],
};
const PAUSE_REASON = {
  daily_cap: 'batas kirim harian tercapai — lanjut otomatis besok',
  quota: 'kuota penyedia SMTP habis — lanjut otomatis besok',
  auth: 'kredensial kanal ditolak — periksa token/password di .env',
  config: 'konfigurasi kanal bermasalah (template/webhook) — periksa pengaturan lalu lanjutkan',
  manual: 'dijeda manual',
  attachment_missing: 'file lampiran hilang dari server — unggah ulang lalu buat kampanye baru',
};
const TYPE_LABEL = {
  email: 'Pesan tetap',
  ai_email: 'Pesan ditulis AI',
  ai_task: 'Tugas AI',
};
const OUTBOX_CHIP = { sent: 'ok', failed: 'err', skipped: 'warn', queued: '', sending: 'brand' };

const CHANNELS = ['email', 'telegram', 'whatsapp', 'slack', 'discord', 'teams', 'webhook'];
const CHANNEL_LABEL = {
  email: 'Email', telegram: 'Telegram', whatsapp: 'WhatsApp', slack: 'Slack', discord: 'Discord', teams: 'Teams', webhook: 'Webhook',
};
const FIXED_DEST = new Set(['slack', 'discord', 'teams', 'webhook']);
const RECIPIENT_PLACEHOLDER = {
  email: 'Satu email per baris, atau CSV dengan header:\nnama,email,perusahaan\nBudi,budi@contoh.com,PT Maju',
  telegram: 'Satu chat ID per baris, atau CSV dengan header:\nnama,chat_id\nBudi,123456789\n\nKetik @subscribers untuk semua pelanggan yang mendaftar lewat /start',
  whatsapp: 'Satu nomor per baris (0812… atau 62812…), atau CSV dengan header:\nnama,telepon\nBudi,0812-3456-7890',
};
const ENV_GUIDE = {
  telegram: 'TELEGRAM_BOT_TOKEN=123456789:ABC-token-dari-BotFather\n# opsional\nTELEGRAM_POLLING=true        # pelanggan mendaftar lewat /start\nTELEGRAM_JOIN_CODE=kode-rahasia  # /start kode-rahasia\nTELEGRAM_ALLOWED_CHAT_IDS=111,222',
  whatsapp: 'WHATSAPP_TOKEN=token-permanen-system-user\nWHATSAPP_PHONE_NUMBER_ID=1234567890\nWHATSAPP_TEMPLATE_NAME=pengumuman   # wajib untuk pelanggan baru\nWHATSAPP_TEMPLATE_LANG=id\nWHATSAPP_DAILY_CAP=250',
  slack: 'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/XXXX',
  discord: 'DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/ID/TOKEN',
  teams: 'TEAMS_WEBHOOK_URL=https://prod-00.westus.logic.azure.com/workflows/...',
  webhook: 'WEBHOOK_URL=https://n8n.perusahaan.id/webhook/abc\nWEBHOOK_SECRET=rahasia-hmac\nWEBHOOK_BEARER_TOKEN=opsional',
};

const SCHEDULE_PRESETS = [
  ['Setiap hari 08:00', 'daily@08:00'],
  ['Hari kerja 09:00', 'weekdays@09:00'],
  ['Senin 08:00', 'weekly:senin@08:00'],
  ['Tgl 1 tiap bulan', 'monthly:1@08:00'],
  ['Tiap 30 menit', 'every 30m'],
];

function Chip({ kind = '', children }) {
  return <span className={`au-chip ${kind}`}>{children}</span>;
}

function statusChip(map, key) {
  const [kind, label] = map[key] || ['', key];
  return <Chip kind={kind}>{label}</Chip>;
}

function useDebounced(value, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Confirm({ open, title, children, confirmLabel = 'Lanjutkan', danger, busy, onConfirm, onCancel }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="au-modal-bg" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="au-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="au-muted" style={{ marginBottom: '1rem' }}>{children}</div>
        <div className="au-row" style={{ justifyContent: 'flex-end' }}>
          <button className="au-btn" onClick={onCancel} disabled={busy}>Batal</button>
          <button className={`au-btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>
            {busy && <span className="au-spin" />} {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ overview, jobs, campaigns, feed, onGoto }) {
  if (!overview) return <div className="au-empty">Memuat ringkasan…</div>;
  const { mailer, usage, counts, upcoming, channels = [] } = overview;
  const usedPct = Math.min(100, Math.round((usage.sentToday / usage.dailyCap) * 100));
  const reviews = campaigns.filter((c) => c.status === 'draft' && c.created_by === 'scheduler');
  const pending = jobs.filter((j) => j.status === 'pending_approval');

  return (
    <>
      {mailer.mode !== 'live' && (
        <div className="au-alert warn">
          <b>Mode simulasi.</b> SMTP belum dikonfigurasi, jadi email <b>tidak benar-benar terkirim</b> — semuanya hanya
          disimulasikan. Kekurangan: {mailer.missing.join(', ') || '—'}. Buka tab <b>Pengaturan</b> untuk panduan.
        </div>
      )}

      {pending.length > 0 && (
        <div className="au-alert info">
          <b>{pending.length} job menunggu persetujuan Anda</b> — belum akan berjalan sampai disetujui.{' '}
          <button className="au-btn sm" onClick={() => onGoto('jobs')}>Tinjau</button>
        </div>
      )}

      <div className="au-grid cols-4">
        <div className="au-card au-stat">
          <div className="k">Mode email</div>
          <div className="v">{mailer.mode === 'live' ? 'Live' : 'Simulasi'}</div>
          <div className="s">{mailer.from || 'MAIL_FROM belum diatur'}</div>
        </div>
        <div className="au-card au-stat">
          <div className="k">Terkirim hari ini</div>
          <div className="v">{usage.sentToday}<span className="au-muted" style={{ fontSize: '1rem' }}> / {usage.dailyCap}</span></div>
          <div className={`au-progress ${usedPct >= 100 ? 'paused' : ''}`}><i style={{ width: `${usedPct}%` }} /></div>
        </div>
        <div className="au-card au-stat">
          <div className="k">Job aktif</div>
          <div className="v">{counts.jobsActive}</div>
          <div className="s">{counts.jobsPending} menunggu · {counts.jobsPaused} dijeda</div>
        </div>
        <div className="au-card au-stat">
          <div className="k">Kampanye</div>
          <div className="v">{counts.campaignsRunning}</div>
          <div className="s">berjalan · {counts.campaignsDraft} draf · {counts.suppressed} di-suppress</div>
        </div>
      </div>

      <div className="au-card" style={{ marginTop: '1rem' }}>
        <h3>Kanal pengiriman <small>{channels.filter((c) => c.mode === 'live').length} dari {channels.length} aktif</small></h3>
        <div className="au-chan-grid">
          {channels.map((c) => (
            <div key={c.id} className={`au-chan-card ${c.mode === 'live' ? 'live' : ''}`}>
              <div className="au-row between">
                <b>{CHANNEL_LABEL[c.id] || c.label}</b>
                <Chip kind={c.mode === 'live' ? 'ok' : 'warn'}>{c.mode === 'live' ? 'Live' : 'Simulasi'}</Chip>
              </div>
              <div className="au-tiny">hari ini {c.sentToday || 0} / {c.limits?.dailyCap ?? '—'}</div>
              {c.mode !== 'live' && c.missing?.length > 0 && <div className="au-tiny">kurang: {c.missing.join(', ')}</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="au-grid cols-2" style={{ marginTop: '1rem' }}>
        <div className="au-card">
          <h3>Jadwal berikutnya <small>WIB</small></h3>
          {upcoming.length === 0 ? (
            <div className="au-empty"><b>Belum ada jadwal aktif</b>Buat job di tab Jadwal.</div>
          ) : (
            <div className="au-list">
              {upcoming.map((u) => (
                <div key={u.id} className="au-item">
                  <div>
                    <div className="t">{u.name} <Chip kind="info">{TYPE_LABEL[u.type] || u.type}</Chip></div>
                    <div className="m">{fmtDateTime(u.nextRunAt)} · {fromNow(u.nextRunAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="au-card">
          <h3>Perlu review {reviews.length > 0 && <Chip kind="warn">{reviews.length}</Chip>}</h3>
          {reviews.length === 0 ? (
            <div className="au-empty"><b>Tidak ada draf menunggu</b>Email buatan AI dari job terjadwal akan muncul di sini.</div>
          ) : (
            <div className="au-list">
              {reviews.slice(0, 5).map((c) => (
                <div key={c.id} className="au-item">
                  <div>
                    <div className="t">{c.name}</div>
                    <div className="m">{c.subject} · {c.stats.total} penerima</div>
                  </div>
                  <div className="au-actions">
                    <button className="au-btn sm primary" onClick={() => onGoto('campaigns', c.id)}>Review</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="au-card" style={{ marginTop: '1rem' }}>
        <h3>Aktivitas realtime</h3>
        {feed.length === 0 ? (
          <div className="au-muted">Menunggu aktivitas… peristiwa baru akan muncul di sini secara langsung.</div>
        ) : (
          <div className="au-feed">
            {feed.map((e) => (
              <div className="ev" key={e.key}>
                <time>{new Date(e.at).toLocaleTimeString('id-ID', { timeZone: TZ })}</time>
                <span>{e.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------- attachments

function AttachmentPicker({ value, onChange, notify, limits }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const maxFiles = limits?.maxFiles ?? 5;
  const maxMb = limits ? Math.round(limits.maxFileBytes / 1048576) : 10;
  const total = value.reduce((n, a) => n + a.size, 0);

  const onPick = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    if (value.length + files.length > maxFiles) {
      notify('err', `Maksimal ${maxFiles} lampiran per email.`);
      return;
    }
    setBusy(true);
    const added = [];
    for (const file of files) {
      try {
        added.push(await uploadAttachment(file));
      } catch (err) {
        notify('err', `${file.name}: ${err.message}`);
      }
    }
    if (added.length) onChange([...value, ...added]);
    setBusy(false);
  };

  const remove = async (att) => {
    onChange(value.filter((a) => a.id !== att.id));
    try { await api(`/attachments/${att.id}`, { method: 'DELETE' }); } catch { /* still referenced elsewhere */ }
  };

  return (
    <div className="au-field">
      <div className="au-row between">
        <label>Lampiran <span className="au-tiny">(opsional · maks {maxFiles} file, {maxMb} MB per file)</span></label>
        <button type="button" className="au-btn sm" disabled={busy || value.length >= maxFiles} onClick={() => inputRef.current?.click()}>
          {busy && <span className="au-spin" />} Tambah file
        </button>
        <input ref={inputRef} type="file" multiple hidden onChange={onPick} />
      </div>
      {value.length > 0 ? (
        <div className="au-chips-row">
          {value.map((a) => (
            <span key={a.id} className="au-chip brand" title={a.contentType}>
              {a.filename} · {fmtSize(a.size)}
              <button type="button" aria-label={`Hapus ${a.filename}`} onClick={() => remove(a)}
                style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0, fontWeight: 800 }}>×</button>
            </span>
          ))}
          <span className="au-tiny">total {fmtSize(total)}</span>
        </div>
      ) : (
        <div className="au-tiny">Dikirim bersama setiap email. File .exe, .bat, .js dan sejenisnya ditolak.</div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- jobs

function SchedulePicker({ value, onChange, timezone }) {
  const debounced = useDebounced(value);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!debounced.trim()) { setInfo(null); setError(''); return undefined; }
    api('/schedule/preview', { method: 'POST', body: { schedule: debounced, timezone } })
      .then((d) => { if (!cancelled) { setInfo(d); setError(''); } })
      .catch((e) => { if (!cancelled) { setInfo(null); setError(e.message); } });
    return () => { cancelled = true; };
  }, [debounced, timezone]);

  return (
    <div className="au-field">
      <label>Jadwal</label>
      <input
        className="au-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder='mis. daily@08:00, weekdays@09:00, every 30m, atau cron "0 8 * * 1-5"'
        spellCheck={false}
      />
      <div className="au-chips-row">
        {SCHEDULE_PRESETS.map(([label, expr]) => (
          <button type="button" key={expr} className="au-chipbtn" onClick={() => onChange(expr)}>{label}</button>
        ))}
      </div>
      {error && <div className="au-tiny" style={{ color: 'var(--error)' }}>{error}</div>}
      {info && (
        <div className="au-tiny">
          <b style={{ color: 'var(--success)' }}>{info.description}</b>
          {' · '}berikutnya: {info.next.slice(0, 3).map(fmtDateTime).join(' → ')}
        </div>
      )}
    </div>
  );
}

function RecipientsField({ value, onChange, label = 'Penerima', hint, channel = 'email' }) {
  const debounced = useDebounced(value, 400);
  const [info, setInfo] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    if (!debounced.trim()) { setInfo(null); return undefined; }
    api('/recipients/parse', { method: 'POST', body: { text: debounced, channel } })
      .then((d) => { if (!cancelled) setInfo(d); })
      .catch(() => { if (!cancelled) setInfo(null); });
    return () => { cancelled = true; };
  }, [debounced, channel]);

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { alert('File terlalu besar (maks 2 MB).'); return; }
    const r = new FileReader();
    r.onload = () => onChange(String(r.result || ''));
    r.readAsText(f);
    e.target.value = '';
  };

  return (
    <div className="au-field">
      <div className="au-row between">
        <label>{label}</label>
        <button type="button" className="au-btn sm" onClick={() => fileRef.current?.click()}>Unggah CSV</button>
        <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={onFile} />
      </div>
      <textarea
        className="au-textarea mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={RECIPIENT_PLACEHOLDER[channel] || RECIPIENT_PLACEHOLDER.email}
        spellCheck={false}
      />
      {channel === 'telegram' && !/^[ \t]*@subscribers/im.test(value) && (
        <div className="au-chips-row">
          <button type="button" className="au-chipbtn" onClick={() => onChange(`@subscribers${value ? '\n' + value : ''}`)}>
            + semua pelanggan (@subscribers)
          </button>
        </div>
      )}
      {hint && <div className="au-tiny">{hint}</div>}
      {info && (
        <div className="au-row" style={{ gap: '0.4rem' }}>
          <Chip kind="ok">{info.valid} valid</Chip>
          {info.invalidCount > 0 && <Chip kind="err">{info.invalidCount} tidak valid</Chip>}
          {info.duplicateCount > 0 && <Chip kind="warn">{info.duplicateCount} duplikat</Chip>}
          {info.suppressed.length > 0 && <Chip kind="warn">{info.suppressed.length} di-suppress</Chip>}
          {info.overLimit && <Chip kind="err">melebihi batas {info.maxRecipients}</Chip>}
          {info.columns.map((c) => <Chip key={c} kind="info">{`{{${c}}}`}</Chip>)}
        </div>
      )}
    </div>
  );
}

/** Pick one or more delivery channels, each with its own recipient list. */
function ChannelTargets({ channels, picked, onPick, recipients, onRecipients, label }) {
  const info = (id) => (channels || []).find((c) => c.id === id);
  return (
    <div className="au-field">
      <label>{label}</label>
      <div className="au-chips-row" role="group" aria-label="Kanal tujuan">
        {CHANNELS.map((id) => (
          <button
            type="button" key={id} aria-pressed={Boolean(picked[id])}
            className={`au-chan ${picked[id] ? 'active' : ''}`}
            onClick={() => onPick(id, !picked[id])}
          >
            {CHANNEL_LABEL[id]}
            {info(id) && <i className={`au-dot-s ${info(id).mode === 'live' ? 'on' : ''}`} title={info(id).mode === 'live' ? 'Live' : 'Simulasi'} />}
          </button>
        ))}
      </div>
      {CHANNELS.filter((id) => picked[id]).map((id) => (
        FIXED_DEST.has(id) ? (
          <div key={id} className="au-tiny">{CHANNEL_LABEL[id]}: tujuan tetap dari .env — tidak perlu daftar penerima.</div>
        ) : (
          <RecipientsField
            key={id} channel={id}
            label={`Penerima ${CHANNEL_LABEL[id]}`}
            value={recipients[id] || ''}
            onChange={(v) => onRecipients(id, v)}
          />
        )
      ))}
      {!Object.values(picked).some(Boolean) && <div className="au-tiny">Pilih minimal satu kanal.</div>}
    </div>
  );
}

function JobForm({ onCreated, notify, onCancel, limits, channels }) {
  const [type, setType] = useState('email');
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('daily@08:00');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [brief, setBrief] = useState('');
  const [tone, setTone] = useState('profesional dan ramah');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState('text');
  const [picked, setPicked] = useState({ email: true });
  const [recipientsBy, setRecipientsBy] = useState({});
  const [autoSend, setAutoSend] = useState(false);
  const [activate, setActivate] = useState(true);
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const targets = CHANNELS.filter((id) => picked[id]).map((id) => ({
        channel: id,
        recipients: FIXED_DEST.has(id) ? undefined : (recipientsBy[id] || ''),
      }));
      if (type !== 'ai_task' && targets.length === 0) throw new Error('Pilih minimal satu kanal tujuan.');
      let payload;
      if (type === 'email') payload = { subject, bodyText: body, targets };
      else if (type === 'ai_email') payload = { brief, tone, targets, autoSend };
      else payload = { prompt, kind, subject: subject || undefined, targets: targets.length ? targets : undefined, autoSend };
      payload.attachmentIds = attachments.map((a) => a.id);
      const d = await api('/jobs', {
        method: 'POST',
        body: { name, type, schedule, payload, activate },
      });
      notify('ok', activate ? 'Job dibuat dan diaktifkan.' : 'Job dibuat — menunggu persetujuan.');
      onCreated(d.job);
    } catch (err) {
      notify('err', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="au-card" onSubmit={submit} style={{ marginBottom: '1rem' }}>
      <h3>Job otomasi baru</h3>
      <div className="au-split">
        <div className="au-field">
          <label>Nama job</label>
          <input className="au-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="mis. Laporan harian ke tim" required />
        </div>
        <div className="au-field">
          <label>Tipe</label>
          <select className="au-select" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="email">Pesan tetap (template) ke satu atau banyak kanal</option>
            <option value="ai_email">Pesan ditulis AI dari brief, tiap kali jalan</option>
            <option value="ai_task">Tugas AI (ringkasan / kode), opsional dikirim ke kanal</option>
          </select>
        </div>
      </div>

      <SchedulePicker value={schedule} onChange={setSchedule} />

      {type === 'email' && (
        <>
          <div className="au-field">
            <label>Subjek</label>
            <input className="au-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Laporan {{tanggal}}" required={Boolean(picked.email)} />
          </div>
          <div className="au-field">
            <label>Isi email</label>
            <textarea className="au-textarea" value={body} onChange={(e) => setBody(e.target.value)}
              placeholder={'Yth. {{nama|Bapak/Ibu}},\n\nBerikut laporan hari {{hari}}, {{tanggal}}.\n\nSalam,\nWisnu'} required />
            <div className="au-tiny">Variabel: {'{{nama}}'} {'{{tanggal}}'} {'{{hari}}'} {'{{jam}}'} — fallback dengan {'{{nama|Bapak/Ibu}}'}.</div>
          </div>
        </>
      )}

      {type === 'ai_email' && (
        <>
          <div className="au-field">
            <label>Brief untuk AI</label>
            <textarea className="au-textarea" value={brief} onChange={(e) => setBrief(e.target.value)}
              placeholder="mis. Pengingat sopan bahwa laporan mingguan harus dikumpulkan sebelum Jumat pukul 15.00." required />
          </div>
          <div className="au-field">
            <label>Nada</label>
            <input className="au-input" value={tone} onChange={(e) => setTone(e.target.value)} />
          </div>
        </>
      )}

      {type === 'ai_task' && (
        <>
          <div className="au-split">
            <div className="au-field">
              <label>Jenis keluaran</label>
              <select className="au-select" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="text">Teks / ringkasan</option>
                <option value="code">Kode</option>
              </select>
            </div>
            <div className="au-field">
              <label>Subjek email (jika dikirim)</label>
              <input className="au-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Ringkasan {{tanggal}}" />
            </div>
          </div>
          <div className="au-field">
            <label>Prompt</label>
            <textarea className="au-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)}
              placeholder="mis. Buat daftar prioritas kerja hari ini untuk tim IT berdasarkan hari dan tanggal." required />
          </div>
        </>
      )}

      <ChannelTargets
        channels={channels}
        picked={picked}
        onPick={(id, on) => setPicked((p) => ({ ...p, [id]: on }))}
        recipients={recipientsBy}
        onRecipients={(id, v) => setRecipientsBy((r) => ({ ...r, [id]: v }))}
        label={type === 'ai_task' ? 'Kirim hasil ke (opsional)' : 'Kirim ke kanal'}
      />

      <AttachmentPicker value={attachments} onChange={setAttachments} notify={notify} limits={limits} />

      {type !== 'email' && (
        <label className="au-check" style={{ marginBottom: '0.6rem' }}>
          <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />
          <span>
            <b>Kirim otomatis tanpa review.</b>{' '}
            <span className="au-muted">
              Bila dimatikan (disarankan), hasil AI masuk sebagai <b>draf</b> yang Anda setujui dulu. AI bisa keliru —
              nyalakan hanya untuk isi yang risikonya rendah.
            </span>
          </span>
        </label>
      )}

      <label className="au-check" style={{ marginBottom: '1rem' }}>
        <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
        <span><b>Setujui & aktifkan sekarang.</b> <span className="au-muted">Jika dimatikan, job tersimpan sebagai “Menunggu persetujuan”.</span></span>
      </label>

      <div className="au-row">
        <button className="au-btn primary" disabled={busy}>{busy && <span className="au-spin" />} Simpan job</button>
        <button type="button" className="au-btn" onClick={onCancel}>Batal</button>
      </div>
    </form>
  );
}

function JobRuns({ jobId, tick }) {
  const [runs, setRuns] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api(`/jobs/${jobId}/runs`).then((d) => { if (!cancelled) setRuns(d.runs); }).catch(() => { if (!cancelled) setRuns([]); });
    return () => { cancelled = true; };
  }, [jobId, tick]);

  if (!runs) return <div className="au-muted" style={{ padding: '0.6rem 0' }}>Memuat riwayat…</div>;
  if (!runs.length) return <div className="au-muted" style={{ padding: '0.6rem 0' }}>Belum pernah dijalankan.</div>;
  return (
    <div style={{ marginTop: '0.6rem' }}>
      {runs.slice(0, 5).map((r) => (
        <div key={r.id} style={{ marginBottom: '0.6rem' }}>
          <div className="au-row" style={{ gap: '0.4rem' }}>
            <Chip kind={r.status === 'success' ? 'ok' : r.status === 'failed' ? 'err' : 'warn'}>{r.status}</Chip>
            <span className="au-tiny">{fmtDateTime(r.started_at)} · {r.trigger}</span>
          </div>
          {(r.output || r.error) && (
            <div className="au-pre" style={{ marginTop: '0.35rem' }}>{r.error || r.output}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function JobsTab({ jobs, refresh, notify, tick, limits, channels }) {
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const act = async (id, action, okMsg) => {
    setBusyId(id);
    try {
      await api(`/jobs/${id}/${action}`, { method: 'POST' });
      if (okMsg) notify('ok', okMsg);
      await refresh();
    } catch (e) {
      notify('err', e.message);
    } finally {
      setBusyId(null);
    }
  };

  const del = async () => {
    const id = confirmDel;
    setBusyId(id);
    try {
      await api(`/jobs/${id}`, { method: 'DELETE' });
      notify('ok', 'Job dihapus.');
      setConfirmDel(null);
      await refresh();
    } catch (e) {
      notify('err', e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="au-row between" style={{ marginBottom: '1rem' }}>
        <div className="au-muted">Pekerjaan yang berjalan sendiri menurut jadwal (zona waktu WIB).</div>
        {!creating && <button className="au-btn primary" onClick={() => setCreating(true)}>+ Job baru</button>}
      </div>

      {creating && (
        <JobForm
          limits={limits}
          channels={channels}
          notify={notify}
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); refresh(); }}
        />
      )}

      {jobs.length === 0 && !creating ? (
        <div className="au-card au-empty">
          <b>Belum ada job otomasi</b>
          Contoh: “kirim laporan ke tim setiap hari kerja jam 09:00”, atau minta agen di chat untuk mengusulkannya.
        </div>
      ) : (
        <div className="au-list">
          {jobs.map((j) => (
            <div key={j.id}>
              <div className={`au-item ${open === j.id ? 'selected' : ''}`}>
                <div style={{ minWidth: 0 }}>
                  <div className="t">
                    {j.name}
                    {statusChip(JOB_STATUS, j.status)}
                    <Chip kind="info">{TYPE_LABEL[j.type] || j.type}</Chip>
                    {j.running && <Chip kind="brand"><span className="au-spin" /> berjalan</Chip>}
                    {j.created_by === 'agent' && <Chip>usulan agen</Chip>}
                  </div>
                  <div className="m">
                    {j.scheduleDescription}
                    {j.status === 'active' && j.next_run_at ? ` · berikutnya ${fmtDateTime(j.next_run_at)} (${fromNow(j.next_run_at)})` : ''}
                    {j.run_count ? ` · ${j.run_count}× dijalankan` : ''}
                  </div>
                  {j.status_reason && j.status !== 'active' && <div className="m" style={{ color: 'var(--warning)' }}>{j.status_reason}</div>}
                </div>
                <div className="au-actions">
                  {j.status === 'pending_approval' && (
                    <button className="au-btn sm primary" disabled={busyId === j.id} onClick={() => act(j.id, 'approve', 'Job disetujui & diaktifkan.')}>Setujui</button>
                  )}
                  {j.status === 'paused' && (
                    <button className="au-btn sm primary" disabled={busyId === j.id} onClick={() => act(j.id, 'approve', 'Job diaktifkan kembali.')}>Aktifkan</button>
                  )}
                  {j.status === 'active' && (
                    <button className="au-btn sm" disabled={busyId === j.id} onClick={() => act(j.id, 'pause', 'Job dijeda.')}>Jeda</button>
                  )}
                  {j.status !== 'pending_approval' && (
                    <button className="au-btn sm" disabled={busyId === j.id || j.running} onClick={() => act(j.id, 'run', 'Job mulai dijalankan.')}>Jalankan sekarang</button>
                  )}
                  <button className="au-btn sm" onClick={() => setOpen(open === j.id ? null : j.id)}>{open === j.id ? 'Tutup' : 'Riwayat'}</button>
                  <button className="au-btn sm danger" onClick={() => setConfirmDel(j.id)}>Hapus</button>
                </div>
              </div>
              {open === j.id && (
                <div className="au-card" style={{ marginTop: '0.4rem' }}>
                  <JobRuns jobId={j.id} tick={tick} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Confirm
        open={Boolean(confirmDel)}
        title="Hapus job ini?"
        confirmLabel="Hapus"
        danger
        busy={busyId === confirmDel}
        onConfirm={del}
        onCancel={() => setConfirmDel(null)}
      >
        Job dan seluruh riwayat eksekusinya akan dihapus. Kampanye email yang sudah dibuat tidak ikut terhapus.
      </Confirm>
    </>
  );
}

// --------------------------------------------------------------- campaigns

function CampaignDetail({ id, tick, notify, refresh, onClose }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api(`/campaigns/${id}?limit=200${filter ? `&status=${filter}` : ''}`);
      setData(d);
    } catch (e) {
      notify('err', e.message);
    }
  }, [id, filter, notify]);

  useEffect(() => { load(); }, [load, tick]);

  if (!data) return <div className="au-card au-empty">Memuat kampanye…</div>;
  const c = data.campaign;
  const s = c.stats;

  const act = async (action, msg) => {
    setBusy(true);
    try {
      await api(`/campaigns/${c.id}/${action}`, { method: 'POST' });
      if (msg) notify('ok', msg);
      setConfirm(null);
      await Promise.all([load(), refresh()]);
    } catch (e) {
      notify('err', e.message);
    } finally {
      setBusy(false);
    }
  };

  const progressClass = c.status === 'running' ? 'running' : c.status === 'completed' ? 'done' : c.status === 'paused' ? 'paused' : '';

  return (
    <div className="au-card" style={{ marginTop: '1rem' }}>
      <div className="au-row between">
        <h3 style={{ margin: 0 }}>{c.name}</h3>
        <button className="au-btn sm" onClick={onClose}>Tutup</button>
      </div>
      <div className="au-row" style={{ margin: '0.5rem 0', gap: '0.4rem' }}>
        {statusChip(CAMPAIGN_STATUS, c.status)}
        <Chip kind="info">{CHANNEL_LABEL[c.channel || 'email']}</Chip>
        {c.mode && <Chip kind={c.mode === 'live' ? 'brand' : ''}>{c.mode === 'live' ? 'KIRIM NYATA' : 'SIMULASI'}</Chip>}
        {c.status_reason && c.status === 'paused' && <span className="au-tiny">{PAUSE_REASON[c.status_reason] || c.status_reason}</span>}
      </div>
      <div className="au-muted">Subjek: <b style={{ color: 'var(--text-primary)' }}>{c.subject}</b></div>
      {c.approved_by && <div className="au-tiny">Disetujui oleh {c.approved_by} · {fmtDateTime(c.approved_at)}</div>}

      {data.attachments?.length > 0 && (
        <div className="au-row" style={{ gap: '0.4rem', marginTop: '0.5rem' }}>
          <span className="au-tiny">Lampiran:</span>
          {data.attachments.map((a) => <Chip key={a.id} kind="brand">{a.filename} · {fmtSize(a.size)}</Chip>)}
        </div>
      )}

      <div className={`au-progress ${progressClass}`}><i style={{ width: `${s.percent}%` }} /></div>
      <div className="au-row" style={{ gap: '0.4rem', margin: '0.6rem 0' }}>
        <Chip kind="ok">{s.sent} terkirim</Chip>
        <Chip>{s.queued + s.sending} antre</Chip>
        {s.failed > 0 && <Chip kind="err">{s.failed} gagal</Chip>}
        {s.skipped > 0 && <Chip kind="warn">{s.skipped} dilewati</Chip>}
        <span className="au-tiny">{s.done}/{s.total} ({s.percent}%)</span>
      </div>

      <div className="au-row" style={{ marginBottom: '0.8rem' }}>
        {c.status === 'draft' && <button className="au-btn primary" onClick={() => setConfirm('start')}>Setujui & Kirim</button>}
        {c.status === 'running' && <button className="au-btn" disabled={busy} onClick={() => act('pause', 'Kampanye dijeda.')}>Jeda</button>}
        {c.status === 'paused' && <button className="au-btn primary" disabled={busy} onClick={() => act('resume', 'Kampanye dilanjutkan.')}>Lanjutkan</button>}
        {s.failed > 0 && c.status !== 'running' && <button className="au-btn" disabled={busy} onClick={() => act('retry-failed', 'Penerima gagal dimasukkan ulang ke antrean.')}>Coba ulang yang gagal</button>}
        {['draft', 'running', 'paused'].includes(c.status) && <button className="au-btn danger" onClick={() => setConfirm('cancel')}>Batalkan</button>}
        {c.status !== 'running' && <button className="au-btn danger" onClick={() => setConfirm('delete')}>Hapus</button>}
      </div>

      <div className="au-row between" style={{ marginBottom: '0.5rem' }}>
        <b style={{ fontSize: '0.88rem' }}>Penerima</b>
        <select className="au-select" style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">Semua</option>
          <option value="sent">Terkirim</option>
          <option value="queued">Antre</option>
          <option value="failed">Gagal</option>
          <option value="skipped">Dilewati</option>
        </select>
      </div>
      <div className="au-tablewrap">
        <table className="au-table">
          <thead><tr><th>Tujuan</th><th>Nama</th><th>Status</th><th>Percobaan</th><th>Keterangan</th></tr></thead>
          <tbody>
            {data.recipients.length === 0 && <tr><td colSpan={5} className="wrap">Tidak ada data.</td></tr>}
            {data.recipients.map((r) => (
              <tr key={r.id}>
                <td>{r.email}</td>
                <td>{r.name || '—'}</td>
                <td><Chip kind={OUTBOX_CHIP[r.status] || ''}>{r.status}</Chip></td>
                <td>{r.attempts}</td>
                <td className="wrap">{r.last_error || (r.sent_at ? fmtDateTime(r.sent_at) : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Confirm
        open={confirm === 'start'}
        title={`Kirim ke ${s.queued} penerima?`}
        confirmLabel="Setujui & Kirim"
        busy={busy}
        onConfirm={() => act('start', 'Pengiriman dimulai.')}
        onCancel={() => setConfirm(null)}
      >
        {c.subject ? `Judul “${c.subject}”. ` : ''}Pesan akan dikirim satu per satu dengan jeda otomatis.
        <br />Anda bisa menjeda atau membatalkan kapan saja.
      </Confirm>
      <Confirm
        open={confirm === 'delete'}
        title="Hapus kampanye ini?"
        confirmLabel="Hapus"
        danger
        busy={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await api(`/campaigns/${c.id}`, { method: 'DELETE' });
            notify('ok', 'Kampanye dihapus.');
            setConfirm(null);
            await refresh();
            onClose();
          } catch (e) { notify('err', e.message); } finally { setBusy(false); }
        }}
        onCancel={() => setConfirm(null)}
      >
        Kampanye beserta riwayat pengiriman per penerima akan dihapus permanen.
      </Confirm>
      <Confirm
        open={confirm === 'cancel'}
        title="Batalkan kampanye?"
        confirmLabel="Batalkan"
        danger
        busy={busy}
        onConfirm={() => act('cancel', 'Kampanye dibatalkan.')}
        onCancel={() => setConfirm(null)}
      >
        Email yang belum terkirim tidak akan dikirim. Yang sudah terkirim tidak bisa ditarik kembali.
      </Confirm>
    </div>
  );
}

function CampaignComposer({ overview, notify, refresh, seed, onSeedConsumed, onSent }) {
  const [channel, setChannel] = useState('email');
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [recipients, setRecipients] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [brief, setBrief] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const bodyRef = useRef(null);

  // Templates for every channel come from one AI brief; edits are kept per channel.
  const draftsRef = useRef({});
  const prevChannel = useRef(channel);
  const [templated, setTemplated] = useState([]);

  useEffect(() => {
    if (!seed) return;
    if (seed.drafts) {
      draftsRef.current = { ...seed.drafts };
      setTemplated(Object.keys(seed.drafts));
    }
    if (seed.channel && seed.channel !== channel) {
      prevChannel.current = seed.channel; // do not file the current text under the old channel
      setChannel(seed.channel);
    }
    if (seed.name && !name.trim()) setName(seed.name);
    if (seed.subject !== undefined) setSubject(seed.subject || '');
    if (seed.body) setBody(seed.body);
    setDraft(null);
    onSeedConsumed();
  }, [seed, onSeedConsumed]);

  // Editing the content invalidates a previously generated draft/preview.
  useEffect(() => { setDraft(null); }, [channel, name, subject, body, recipients, replyTo, attachments]);

  // A different channel means a different address format: start that list fresh.
  useEffect(() => { setRecipients(''); }, [channel]);

  // Switching channel swaps in that channel's template (edits stay per channel).
  useEffect(() => {
    const prev = prevChannel.current;
    if (prev === channel) return;
    draftsRef.current[prev] = { subject, body };
    prevChannel.current = channel;
    const t = draftsRef.current[channel];
    if (t) {
      setSubject(t.subject || '');
      setBody(t.body || '');
    }
  }, [channel]); // eslint-disable-line react-hooks/exhaustive-deps

  const insertVar = (v) => {
    const el = bodyRef.current;
    const token = `{{${v}}}`;
    if (!el) { setBody((b) => b + token); return; }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length); });
  };

  const writeWithAI = async () => {
    setAiBusy(true);
    try {
      const d = await api('/compose/package', { method: 'POST', body: { brief } });
      draftsRef.current = { ...d.drafts };
      setTemplated(Object.keys(d.drafts));
      if (!name.trim()) setName(d.name);
      const mine = d.drafts[channel] || {};
      setSubject(mine.subject || '');
      setBody(mine.body || '');
      notify('ok', `Template untuk ${Object.keys(d.drafts).length} kanal dibuat${d.model ? ` (${d.model})` : ''}. Ganti kanal untuk melihat versinya, lalu sesuaikan.`);
    } catch (e) {
      notify('err', e.message);
    } finally {
      setAiBusy(false);
    }
  };

  const createDraft = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const d = await api('/campaigns', {
        method: 'POST',
        body: {
          name, subject, bodyText: body, recipients, replyTo: replyTo || undefined,
          channel,
          attachmentIds: attachments.map((a) => a.id),
        },
      });
      setDraft(d);
      await refresh();
    } catch (err) {
      notify('err', err.message);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    try {
      await api(`/campaigns/${draft.campaign.id}/start`, { method: 'POST' });
      notify('ok', 'Pengiriman dimulai — pantau progresnya secara realtime.');
      setConfirm(false);
      const id = draft.campaign.id;
      setDraft(null);
      setName(''); setSubject(''); setBody(''); setRecipients(''); setAttachments([]);
      draftsRef.current = {}; setTemplated([]);
      await refresh();
      onSent(id);
    } catch (err) {
      notify('err', err.message);
    } finally {
      setBusy(false);
    }
  };

  const chInfo = (overview?.channels || []).find((c) => c.id === channel);
  const mode = chInfo?.mode || overview?.mailer?.mode;
  const caps = chInfo?.capabilities || {};
  const isEmail = channel === 'email';
  const fixed = FIXED_DEST.has(channel);
  const report = draft?.report;

  return (
    <form className="au-card" onSubmit={createDraft}>
      <h3>Kirim pesan baru <small>ke banyak penerima sekaligus</small></h3>

      <div className="au-field">
        <label>Kanal</label>
        <div className="au-chips-row" role="radiogroup" aria-label="Kanal">
          {CHANNELS.map((id) => {
            const info = (overview?.channels || []).find((c) => c.id === id);
            return (
              <button
                type="button" key={id} role="radio" aria-checked={channel === id}
                className={`au-chan ${channel === id ? 'active' : ''}`}
                onClick={() => setChannel(id)}
              >
                {CHANNEL_LABEL[id]}
                {info && <i className={`au-dot-s ${info.mode === 'live' ? 'on' : ''}`} title={info.mode === 'live' ? 'Live' : 'Simulasi'} />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="au-field">
        <label>Minta AI membuatkan template semua kanal (opsional){templated.length > 0 && <span className="au-tiny"> · template siap: {templated.map((c) => CHANNEL_LABEL[c]).join(', ')}</span>}</label>
        <div className="au-row" style={{ flexWrap: 'nowrap' }}>
          <input className="au-input" value={brief} onChange={(e) => setBrief(e.target.value)}
            placeholder="mis. Undangan rapat evaluasi Jumat jam 10.00 di ruang meeting lantai 3" />
          <button type="button" className="au-btn" disabled={aiBusy || !brief.trim()} onClick={writeWithAI}>
            {aiBusy && <span className="au-spin" />} Buat template AI
          </button>
        </div>
      </div>

      <div className="au-split">
        <div className="au-field">
          <label>Nama kampanye</label>
          <input className="au-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="mis. Undangan rapat evaluasi" />
        </div>
        {isEmail && (
          <div className="au-field">
            <label>Reply-To (opsional)</label>
            <input className="au-input" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="balasan@perusahaan.co.id" />
          </div>
        )}
      </div>

      <div className="au-field">
        <label>{isEmail ? 'Subjek' : 'Judul (opsional)'}</label>
        <input className="au-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Undangan: {{nama|Bapak/Ibu}}, rapat evaluasi {{hari}}" required={isEmail} />
      </div>

      <div className="au-field">
        <label>{isEmail ? 'Isi email' : 'Isi pesan'} <span className="au-tiny">· {body.length} karakter{!isEmail && caps.maxTextLength ? ` · batas ${caps.maxTextLength}` : ''}</span></label>
        <textarea ref={bodyRef} className="au-textarea" style={{ minHeight: 180 }} value={body} onChange={(e) => setBody(e.target.value)}
          placeholder={'Yth. {{nama|Bapak/Ibu}},\n\n…\n\nSalam hormat,\nWisnu'} required />
        <div className="au-chips-row">
          {['nama', 'tanggal', 'hari', 'jam', ...(draft?.report?.variables || [])]
            .filter((v, i, a) => a.indexOf(v) === i)
            .map((v) => <button type="button" key={v} className="au-chipbtn" onClick={() => insertVar(v)}>{`{{${v}}}`}</button>)}
        </div>
      </div>

      {caps.attachments === false ? (
        <div className="au-tiny" style={{ marginBottom: '0.8rem' }}>
          {CHANNEL_LABEL[channel]} tidak mendukung lampiran{channel === 'whatsapp' ? ' pada mode template' : ''}.
        </div>
      ) : (
        <AttachmentPicker value={attachments} onChange={setAttachments} notify={notify} limits={overview?.attachmentLimits} />
      )}

      {fixed ? (
        <div className="au-alert info">
          <b>{CHANNEL_LABEL[channel]}</b> mengirim ke satu tujuan tetap yang diatur di <b>.env</b> — tidak perlu daftar penerima.
        </div>
      ) : (
        <RecipientsField channel={channel} value={recipients} onChange={setRecipients} hint="Kolom CSV tambahan otomatis menjadi variabel, mis. kolom “perusahaan” → {{perusahaan}}." />
      )}

      <div className="au-row">
        <button className="au-btn" disabled={busy}>{busy && <span className="au-spin" />} Buat draf & pratinjau</button>
      </div>

      {draft && (
        <div style={{ marginTop: '1.2rem' }}>
          {mode !== 'live' && (
            <div className="au-alert warn"><b>Mode simulasi</b> — pesan tidak benar-benar dikirim karena kanal {CHANNEL_LABEL[channel]} belum dikonfigurasi.</div>
          )}
          <div className="au-row" style={{ gap: '0.4rem', marginBottom: '0.7rem' }}>
            <Chip kind="ok">{report.valid} penerima valid</Chip>
            {report.invalid.length > 0 && <Chip kind="err">{report.invalid.length} ditolak</Chip>}
            {report.duplicates.length > 0 && <Chip kind="warn">{report.duplicates.length} duplikat dibuang</Chip>}
            {report.suppressed.length > 0 && <Chip kind="warn">{report.suppressed.length} di-suppress</Chip>}
          </div>
          {report.warnings?.length > 0 && (
            <div className="au-alert warn">{report.warnings.map((w) => <div key={w}>{w}</div>)}</div>
          )}
          {report.recipientsWithMissingCount > 0 && (
            <div className="au-alert warn">
              <b>{report.recipientsWithMissingCount} penerima kekurangan data variabel</b> dan akan <b>dilewati</b>{' '}
              (contoh: {report.recipientsWithMissing[0]?.email} tanpa {report.recipientsWithMissing[0]?.missing.join(', ')}).
              Tambahkan fallback seperti {'{{nama|Bapak/Ibu}}'} agar tetap terkirim.
            </div>
          )}
          {attachments.length > 0 && (
            <div className="au-row" style={{ gap: '0.4rem', marginBottom: '0.6rem' }}>
              <span className="au-tiny">Lampiran di setiap email:</span>
              {attachments.map((a) => <Chip key={a.id} kind="brand">{a.filename} · {fmtSize(a.size)}</Chip>)}
            </div>
          )}
          <b style={{ fontSize: '0.88rem' }}>Pratinjau</b>
          <div style={{ marginTop: '0.5rem' }}>
            {draft.preview.map((p) => (
              <div className="au-preview" key={p.to}>
                <div className="to">Kepada: {p.name ? `${p.name} <${p.to}>` : p.to}</div>
                <div className="sub">{p.subject}</div>
                <div className="au-pre">{p.text}</div>
              </div>
            ))}
          </div>
          <div className="au-row">
            <button type="button" className="au-btn primary" disabled={busy || report.valid === 0} onClick={() => setConfirm(true)}>
              Setujui & Kirim ke {report.valid - report.suppressed.length} penerima
            </button>
            <span className="au-tiny">Belum ada email yang terkirim sampai Anda menyetujui.</span>
          </div>
        </div>
      )}

      <Confirm
        open={confirm}
        title="Konfirmasi pengiriman"
        confirmLabel="Ya, kirim sekarang"
        busy={busy}
        onConfirm={send}
        onCancel={() => setConfirm(false)}
      >
        Anda akan mengirim <b>{draft?.report?.valid ?? 0}</b> pesan {CHANNEL_LABEL[channel]}{subject ? <> dengan judul “{subject}”</> : null}.
        <br />Mode: <b>{mode === 'live' ? `KIRIM NYATA via ${CHANNEL_LABEL[channel]}` : 'SIMULASI (tidak benar-benar terkirim)'}</b>.
        <br />Pesan yang sudah terkirim tidak dapat ditarik kembali.
      </Confirm>
    </form>
  );
}

function CampaignsTab({ overview, campaigns, refresh, notify, tick, seed, onSeedConsumed, focusId, onFocusConsumed }) {
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (focusId) { setSelected(focusId); onFocusConsumed(); }
  }, [focusId, onFocusConsumed]);

  return (
    <>
      <CampaignComposer
        overview={overview}
        notify={notify}
        refresh={refresh}
        seed={seed}
        onSeedConsumed={onSeedConsumed}
        onSent={(id) => setSelected(id)}
      />

      <div className="au-card" style={{ marginTop: '1rem' }}>
        <h3>Riwayat kampanye <small>{campaigns.length}</small></h3>
        {campaigns.length === 0 ? (
          <div className="au-empty"><b>Belum ada kampanye</b>Kampanye yang Anda buat akan tampil di sini beserta progres realtime-nya.</div>
        ) : (
          <div className="au-list">
            {campaigns.map((c) => {
              const cls = c.status === 'running' ? 'running' : c.status === 'completed' ? 'done' : c.status === 'paused' ? 'paused' : '';
              return (
                <div key={c.id} className={`au-item ${selected === c.id ? 'selected' : ''}`} style={{ cursor: 'pointer' }}
                  onClick={() => setSelected(selected === c.id ? null : c.id)}>
                  <div style={{ minWidth: 0 }}>
                    <div className="t">
                      {c.name}
                      {statusChip(CAMPAIGN_STATUS, c.status)}
                      <Chip kind="info">{CHANNEL_LABEL[c.channel || 'email']}</Chip>
                      {c.mode === 'dry-run' && <Chip>simulasi</Chip>}
                      {c.created_by === 'scheduler' && <Chip kind="info">dari jadwal</Chip>}
                    </div>
                    <div className="m">{c.subject} · {c.stats.sent}/{c.stats.total} terkirim · {fmtDateTime(c.created_at)}</div>
                    <div className={`au-progress ${cls}`}><i style={{ width: `${c.stats.percent}%` }} /></div>
                  </div>
                  <div className="au-actions"><Chip>{c.stats.percent}%</Chip></div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selected && (
        <CampaignDetail id={selected} tick={tick} notify={notify} refresh={refresh} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

// ----------------------------------------------------------------- compose

function ComposeTab({ notify, onUseEmail }) {
  const [mode, setMode] = useState('package');
  const [brief, setBrief] = useState('');
  const [tone, setTone] = useState('profesional dan ramah');
  const [audience, setAudience] = useState('');
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const run = async (e) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      let d;
      if (mode === 'package') d = await api('/compose/package', { method: 'POST', body: { brief, tone, audience } });
      else if (mode === 'email') d = await api('/compose/email', { method: 'POST', body: { brief, tone, audience } });
      else if (mode === 'code') d = await api('/compose/code', { method: 'POST', body: { brief, language } });
      else d = await api('/compose/text', { method: 'POST', body: { prompt: brief } });
      setResult({ mode, ...d });
    } catch (err) {
      notify('err', err.message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      notify('ok', 'Disalin ke clipboard.');
    } catch {
      notify('err', 'Gagal menyalin — salin manual.');
    }
  };

  return (
    <div className="au-split">
      <form className="au-card" onSubmit={run}>
        <h3>Tulis dengan AI</h3>
        <div className="au-tabs" style={{ marginBottom: '1rem' }}>
          {[['package', 'Semua kanal'], ['email', 'Email'], ['code', 'Kode'], ['text', 'Teks bebas']].map(([k, label]) => (
            <button type="button" key={k} className={`au-tab ${mode === k ? 'active' : ''}`} onClick={() => { setMode(k); setResult(null); }}>{label}</button>
          ))}
        </div>

        <div className="au-field">
          <label>{mode === 'email' || mode === 'package' ? 'Brief pesan' : mode === 'code' ? 'Apa yang ingin dibuat?' : 'Permintaan'}</label>
          <textarea className="au-textarea" value={brief} onChange={(e) => setBrief(e.target.value)} required
            placeholder={
              mode === 'email' || mode === 'package' ? 'mis. Balas klien yang menanyakan keterlambatan pengiriman, minta maaf, dan tawarkan jadwal baru Selasa.'
                : mode === 'code' ? 'mis. Script Python yang membaca semua file CSV di folder dan menggabungkannya menjadi satu Excel.'
                  : 'mis. Ringkas poin-poin rapat berikut menjadi notulen singkat: …'
            } />
        </div>

        {(mode === 'email' || mode === 'package') && (
          <div className="au-split">
            <div className="au-field"><label>Nada</label><input className="au-input" value={tone} onChange={(e) => setTone(e.target.value)} /></div>
            <div className="au-field"><label>Penerima</label><input className="au-input" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="mis. klien korporat" /></div>
          </div>
        )}
        {mode === 'code' && (
          <div className="au-field"><label>Bahasa pemrograman</label><input className="au-input" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="Python, JavaScript, SQL, PHP…" /></div>
        )}

        <button className="au-btn primary" disabled={busy || !brief.trim()}>{busy && <span className="au-spin" />} Buat sekarang</button>
        <div className="au-tiny" style={{ marginTop: '0.6rem' }}>
          Selalu periksa hasil AI sebelum digunakan. Jika model utama kehabisan kuota, sistem otomatis pindah ke model lain.
        </div>
      </form>

      <div className="au-card">
        <h3>Hasil {result?.model && <small>{result.model}</small>}</h3>
        {!result ? (
          <div className="au-empty"><b>Belum ada hasil</b>Isi permintaan di kiri lalu tekan “Buat sekarang”.</div>
        ) : result.mode === 'package' ? (
          <>
            <div className="au-field"><label>Nama kampanye</label><div className="au-pre">{result.name}</div></div>
            {Object.entries(result.drafts).map(([ch, dr]) => (
              <div className="au-preview" key={ch}>
                <div className="to"><b>{CHANNEL_LABEL[ch]}</b></div>
                {dr.subject && <div className="sub">{dr.subject}</div>}
                <div className="au-pre" style={{ maxHeight: 150 }}>{dr.body}</div>
                <div className="au-row" style={{ marginTop: '0.4rem' }}>
                  <button
                    type="button" className="au-btn sm primary"
                    onClick={() => onUseEmail({ name: result.name, drafts: result.drafts, channel: ch, subject: dr.subject, body: dr.body })}
                  >
                    Pakai di {CHANNEL_LABEL[ch]}
                  </button>
                </div>
              </div>
            ))}
          </>
        ) : result.mode === 'email' ? (
          <>
            <div className="au-field"><label>Subjek</label><div className="au-pre">{result.subject}</div></div>
            <div className="au-field"><label>Isi</label><div className="au-pre">{result.body}</div></div>
            <div className="au-row">
              <button className="au-btn primary" onClick={() => onUseEmail({ subject: result.subject, body: result.body })}>Jadikan kampanye</button>
              <button className="au-btn" onClick={() => copy(`Subjek: ${result.subject}\n\n${result.body}`)}>Salin</button>
            </div>
          </>
        ) : result.mode === 'code' ? (
          <>
            {result.language && <Chip kind="info">{result.language}</Chip>}
            <div className="au-pre au-code" style={{ marginTop: '0.5rem' }}>{result.code || result.text}</div>
            {result.code && result.text !== result.code && <div className="au-muted" style={{ marginTop: '0.6rem', whiteSpace: 'pre-wrap' }}>{result.text.replace(/```[\s\S]*?```/g, '').trim()}</div>}
            <div className="au-row" style={{ marginTop: '0.8rem' }}>
              <button className="au-btn" onClick={() => copy(result.code || result.text)}>Salin kode</button>
            </div>
          </>
        ) : (
          <>
            <div className="au-pre">{result.text}</div>
            <div className="au-row" style={{ marginTop: '0.8rem' }}>
              <button className="au-btn" onClick={() => copy(result.text)}>Salin</button>
              <button className="au-btn" onClick={() => onUseEmail({ subject: '', body: result.text })}>Jadikan isi email</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- settings

const ENV_SNIPPET = `# .env — konfigurasi pengiriman email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=anda@gmail.com
SMTP_PASS=app-password-16-karakter
MAIL_FROM="Nama Anda <anda@gmail.com>"

# opsional
EMAIL_DAILY_CAP=450        # batas kirim per hari
EMAIL_THROTTLE_MS=1200     # jeda antar email
EMAIL_MAX_RECIPIENTS=1000  # maks penerima per kampanye`;

/** Telegram / WhatsApp / Slack / Discord / Teams / Webhook: status, setup and test. */
function ChannelsSettings({ overview, notify, refresh }) {
  const channels = (overview?.channels || []).filter((c) => c.id !== 'email');
  const [tests, setTests] = useState({});
  const [subs, setSubs] = useState({ counts: null, list: [] });
  const [newSub, setNewSub] = useState('');
  const inbox = overview?.telegramInbox;

  const loadSubs = useCallback(async () => {
    try {
      const d = await api('/subscribers/telegram');
      setSubs({ counts: d.counts, list: d.subscribers });
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadSubs(); }, [loadSubs]);

  const setTest = (id, patch) => setTests((t) => ({ ...t, [id]: { ...(t[id] || {}), ...patch } }));

  const runTest = async (c) => {
    setTest(c.id, { busy: true, result: null });
    try {
      const d = await api(`/channels/${c.id}/test`, { method: 'POST', body: { to: tests[c.id]?.to || '' } });
      setTest(c.id, { busy: false, result: { ok: true, text: `Pesan uji terkirim${d.verified ? ` (${d.verified})` : ''}.` } });
    } catch (err) {
      const miss = err.data?.missing;
      setTest(c.id, { busy: false, result: { ok: false, text: err.message + (miss?.length ? ` (kurang: ${miss.join(', ')})` : '') } });
    }
  };

  const addSub = async () => {
    try {
      await api('/subscribers/telegram', { method: 'POST', body: { address: newSub } });
      setNewSub('');
      await Promise.all([loadSubs(), refresh()]);
    } catch (err) { notify('err', err.message); }
  };
  const rmSub = async (address) => {
    try {
      await api(`/subscribers/telegram/${encodeURIComponent(address)}`, { method: 'DELETE' });
      await loadSubs();
    } catch (err) { notify('err', err.message); }
  };

  return (
    <>
      {channels.map((c) => (
        <div className="au-card" key={c.id}>
          <h3>
            {CHANNEL_LABEL[c.id] || c.label}
            <Chip kind={c.mode === 'live' ? 'ok' : 'warn'}>{c.mode === 'live' ? 'Live' : 'Simulasi'}</Chip>
          </h3>
          <div className="au-muted" style={{ marginBottom: '0.6rem' }}>{c.hint}</div>
          {c.sendMode && <div className="au-tiny" style={{ marginBottom: '0.5rem' }}>Mode kirim: {c.sendMode}</div>}
          {c.destination && <div className="au-tiny" style={{ marginBottom: '0.5rem' }}>Tujuan: {c.destination}</div>}
          {c.mode !== 'live' && c.missing?.length > 0 && (
            <div className="au-alert warn">Belum diatur di <b>.env</b>: {c.missing.join(', ')}.</div>
          )}
          <pre className="au-pre au-code" style={{ maxHeight: 150 }}>{ENV_GUIDE[c.id]}</pre>
          <div className="au-row" style={{ flexWrap: 'nowrap', marginTop: '0.6rem' }}>
            {!FIXED_DEST.has(c.id) && (
              <input
                className="au-input"
                value={tests[c.id]?.to || ''}
                onChange={(e) => setTest(c.id, { to: e.target.value })}
                placeholder={c.id === 'whatsapp' ? '0812-3456-7890' : 'chat ID, mis. 123456789'}
              />
            )}
            <button className="au-btn primary" disabled={tests[c.id]?.busy} onClick={() => runTest(c)}>
              {tests[c.id]?.busy && <span className="au-spin" />} Tes
            </button>
          </div>
          {tests[c.id]?.result && (
            <div className={`au-alert ${tests[c.id].result.ok ? 'ok' : 'err'}`} style={{ marginTop: '0.6rem' }}>{tests[c.id].result.text}</div>
          )}
        </div>
      ))}

      <div className="au-card" style={{ gridColumn: '1 / -1' }}>
        <h3>
          Pelanggan Telegram
          <small>
            {subs.counts ? `${subs.counts.active} aktif dari ${subs.counts.total}` : '—'}
            {inbox ? (inbox.running ? ' · inbox aktif' : ' · inbox mati (set TELEGRAM_POLLING=true)') : ''}
          </small>
        </h3>
        <div className="au-muted" style={{ marginBottom: '0.6rem' }}>
          Orang mendaftar sendiri dengan mengirim <b>/start</b> ke bot{inbox?.requiresJoinCode ? ' (butuh kode undangan)' : ''}, dan berhenti dengan <b>/stop</b>.
          Pakai <b>@subscribers</b> sebagai penerima untuk mengirim ke semuanya.
        </div>
        <div className="au-row" style={{ flexWrap: 'nowrap', marginBottom: '0.8rem' }}>
          <input className="au-input" value={newSub} onChange={(e) => setNewSub(e.target.value)} placeholder="Tambah manual: chat ID (mis. 123456789)" />
          <button className="au-btn" onClick={addSub} disabled={!newSub.trim()}>Tambah</button>
        </div>
        {subs.list.length === 0 ? (
          <div className="au-muted">Belum ada pelanggan.</div>
        ) : (
          <div className="au-tablewrap">
            <table className="au-table">
              <thead><tr><th>Chat ID</th><th>Nama</th><th>Username</th><th>Status</th><th>Sejak</th><th /></tr></thead>
              <tbody>
                {subs.list.map((u) => (
                  <tr key={u.address}>
                    <td>{u.address}</td>
                    <td>{u.name || '—'}</td>
                    <td>{u.username ? `@${u.username}` : '—'}</td>
                    <td><Chip kind={u.active ? 'ok' : ''}>{u.active ? 'aktif' : 'berhenti'}</Chip></td>
                    <td>{fmtDateTime(u.created_at)}</td>
                    <td style={{ textAlign: 'right' }}><button className="au-btn sm" onClick={() => rmSub(u.address)}>Hapus</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function SettingsTab({ overview, notify, refresh }) {
  const [to, setTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [supp, setSupp] = useState([]);
  const [suppText, setSuppText] = useState('');

  const loadSupp = useCallback(async () => {
    try { setSupp((await api('/suppressions')).suppressions); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadSupp(); }, [loadSupp]);

  if (!overview) return <div className="au-empty">Memuat…</div>;
  const m = overview.mailer;

  const runTest = async (e) => {
    e.preventDefault();
    setTesting(true);
    setTestResult(null);
    try {
      const d = await api('/smtp/test', { method: 'POST', body: { to } });
      setTestResult({ ok: true, text: `Email uji terkirim (${d.messageId || 'ok'}). Periksa kotak masuk ${to}.` });
    } catch (err) {
      const data = err.data || {};
      setTestResult({ ok: false, text: err.message, missing: data.missing });
    } finally {
      setTesting(false);
    }
  };

  const addSupp = async () => {
    try {
      const emails = suppText.split(/[\s,;]+/).filter(Boolean);
      await api('/suppressions', { method: 'POST', body: { emails, reason: 'manual' } });
      setSuppText('');
      notify('ok', 'Ditambahkan ke daftar suppress.');
      await Promise.all([loadSupp(), refresh()]);
    } catch (err) {
      notify('err', err.message);
    }
  };

  const rmSupp = async (email) => {
    try {
      await api(`/suppressions/${encodeURIComponent(email)}`, { method: 'DELETE' });
      await Promise.all([loadSupp(), refresh()]);
    } catch (err) {
      notify('err', err.message);
    }
  };

  return (
    <div className="au-grid cols-2">
      <div className="au-card">
        <h3>Koneksi SMTP <Chip kind={m.mode === 'live' ? 'ok' : 'warn'}>{m.mode === 'live' ? 'Live' : 'Simulasi'}</Chip></h3>
        <table className="au-table" style={{ marginBottom: '1rem' }}>
          <tbody>
            <tr><th>Server</th><td>{m.host ? `${m.host}:${m.port}${m.secure ? ' (SSL)' : ''}` : '—'}</td></tr>
            <tr><th>Akun</th><td>{m.user || '—'}</td></tr>
            <tr><th>Password</th><td>{m.hasPassword ? 'tersimpan di .env' : 'belum diatur'}</td></tr>
            <tr><th>Pengirim</th><td>{m.from ? `${m.fromName ? `${m.fromName} ` : ''}<${m.from}>` : '—'}</td></tr>
            <tr><th>Batas harian</th><td>{m.dailyCap} email</td></tr>
            <tr><th>Maks penerima</th><td>{m.maxRecipients} / kampanye</td></tr>
            <tr><th>Jeda kirim</th><td>{m.throttleMs} ms</td></tr>
          </tbody>
        </table>

        {m.missing.length > 0 && (
          <div className="au-alert warn">Belum diatur di <b>.env</b>: {m.missing.join(', ')}. Restart server setelah mengubah .env.</div>
        )}
        {m.forceDryRun && <div className="au-alert info"><b>EMAIL_DRY_RUN=true</b> — pengiriman dipaksa mode simulasi.</div>}

        <form onSubmit={runTest}>
          <div className="au-field">
            <label>Kirim email uji ke</label>
            <div className="au-row" style={{ flexWrap: 'nowrap' }}>
              <input className="au-input" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="anda@perusahaan.co.id" required />
              <button className="au-btn primary" disabled={testing}>{testing && <span className="au-spin" />} Tes</button>
            </div>
          </div>
        </form>
        {testResult && <div className={`au-alert ${testResult.ok ? 'ok' : 'err'}`}>{testResult.text}{testResult.missing?.length ? ` (kurang: ${testResult.missing.join(', ')})` : ''}</div>}
      </div>

      <div className="au-card">
        <h3>Cara menghubungkan email</h3>
        <div className="au-muted" style={{ marginBottom: '0.6rem' }}>
          Tambahkan baris berikut ke file <b>.env</b> lalu restart server. Untuk Gmail gunakan <b>App Password</b>{' '}
          (Akun Google → Keamanan → Verifikasi 2 langkah → Sandi aplikasi), bukan password login.
        </div>
        <pre className="au-pre au-code">{ENV_SNIPPET}</pre>
        <div className="au-tiny" style={{ marginTop: '0.5rem' }}>
          Kredensial hanya dibaca dari .env — tidak pernah disimpan di database atau dikirim ke browser.
        </div>
      </div>

      <ChannelsSettings overview={overview} notify={notify} refresh={refresh} />

      <div className="au-card" style={{ gridColumn: '1 / -1' }}>
        <h3>Daftar suppress <small>{supp.length} alamat tidak akan pernah dikirimi</small></h3>
        <div className="au-row" style={{ flexWrap: 'nowrap', marginBottom: '0.8rem' }}>
          <input className="au-input" value={suppText} onChange={(e) => setSuppText(e.target.value)} placeholder="email@yang-menolak.com (pisahkan dengan koma/spasi)" />
          <button className="au-btn" onClick={addSupp} disabled={!suppText.trim()}>Tambah</button>
        </div>
        {supp.length === 0 ? (
          <div className="au-muted">Kosong. Alamat yang bounce keras (user tidak ada) otomatis masuk ke sini.</div>
        ) : (
          <div className="au-tablewrap">
            <table className="au-table">
              <thead><tr><th>Email</th><th>Alasan</th><th>Sejak</th><th /></tr></thead>
              <tbody>
                {supp.map((s) => (
                  <tr key={s.email}>
                    <td>{s.email}</td>
                    <td><Chip kind={s.reason === 'bounce' ? 'err' : ''}>{s.reason}</Chip></td>
                    <td>{fmtDateTime(s.created_at)}</td>
                    <td style={{ textAlign: 'right' }}><button className="au-btn sm" onClick={() => rmSupp(s.email)}>Hapus</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- page

export default function Automation() {
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [feed, setFeed] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [live, setLive] = useState(false);
  const [offline, setOffline] = useState(false);
  const [tick, setTick] = useState(0);
  const [seed, setSeed] = useState(null);
  const [focusId, setFocusId] = useState(null);

  const jobsRef = useRef([]);
  jobsRef.current = jobs;
  const refreshTimer = useRef(null);

  const notify = useCallback((kind, text) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [o, j, c] = await Promise.all([api('/overview'), api('/jobs'), api('/campaigns')]);
      setOverview(o);
      setJobs(j.jobs);
      setCampaigns(c.campaigns);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  const refreshSoon = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { refresh(); setTick((t) => t + 1); }, 350);
  }, [refresh]);

  useEffect(() => { refresh(); return () => clearTimeout(refreshTimer.current); }, [refresh]);

  // Realtime stream
  useEffect(() => {

    const push = (key, text) => {
      setFeed((f) => {
        const next = f.filter((x) => x.key !== key);
        return [{ key, at: Date.now(), text }, ...next].slice(0, 30);
      });
    };

    const handle = (e) => {
      let d;
      try { d = JSON.parse(e.data); } catch { return; }
      if (d.channel === 'campaign') {
        if (d.type === 'progress') push(`c:${d.campaignId}`, `Kampanye ${d.campaignId}: ${d.stats.done}/${d.stats.total} diproses (${d.stats.sent} terkirim${d.stats.failed ? `, ${d.stats.failed} gagal` : ''})`);
        else push(`c:${d.campaignId}:${d.status}`, `Kampanye ${d.campaignId} → ${CAMPAIGN_STATUS[d.status]?.[1] || d.status}${d.reason ? ` (${PAUSE_REASON[d.reason] || d.reason})` : ''}`);
      } else if (d.channel === 'job') {
        const job = jobsRef.current.find((j) => j.id === d.jobId);
        const label = job?.name || d.jobId;
        if (d.type === 'run_started') push(`j:${d.jobId}:start`, `Job “${label}” mulai berjalan`);
        else if (d.type === 'run_finished') push(`j:${d.jobId}:${Date.now()}`, `Job “${label}” ${d.status === 'success' ? 'selesai' : `gagal: ${d.error || ''}`}`);
        else push(`j:${d.jobId}:${d.type}`, `Job “${label}”: ${d.type.replace('job_', '')}`);
      } else if (d.channel === 'review') {
        push(`r:${d.campaignId}`, 'Draf email baru dari job terjadwal menunggu review Anda');
        notify('info', 'Draf email baru menunggu review.');
      } else if (d.channel === 'alert') {
        push(`a:${d.campaignId}:${Date.now()}`, `PERINGATAN: ${d.message}`);
        notify('err', d.message);
      }
      refreshSoon();
    };

    return openStream('/api/automation/events', {
      onOpen: () => setLive(true),
      onDown: () => setLive(false),
      events: Object.fromEntries(['campaign', 'job', 'review', 'alert'].map((n) => [n, handle])),
    });
  }, [notify, refreshSoon]);

  const pendingJobs = jobs.filter((j) => j.status === 'pending_approval').length;
  const draftCampaigns = campaigns.filter((c) => c.status === 'draft').length;

  const gotoTab = (t, campaignId) => {
    setTab(t);
    if (campaignId) setFocusId(campaignId);
  };

  const onUseEmail = (s) => { setSeed(s); setTab('campaigns'); };
  const clearSeed = useCallback(() => setSeed(null), []);
  const clearFocus = useCallback(() => setFocusId(null), []);

  const tabs = useMemo(() => ([
    ['overview', 'Ringkasan', 0],
    ['jobs', 'Jadwal', pendingJobs],
    ['campaigns', 'Kirim Pesan', draftCampaigns],
    ['compose', 'Tulis dengan AI', 0],
    ['settings', 'Pengaturan', 0],
  ]), [pendingJobs, draftCampaigns]);

  return (
    <DashboardLayout>
      <div className="au-page">
        <div className="au-hero">
          <div>
            <h1><span>Otomasi</span> kerja kantor</h1>
            <p>Jadwalkan tugas harian, tulis pesan dan kode dengan AI, lalu kirim ke ratusan penerima lewat email, WhatsApp, Telegram, Slack, dan lainnya — Anda tinggal menyetujui.</p>
          </div>
          <span className={`au-live ${live ? 'on' : ''}`} title="Koneksi realtime ke server">
            <i className="au-dot" /> {live ? 'Realtime aktif' : 'Menyambungkan…'}
          </span>
        </div>

        {offline && (
          <div className="au-alert err">Tidak dapat menghubungi server otomasi. Pastikan server berjalan (<b>npm run web</b>).</div>
        )}

        <div className="au-tabs" role="tablist">
          {tabs.map(([key, label, badge]) => (
            <button key={key} role="tab" aria-selected={tab === key} className={`au-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
              {label}{badge > 0 && <span className="au-badge">{badge}</span>}
            </button>
          ))}
        </div>

        {tab === 'overview' && <Overview overview={overview} jobs={jobs} campaigns={campaigns} feed={feed} onGoto={gotoTab} />}
        {tab === 'jobs' && (
          <JobsTab
            jobs={jobs} refresh={refresh} notify={notify} tick={tick}
            limits={overview?.attachmentLimits} channels={overview?.channels}
          />
        )}
        {tab === 'campaigns' && (
          <CampaignsTab
            overview={overview} campaigns={campaigns} refresh={refresh} notify={notify} tick={tick}
            seed={seed} onSeedConsumed={clearSeed} focusId={focusId} onFocusConsumed={clearFocus}
          />
        )}
        {tab === 'compose' && <ComposeTab notify={notify} onUseEmail={onUseEmail} />}
        {tab === 'settings' && <SettingsTab overview={overview} notify={notify} refresh={refresh} />}
      </div>

      <div className="au-toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`au-toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </DashboardLayout>
  );
}
