/**
 * Pusat Kendali — one live screen for the whole personal agent:
 * work clock, reminders, email desk (drafts, batches, who waits on whom,
 * follow-ups), channel health and the server. Realtime via SSE, with the
 * same visual language as Otomasi and Jurnal Kerja (au-* / wl-*).
 *
 * by Wisnu Alfian Nur Ashar
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { openStream, getAutomationToken } from '../lib/stream.js';
import DashboardLayout from './DashboardLayout';
import CommandIntel from './CommandIntel';
import './automation.css';
import './worklog.css';
import './command-center.css';

const TZ = 'Asia/Jakarta';
const TOKEN_KEY = 'automationToken';

async function api(path, { method = 'GET', body } = {}, retried = false) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const t = getAutomationToken();
  if (t) headers['X-Automation-Token'] = t;
  const res = await fetch(`/api/command-center${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && !retried) {
    const entered = window.prompt('Masukkan token otomasi (AUTOMATION_TOKEN di .env server):');
    if (entered) {
      try { localStorage.setItem(TOKEN_KEY, entered.trim()); } catch { /* private mode */ }
      return api(path, { method, body }, true);
    }
  }
  if (!res.ok || data.success === false) throw new Error(data.error || `Permintaan gagal (HTTP ${res.status})`);
  return data;
}

const fmtMin = (m) => {
  const v = Math.max(0, Math.round(m || 0));
  const h = Math.floor(v / 60);
  const mm = v % 60;
  return h ? (mm ? `${h}j ${mm}m` : `${h}j`) : `${mm}m`;
};
const rp = (n) => `${n < 0 ? '-' : ''}Rp${Math.abs(Math.round(n || 0)).toLocaleString('id-ID')}`;
const timeOf = (ms) => new Date(ms).toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const whenOf = (ms) => new Date(ms).toLocaleString('id-ID', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dateOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
};
const uptime = (sec) => (sec >= 86400 ? `${Math.floor(sec / 86400)}h ${Math.floor((sec % 86400) / 3600)}j` : sec >= 3600 ? `${Math.floor(sec / 3600)}j ${Math.floor((sec % 3600) / 60)}m` : `${Math.floor(sec / 60)}m`);

const STATE = { working: ['Sedang bekerja', 'working'], break: ['Istirahat', 'break'], done: ['Selesai', 'done'], idle: ['Belum mulai', 'idle'] };
const MODES = [['inherit', 'Ikuti pengaturan umum'], ['notify', 'Kabari saja'], ['approve', 'AI siapkan, saya konfirmasi'], ['auto', 'Balas otomatis']];
const POLICY = [
  ['auto', 'Balas otomatis', 'Semua email masuk, termasuk dari orang baru, langsung dibalas AI.'],
  ['approve', 'AI siapkan', 'AI menulis balasan, kamu tinggal konfirmasi "kirim".'],
  ['notify', 'Kabari saja', 'Hanya memberi tahu kamu; tidak ada balasan dibuat.'],
];

const RELATION_LABEL = { partner: 'Pasangan', family: 'Keluarga', friend: 'Sahabat' };
const RELATION_HINT = {
  partner: 'dibalas hangat, manis, peka — bahasa sehari-hari',
  family: 'dibalas hangat dan santun',
  friend: 'dibalas santai dan akrab',
};

/** People the owner marked as close: answered personally and automatically. */
function CloseCircle({ email, busy, act }) {
  const [form, setForm] = useState({ address: '', relation: 'partner', call: '', notes: '' });
  const people = email.contacts || [];
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const add = (e) => {
    e.preventDefault();
    if (!form.address.trim()) return;
    act('contact', () => api('/email/contacts', { method: 'POST', body: { address: form.address.trim(), relation: form.relation, call: form.call.trim() || null, notes: form.notes.trim() || null } }),
      'Tersimpan. Email dari dia sekarang dibalas dengan gaya pribadi.').then((r) => { if (r) setForm({ address: '', relation: form.relation, call: '', notes: '' }); });
  };
  return (
    <div className="au-card cc-gap">
      <h3><span className="cc-title">Orang dekat</span><small>dibalas pribadi & otomatis — bisa juga lewat Telegram: "dia pasangan saya"</small></h3>
      {people.length === 0 && <div className="au-muted">Belum ada. Di Telegram cukup tulis: "azzahra@gmail.com adalah pasangan saya, panggil dia sayang".</div>}
      <div className="au-list">
        {people.map((p) => (
          <div key={p.address} className="au-item">
            <div className="cc-ellipsis">
              <div className="t">{p.name || p.address} <span className="au-chip brand">{RELATION_LABEL[p.relation] || p.label}</span>{p.call && <span className="au-chip info">panggilan: {p.call}</span>}</div>
              <div className="au-muted">{p.address} · {RELATION_HINT[p.relation]}{p.notes ? ` · ${p.notes}` : ''}</div>
            </div>
            <div className="au-actions">
              <button className="au-btn sm danger" disabled={!!busy} onClick={() => act(`rm${p.address}`, () => api(`/email/contacts/${encodeURIComponent(p.address)}`, { method: 'DELETE' }), 'Dihapus dari orang dekat')}>Hapus</button>
            </div>
          </div>
        ))}
      </div>
      <form className="cc-contactform" onSubmit={add}>
        <input className="au-input" type="email" placeholder="alamat email" value={form.address} onChange={set('address')} required />
        <select className="au-input" value={form.relation} onChange={set('relation')} aria-label="Hubungan">
          <option value="partner">Pasangan</option>
          <option value="family">Keluarga</option>
          <option value="friend">Sahabat</option>
        </select>
        <input className="au-input" placeholder="panggilan (mis. sayang)" value={form.call} onChange={set('call')} />
        <input className="au-input grow" placeholder="catatan untuk AI (mis. suka dipanggil yang, lagi skripsi)" value={form.notes} onChange={set('notes')} />
        <button className="au-btn primary" type="submit" disabled={!!busy}>Simpan</button>
      </form>
    </div>
  );
}

export default function CommandCenter() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState('');
  const [toasts, setToasts] = useState([]);
  const [thread, setThread] = useState(null);
  const [tick, setTick] = useState(Date.now());
  const fetchedAt = useRef(Date.now());
  const timer = useRef(null);

  const notify = useCallback((kind, text) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api('/overview');
      fetchedAt.current = Date.now();
      setData(r);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // realtime: any change in the journal or the email desk refreshes the screen
  useEffect(() => {
    const close = openStream('/api/command-center/events', {
      onOpen: () => setLive(true),
      onDown: () => setLive(false),
      events: {
        change: () => {
          clearTimeout(timer.current);
          timer.current = setTimeout(load, 350);
        },
      },
    });
    const slow = setInterval(load, 60_000); // clocks, "x minutes ago", server stats
    return () => { close(); clearInterval(slow); clearTimeout(timer.current); };
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const act = useCallback(async (key, fn, ok) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) notify('ok', typeof ok === 'function' ? ok(r) : ok);
      await load();
      return r;
    } catch (e) {
      notify('err', e.message);
      return null;
    } finally {
      setBusy('');
    }
  }, [load, notify]);

  const work = data?.work;
  const email = data?.email;
  const st = work?.status;
  const liveWorked = useMemo(() => {
    if (!st) return 0;
    return st.workedMin + (st.state === 'working' ? (tick - fetchedAt.current) / 60000 : 0);
  }, [st, tick]);

  const today = data ? dateOf(data.now) : null;
  const remToday = work?.reminders.filter((r) => dateOf(r.at) === today) || [];
  const draftCount = (email?.drafts.length || 0) + (email?.batches.reduce((n, b) => n + b.count, 0) || 0);

  return (
    <DashboardLayout>
      <div className="au-page cc-page">
        <div className="au-hero cc-hero">
          <div>
            <h1><span>Pusat</span> kendali</h1>
            <p>Semua yang dikerjakan AI agent-mu dalam satu layar: jam kerja, pengingat, email, kanal, dan server — diperbarui realtime.</p>
          </div>
          <div className="au-row">
            <span className={`au-live ${live ? 'on' : ''}`}><i className="au-dot" /> {live ? 'Realtime aktif' : 'Menyambungkan…'}</span>
            <button className="au-btn sm" onClick={load} title="Muat ulang">Muat ulang</button>
            <button className="au-btn sm primary" disabled={busy === 'brief'} onClick={() => act('brief', () => api('/briefing/send', { method: 'POST' }), 'Briefing dikirim ke Telegram')}>
              Briefing ke Telegram
            </button>
          </div>
        </div>

        {error && <div className="au-alert err">{error}</div>}
        {!data ? <div className="au-card au-empty">Memuat pusat kendali…</div> : (
          <>
            {/* KPIs */}
            <div className="au-grid cols-4">
              <div className="au-card au-stat">
                <div className="k">Jam kerja hari ini</div>
                <div className="v cc-tabular">{fmtMin(liveWorked)}</div>
                <div className="s">
                  <span className={`wl-state ${STATE[st.state]?.[1]}`}><i /> {STATE[st.state]?.[0]}</span>
                  {work.today.targetMin ? ` · ${Math.round((liveWorked / work.today.targetMin) * 100)}% target` : ''}
                </div>
                {work.today.targetMin > 0 && <div className="wl-meter"><i style={{ width: `${Math.min(100, (liveWorked / work.today.targetMin) * 100)}%` }} /></div>}
              </div>
              <div className="au-card au-stat">
                <div className="k">Email perlu kamu balas</div>
                <div className={`v ${email?.awaitingYou.length ? 'cc-hot' : ''}`}>{email?.awaitingYou.length ?? '–'}</div>
                <div className="s">{email ? `${email.awaitingThem.length} menunggu balasan mereka` : 'Email Desk tidak aktif'}</div>
              </div>
              <div className="au-card au-stat">
                <div className="k">Draf menunggu "kirim"</div>
                <div className={`v ${draftCount ? 'cc-hot' : ''}`}>{draftCount}</div>
                <div className="s">{email ? `terkirim hari ini ${email.sentToday}/${email.dailyCap}` : ''}</div>
              </div>
              <div className="au-card au-stat">
                <div className="k">Pengingat hari ini</div>
                <div className="v">{remToday.length}</div>
                <div className="s">{work.reminders[0] ? `berikutnya ${whenOf(work.reminders[0].at)}` : 'tidak ada'}</div>
              </div>
            </div>

            {email && (
              <div className="au-card cc-gap cc-policy">
                <h3><span className="cc-title">Balasan email</span><small>satu pengaturan untuk semua email</small></h3>
                <div className="cc-seg" role="radiogroup" aria-label="Cara membalas email">
                  {POLICY.map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={email.policy?.mode === k}
                      className={`cc-seg-btn ${email.policy?.mode === k ? 'on' : ''} ${k}`}
                      disabled={!!busy}
                      onClick={() => email.policy?.mode !== k && act('policy', () => api('/email/policy', { method: 'POST', body: { mode: k } }),
                        (r) => (k === 'auto' ? `Balas otomatis aktif.${r.answered ? ` ${r.answered} email yang menunggu langsung dibalas.` : ''}` : k === 'approve' ? 'Mode: AI siapkan, kamu konfirmasi.' : 'Mode: hanya kabari.'))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="au-muted cc-policy-note">
                  {POLICY.find(([k]) => k === email.policy?.mode)?.[2]}
                  {email.policy?.mode === 'auto' && ' Newsletter dan email otomatis diabaikan; hal sensitif (uang, kontrak, data pribadi) hanya dijawab "pesan diterima" dan kamu diberi tahu.'}
                  {email.threads.some((t) => t.override) && ` · ${email.threads.filter((t) => t.override).length} percakapan punya pengecualian sendiri (buka Detail untuk mengubah).`}
                </div>
              </div>
            )}

            <CommandIntel api={api} />

            {email && <CloseCircle email={email} busy={busy} act={act} />}

            <div className="au-grid cols-2 cc-gap">
              {/* Action queue */}
              <div className="au-card">
                <h3><span className="cc-title">Perlu tindakan</span><small>{draftCount + (email?.awaitingYou.length || 0)} item</small></h3>
                {!email ? <div className="au-muted">Email Desk belum aktif.</div> : (
                  <div className="au-list">
                    {email.batches.map((b) => (
                      <div key={b.batch} className="au-item">
                        <div>
                          <div className="t">{b.subject} <span className="au-chip brand">email massal · {b.count} penerima</span></div>
                          <div className="m">{b.recipients.join(', ')}{b.count > b.recipients.length ? ', …' : ''}</div>
                        </div>
                        <div className="au-actions">
                          <button className="au-btn sm primary" disabled={!!busy} onClick={() => act(`s${b.firstSeq}`, () => api(`/email/drafts/${b.firstSeq}/send`, { method: 'POST' }), (r) => `Terkirim ${r.batch.sent}/${r.batch.total}`)}>Kirim semua</button>
                          <button className="au-btn sm danger" disabled={!!busy} onClick={() => act(`c${b.firstSeq}`, () => api(`/email/drafts/${b.firstSeq}/cancel`, { method: 'POST' }), 'Dibatalkan')}>Batal</button>
                        </div>
                      </div>
                    ))}
                    {email.drafts.map((d) => (
                      <div key={d.id} className="au-item">
                        <div>
                          <div className="t">#{d.seq} {d.subject} {d.origin !== 'owner' && <span className="au-chip info">{d.origin === 'autoreply' ? 'balasan AI' : d.origin === 'followup' ? 'follow-up' : d.origin}</span>}</div>
                          <div className="m">ke {d.to} · {ago(d.createdAt)}</div>
                          <div className="cc-snippet">{d.snippet}</div>
                        </div>
                        <div className="au-actions">
                          <button className="au-btn sm primary" disabled={!!busy} onClick={() => act(`s${d.id}`, () => api(`/email/drafts/${d.id}/send`, { method: 'POST' }), (r) => (r.dryRun ? 'Disimulasikan (email belum dikonfigurasi)' : 'Terkirim'))}>Kirim</button>
                          <button className="au-btn sm danger" disabled={!!busy} onClick={() => act(`c${d.id}`, () => api(`/email/drafts/${d.id}/cancel`, { method: 'POST' }), 'Draf dibatalkan')}>Batal</button>
                        </div>
                      </div>
                    ))}
                    {email.awaitingYou.map((t) => (
                      <div key={t.id} className="au-item cc-in">
                        <div>
                          <div className="t">{t.counterpart} <span className="au-chip warn">menunggu kamu</span></div>
                          <div className="m">{t.subject} · {ago(t.last.at)}</div>
                          <div className="cc-snippet">«{t.last.snippet}»</div>
                        </div>
                        <div className="au-actions">
                          <button className="au-btn sm" onClick={() => setThread(t)}>Buka</button>
                        </div>
                      </div>
                    ))}
                    {!draftCount && !email.awaitingYou.length && <div className="au-empty"><b>Semua beres</b>Tidak ada draf atau email yang menunggu kamu.</div>}
                  </div>
                )}
              </div>

              {/* Reminders */}
              <RemindersCard reminders={work.reminders} today={today} busy={busy} act={act} />

              {/* Conversations */}
              <div className="au-card">
                <h3><span className="cc-title">Percakapan email</span><small>{email?.threads.length || 0}</small></h3>
                {!email?.threads.length ? <div className="au-muted">Belum ada percakapan. Dari Telegram: "email ke nama@domain.com …".</div> : (
                  <div className="cc-scroll">
                    {email.threads.map((t) => (
                      <div key={t.id} className="wl-row">
                        <div className="grow">
                          <div className="title cc-ellipsis"><b>{t.counterpart}</b> — {t.subject}</div>
                          <div className="muted">
                            {t.last ? (t.last.direction === 'in' ? `dibalas ${ago(t.last.at)}` : `kamu kirim ${ago(t.last.at)}${t.last.auto ? ' (otomatis)' : ''}`) : '—'}
                            {t.followUpAt ? ` · follow-up ${whenOf(t.followUpAt)}` : ''}
                          </div>
                        </div>
                        {t.isSelf && <span className="au-chip">tes / diri sendiri</span>}
                        {!t.isSelf && t.last?.direction === 'in' && <span className="au-chip warn">balas</span>}
                        {t.override && <span className="au-chip info">pengecualian: {t.override === 'auto' ? 'otomatis' : t.override === 'approve' ? 'AI siapkan' : 'kabari'}</span>}
                        {t.autoMode === 'auto' && t.autoCount > 0 && <span className="au-chip brand">dibalas {t.autoCount}x</span>}
                        <button className="au-btn sm" onClick={() => setThread(t)}>Detail</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Activity */}
              <div className="au-card">
                <h3><span className="cc-title">Aktivitas email terbaru</span></h3>
                {!email?.recent.length ? <div className="au-muted">Belum ada aktivitas.</div> : (
                  <div className="cc-timeline">
                    {email.recent.map((m) => (
                      <div key={m.id} className={`cc-ev ${m.direction}`}>
                        <i />
                        <div>
                          <div className="cc-ellipsis"><b>{m.direction === 'in' ? `Dari ${m.counterpart}` : `Ke ${m.counterpart}`}</b>{m.auto ? ' · otomatis' : ''}</div>
                          <div className="au-tiny">{whenOf(m.at)} · {m.subject}</div>
                          <div className="cc-snippet">{m.snippet}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Health */}
              <HealthCard data={data} />

              {/* Week */}
              <div className="au-card">
                <h3><span className="cc-title">7 hari terakhir</span><small>{fmtMin(work.week.summary.workedMin)} · bersih {rp(work.week.summary.net)}</small></h3>
                <WeekBars days={work.week.days} targetMin={work.today.targetMin} />
                <div className="au-tiny cc-sched">Jadwal {work.schedule.workStart}–{work.schedule.workEnd}{work.schedule.breakStart ? `, istirahat ${work.schedule.breakStart}–${work.schedule.breakEnd}` : ''}{work.schedule.autoStart ? ' · mulai otomatis' : ''}</div>
              </div>
            </div>

            {data.briefing && (
              <div className="au-card cc-gap">
                <h3><span className="cc-title">Briefing hari ini</span><small>otomatis tiap pagi hari kerja · /brief di Telegram</small></h3>
                <pre className="cc-brief">{data.briefing}</pre>
              </div>
            )}
          </>
        )}
      </div>

      {thread && <ThreadModal thread={thread} onClose={() => setThread(null)} act={act} busy={busy} />}

      <div className="au-toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`au-toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </DashboardLayout>
  );
}

function RemindersCard({ reminders, today, busy, act }) {
  const [time, setTime] = useState('');
  const [text, setText] = useState('');
  const [date, setDate] = useState(today);
  useEffect(() => { setDate((d) => d || today); }, [today]);

  const add = async (e) => {
    e.preventDefault();
    const r = await act('rem', () => api('/reminders', { method: 'POST', body: { date, time, text } }), 'Pengingat dibuat — dikirim ke Telegram tepat waktu');
    if (r) { setText(''); setTime(''); }
  };

  return (
    <div className="au-card">
      <h3><span className="cc-title">Pengingat</span><small>{reminders.length} aktif</small></h3>
      <form className="cc-remform" onSubmit={add}>
        <input className="au-input" type="date" value={date || ''} onChange={(e) => setDate(e.target.value)} aria-label="Tanggal" />
        <input className="au-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} required aria-label="Jam" />
        <input className="au-input grow" placeholder="Mis. meeting dengan Pak Andi" value={text} onChange={(e) => setText(e.target.value)} required maxLength={300} aria-label="Isi pengingat" />
        <button className="au-btn sm primary" disabled={busy === 'rem'}>Tambah</button>
      </form>
      {!reminders.length ? <div className="au-muted">Tidak ada pengingat. Di Telegram cukup tulis: "ingatkan meeting jam 2 siang".</div> : (
        <div className="cc-scroll">
          {reminders.map((r) => (
            <div key={r.id} className="wl-row">
              <span className={`au-chip ${dateOf(r.at) === today ? 'brand' : ''}`}>{dateOf(r.at) === today ? timeOf(r.at) : whenOf(r.at)}</span>
              <div className="grow cc-ellipsis">{r.text}</div>
              <button className="au-btn sm danger" title="Batalkan" disabled={!!busy} onClick={() => act(`r${r.id}`, () => api(`/reminders/${r.id}`, { method: 'DELETE' }), 'Pengingat dibatalkan')}>Batal</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HealthCard({ data }) {
  const { channels, system } = data;
  const tg = channels.telegram;
  const mail = channels.mail;
  const inbox = channels.inbox;
  const memPct = system.totalMemMb ? Math.round(((system.totalMemMb - system.freeMemMb) / system.totalMemMb) * 100) : 0;
  const rows = [
    ['Telegram bot', tg?.running ? 'ok' : tg?.enabled ? 'warn' : 'err', tg?.running ? `aktif · ${tg.aiChat?.enabled ? 'asisten AI siap' : 'AI nonaktif'}` : tg?.enabled ? 'belum berjalan' : (system.backgroundJobs ? 'tidak dikonfigurasi' : 'dijalankan server lain')],
    ['Kirim email', mail?.mode === 'live' ? 'ok' : 'warn', mail ? (mail.mode === 'live' ? `${mail.provider === 'brevo-api' ? 'Brevo API' : 'SMTP'} · ${mail.from}` : `simulasi — kurang: ${(mail.missing || []).join(', ') || '-'}`) : '—'],
    ['Pantau balasan', inbox?.state === 'watching' ? 'ok' : inbox?.configured ? 'warn' : 'err', inbox ? (inbox.state === 'watching' ? `realtime (IMAP IDLE) · ${inbox.user}${inbox.lastMailAt ? ` · email terakhir ${ago(inbox.lastMailAt)} via ${inbox.lastVia === 'push' ? 'push' : 'pemeriksaan berkala'}` : ''}` : inbox.configured ? `${inbox.state}${inbox.lastError ? ` — ${inbox.lastError}` : ''}` : 'IMAP belum diatur') : '—'],
  ];
  return (
    <div className="au-card">
      <h3><span className="cc-title">Kesehatan sistem</span><small>aktif {uptime(system.uptimeSec)}</small></h3>
      {rows.map(([k, s, v]) => (
        <div key={k} className="wl-row">
          <span className={`au-dot-s ${s === 'ok' ? 'on' : ''} cc-${s}`} />
          <div className="grow"><b>{k}</b><div className="muted">{v}</div></div>
        </div>
      ))}
      <div className="cc-sys">
        <div><span className="au-tiny">RAM server</span><div className="wl-meter"><i style={{ width: `${memPct}%` }} /></div><span className="au-tiny">{memPct}% · proses {system.rssMb} MB</span></div>
        <div><span className="au-tiny">Beban CPU (1/5/15 mnt)</span><div className="cc-load">{system.load.join(' · ')}</div><span className="au-tiny">Node {system.node}</span></div>
      </div>
    </div>
  );
}

function WeekBars({ days, targetMin }) {
  const max = Math.max(targetMin || 0, ...days.map((d) => d.workedMin), 60);
  return (
    <div className="cc-bars">
      {days.map((d) => (
        <div key={d.date} className="cc-bar" title={`${d.date}: ${fmtMin(d.workedMin)} · ${d.tasksDone} tugas`}>
          <div className="cc-bar-track">
            <i style={{ height: `${(d.workedMin / max) * 100}%` }} className={targetMin && d.workedMin >= targetMin ? 'ok' : ''} />
            {targetMin > 0 && <span className="cc-target" style={{ bottom: `${(targetMin / max) * 100}%` }} />}
          </div>
          <span className="au-tiny">{new Date(`${d.date}T12:00:00Z`).toLocaleDateString('id-ID', { weekday: 'short' })}</span>
        </div>
      ))}
    </div>
  );
}

function ThreadModal({ thread, onClose, act, busy }) {
  const [detail, setDetail] = useState(null);
  const [mode, setMode] = useState(thread.override || 'inherit');
  const [instr, setInstr] = useState('');
  const [days, setDays] = useState(3);

  useEffect(() => {
    let alive = true;
    api(`/email/threads/${thread.id}`).then((r) => { if (alive) { setDetail(r); setInstr(r.thread.auto_instructions || ''); } }).catch(() => {});
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { alive = false; window.removeEventListener('keydown', onKey); };
  }, [thread.id, onClose]);

  return (
    <div className="au-modal-bg" onClick={onClose} role="presentation">
      <div className="au-modal cc-modal" role="dialog" aria-modal="true" aria-label={`Percakapan dengan ${thread.counterpart}`} onClick={(e) => e.stopPropagation()}>
        <h3 className="cc-modal-h"><span>{thread.counterpart}<div className="au-tiny">{thread.subject}</div></span><button className="au-btn sm" onClick={onClose}>Tutup</button></h3>
        <div className="cc-msgs">
          {!detail ? <div className="au-muted">Memuat…</div> : detail.messages.map((m) => (
            <div key={m.id} className={`cc-msg ${m.direction}`}>
              <div className="au-tiny">{m.direction === 'in' ? thread.counterpart : 'Kamu'}{m.auto ? ' · otomatis' : ''} · {whenOf(m.at)}</div>
              <div className="cc-msg-body">{m.body}</div>
            </div>
          ))}
        </div>
        <div className="cc-modal-actions">
          <div className="au-field">
            <label className="au-tiny" htmlFor="cc-mode">Saat dia membalas</label>
            <select id="cc-mode" className="au-input" value={mode} onChange={(e) => setMode(e.target.value)}>
              {MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          {mode !== 'notify' && (
            <div className="au-field">
              <label className="au-tiny" htmlFor="cc-instr">Pedoman untuk AI</label>
              <textarea id="cc-instr" className="au-input" rows={2} maxLength={1000} value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="Mis. jawab sopan, bilang saya bebas Jumat jam 14.00, jangan setujui harga" />
            </div>
          )}
          <div className="au-row">
            <button className="au-btn sm primary" disabled={!!busy} onClick={() => act('mode', () => api(`/email/threads/${thread.id}/mode`, { method: 'POST', body: { mode, instructions: instr } }), 'Mode balasan disimpan')}>Simpan mode</button>
            <span className="au-tiny">Follow-up bila tak dibalas</span>
            <input className="au-input cc-days" type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Hari" />
            <button className="au-btn sm" disabled={!!busy} onClick={() => act('fu', () => api(`/email/threads/${thread.id}/followup`, { method: 'POST', body: { days: Number(days) } }), `Diingatkan bila ${days} hari tak dibalas`)}>Pasang</button>
          </div>
        </div>
      </div>
    </div>
  );
}
