/**
 * Worklog — "Jurnal Kerja"
 * by Wisnu Alfian Nur Ashar
 *
 * Live work clock, tasks, money, daily report, evidence from folders/GitHub,
 * analytics (vs previous day, balance, productivity), AI evaluation and the
 * Telegram summary — one realtime page (SSE + a 1-second local ticker).
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import DashboardLayout from './DashboardLayout';
import './automation.css';
import './worklog.css';
import {
  IconPlay, IconPause, IconStop, IconMic, IconRefresh, IconFolder, IconGithub,
  IconSend, IconDownload, IconTrash, IconCheck, IconPlus, IconSparkles, IconClock,
} from './icons';

// ---------------------------------------------------------------- helpers

const TOKEN_KEY = 'automationToken';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };

async function api(path, { method = 'GET', body } = {}, retried = false) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const t = getToken();
  if (t) headers['X-Automation-Token'] = t;
  const res = await fetch(`/api/worklog${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }

  // Akses jaringan butuh AUTOMATION_TOKEN: tanya sekali, simpan, lalu coba lagi.
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
const fmtMin = (m) => {
  const v = Math.max(0, Math.round(m || 0));
  const h = Math.floor(v / 60);
  const mm = v % 60;
  return h ? (mm ? `${h}j ${mm}m` : `${h}j`) : `${mm}m`;
};
const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};
const rp = (n) => `${n < 0 ? '-' : ''}Rp${Math.abs(Math.round(n || 0)).toLocaleString('id-ID')}`;
const timeOf = (ms) => (ms ? new Date(ms).toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—');
const addDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};
const DAY_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const weekdayOf = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const NEXT_LABEL = { break: 'Istirahat otomatis', resume: 'Lanjut kerja otomatis', stop: 'Selesai otomatis' };
const fmtCountdown = (ms) => {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  if (m <= 0) return 'sekarang';
  return m < 60 ? `dalam ${m} menit` : `dalam ${Math.floor(m / 60)}j ${m % 60}m`;
};
const STATE_LABEL = { idle: 'Belum mulai', working: 'Sedang bekerja', break: 'Istirahat', done: 'Selesai' };
const MOODS = ['😫', '😕', '😐', '🙂', '😄'];
const REPORT_TARGET = 300;

function Chip({ kind = '', children }) {
  return <span className={`au-chip ${kind}`}>{children}</span>;
}

function Delta({ pct, suffix = '%' }) {
  if (pct == null) return <span className="d">tidak ada pembanding</span>;
  const up = pct >= 0;
  return <span className={`d ${up ? 'wl-up' : 'wl-down'}`}>{up ? '▲' : '▼'} {Math.abs(pct)}{suffix} vs hari sebelumnya</span>;
}

// -------------------------------------------------------------- the ring

function Ring({ workedMs, targetMin, state }) {
  const R = 80;
  const C = 2 * Math.PI * R;
  const targetMs = (targetMin || 0) * 60_000;
  const ratio = targetMs ? workedMs / targetMs : (workedMs ? 1 : 0);
  const main = Math.min(1, ratio);
  const over = Math.max(0, Math.min(1, ratio - 1));
  return (
    <div className={`wl-ring ${state}`}>
      <svg width="190" height="190" viewBox="0 0 190 190" role="img" aria-label={`Kerja ${Math.round(ratio * 100)}% dari target`}>
        <defs>
          <linearGradient id="wl-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ff9800" />
            <stop offset="100%" stopColor="#ff6b00" />
          </linearGradient>
        </defs>
        <circle className="track" cx="95" cy="95" r={R} fill="none" strokeWidth="14" />
        <circle className="bar" cx="95" cy="95" r={R} fill="none" strokeWidth="14" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - main)} />
        {over > 0 && (
          <circle className="over" cx="95" cy="95" r={R - 18} fill="none" strokeWidth="6" strokeLinecap="round"
            strokeDasharray={2 * Math.PI * (R - 18)} strokeDashoffset={2 * Math.PI * (R - 18) * (1 - over)} />
        )}
      </svg>
      <div className="center">
        <div className="time">{fmtClock(workedMs)}</div>
        <div className="sub">{targetMin ? `${Math.round(ratio * 100)}% dari ${fmtMin(targetMin)}` : 'tanpa target'}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ dictation

function useDictation(onText) {
  const recRef = useRef(null);
  const [on, setOn] = useState(false);
  const supported = typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  const toggle = useCallback(() => {
    if (!supported) return;
    if (on) { recRef.current?.stop(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = 'id-ID';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let txt = '';
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) txt += e.results[i][0].transcript;
      if (txt.trim()) onText(txt.trim());
    };
    rec.onend = () => setOn(false);
    rec.onerror = () => setOn(false);
    recRef.current = rec;
    rec.start();
    setOn(true);
  }, [on, onText, supported]);

  useEffect(() => () => recRef.current?.stop(), []);
  return { on, toggle, supported };
}

// ================================================================= TODAY

function TodayTab({ data, date, setDate, today, notify, refresh, liveWorkedMs }) {
  const d = data.day;
  const status = data.status;
  const isToday = date === today;
  const [busy, setBusy] = useState('');

  // quick log
  const [quick, setQuick] = useState('');
  const [proposal, setProposal] = useState(null);
  const dict = useDictation(useCallback((t) => setQuick((q) => (q ? `${q}, ${t}` : t)), []));

  // forms
  const [taskTitle, setTaskTitle] = useState('');
  const [fin, setFin] = useState({ type: 'expense', amount: '', note: '' });
  const [report, setReport] = useState(d.reportText || '');
  const [mood, setMood] = useState(d.mood);
  const [seg, setSeg] = useState({ kind: 'work', start: d.settings.workStart || '09:00', end: d.settings.workEnd || '17:00' });
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetAll, setResetAll] = useState(false);

  useEffect(() => { setReport(d.reportText || ''); setMood(d.mood); }, [d.date, d.reportText, d.mood]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) notify('ok', typeof ok === 'function' ? ok(r) : ok);
      await refresh();
      return r;
    } catch (e) {
      notify('err', e.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  const clock = (action, msg) => run(action, () => api(`/clock/${action}`, { method: 'POST' }), msg);

  const parse = async () => {
    if (!quick.trim()) return;
    setBusy('parse');
    try {
      const r = await api('/parse', { method: 'POST', body: { text: quick } });
      setProposal(r);
    } catch (e) {
      notify('err', e.message);
    } finally {
      setBusy('');
    }
  };

  const applyProposal = () => run('apply', () => api('/apply', { method: 'POST', body: { date, proposal: proposal.proposal } }), (r) => {
    setQuick(''); setProposal(null);
    const s = r.saved;
    return `Tersimpan: ${s.tasks} tugas, ${s.finance} catatan uang, ${s.segments} jam${s.report ? ', laporan' : ''}.`;
  });

  const p = proposal?.proposal;
  const reportLen = report.trim().length;
  const balanceKind = { ok: 'ok', warn: 'warn', bad: 'bad', idle: '' }[d.balance.level] || '';

  return (
    <>
      {/* ------------------------------------------------ date navigator */}
      <div className="au-row between" style={{ marginBottom: '1rem' }}>
        <div className="wl-daynav">
          <button className="au-btn sm" onClick={() => setDate(addDays(date, -1))}>‹</button>
          <input className="au-input" type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="au-btn sm" disabled={date >= today} onClick={() => setDate(addDays(date, 1))}>›</button>
          {!isToday && <button className="au-btn sm" onClick={() => setDate(today)}>Hari ini</button>}
        </div>
        <div className="au-muted">{d.label}{!d.isWorkday && ' · hari libur'}</div>
      </div>

      {/* ------------------------------------------------------- hero */}
      <div className="au-card wl-hero">
        <Ring workedMs={isToday ? liveWorkedMs : d.workedMin * 60_000} targetMin={d.targetMin} state={isToday ? status.state : 'done'} />
        <div style={{ position: 'relative', minWidth: 0 }}>
          <div className={`wl-state ${isToday ? status.state : 'done'}`}><i /> {isToday ? STATE_LABEL[status.state] : 'Riwayat'}</div>
          <h2 style={{ margin: '0.35rem 0 0.2rem', fontSize: '1.35rem' }}>{d.verdict.text}</h2>
          <div className="au-muted">
            Jadwal {d.settings.workStart}–{d.settings.workEnd}
            {d.settings.breakStart && d.settings.breakEnd && ` · istirahat ${d.settings.breakStart}–${d.settings.breakEnd}`}
            {' · '}target {fmtMin(d.targetMin)}{d.settings.targetHoursAuto ? ' (dari jadwal)' : ''}
            {d.firstStart && ` · mulai ${timeOf(d.firstStart)}`}
            {isToday && status.state === 'working' && status.openSince && ` · sesi berjalan sejak ${timeOf(status.openSince)}`}
          </div>
          {isToday && status.next && (
            <div className="wl-next">
              <IconClock size={15} />
              {NEXT_LABEL[status.next.kind]} pukul {timeOf(status.next.at)}
              <b>{fmtCountdown(status.next.at - Date.now())}</b>
            </div>
          )}
          {isToday && !status.next && status.state === 'idle' && d.settings.followSchedule && (
            <div className="wl-next muted"><IconClock size={15} /> Tekan Mulai — istirahat, lanjut, dan selesai akan berjalan otomatis sesuai jadwal.</div>
          )}
          {isToday && (
            <div className="wl-actions">
              {(status.state === 'idle' || status.state === 'done') && (
                <button className="au-btn primary wl-big" disabled={busy === 'start'} onClick={() => clock('start', 'Mulai bekerja. Semangat!')}>
                  <IconPlay size={18} /> {status.state === 'done' ? 'Lanjut bekerja' : 'Mulai kerja'}
                </button>
              )}
              {status.state === 'working' && (
                <button className="au-btn wl-big" disabled={busy === 'pause'} onClick={() => clock('pause', 'Istirahat dimulai.')}>
                  <IconPause size={18} /> Istirahat
                </button>
              )}
              {status.state === 'break' && (
                <button className="au-btn primary wl-big" disabled={busy === 'resume'} onClick={() => clock('resume', 'Kembali bekerja.')}>
                  <IconPlay size={18} /> Lanjut kerja
                </button>
              )}
              {(status.state === 'working' || status.state === 'break') && (
                <button className="au-btn wl-big" disabled={busy === 'stop'} onClick={() => clock('stop', 'Selesai bekerja. Lihat evaluasi di bawah.')}>
                  <IconStop size={18} /> Selesai
                </button>
              )}
            </div>
          )}
          {d.segments.length > 0 && (
            <div style={{ marginTop: '0.6rem' }}>
              <button className="au-btn sm danger" onClick={() => setConfirmReset(true)}><IconTrash size={14} /> Reset hari ini</button>
            </div>
          )}
        </div>
      </div>

      {/* -------------------------------------------------------- KPIs */}
      <div className="wl-kpis">
        <div className="au-card au-stat wl-kpi">
          <div className="k">Jam kerja</div>
          <div className="v">{fmtMin(isToday ? liveWorkedMs / 60_000 : d.workedMin)}</div>
          <Delta pct={d.comparison.workedPct} />
        </div>
        <div className="au-card au-stat wl-kpi">
          <div className="k">Istirahat</div>
          <div className="v">{fmtMin(d.breakMin)}</div>
          <div className="d">{d.workedMin >= 360 && d.breakMin < 30 ? 'kurang dari 30 menit' : 'sehat'}</div>
        </div>
        <div className="au-card au-stat wl-kpi">
          <div className="k">Tugas</div>
          <div className="v">{d.tasks.done}<span className="au-muted" style={{ fontSize: '1rem' }}>/{d.tasks.total}</span></div>
          <div className="d">{d.comparison.tasksDelta != null ? `${d.comparison.tasksDelta >= 0 ? '+' : ''}${d.comparison.tasksDelta} vs sebelumnya` : 'selesai hari ini'}</div>
        </div>
        <div className="au-card au-stat wl-kpi">
          <div className="k">Uang bersih</div>
          <div className={`v ${d.money.net < 0 ? 'wl-down' : ''}`}>{rp(d.money.net)}</div>
          <div className="d">+{rp(d.money.income)} / -{rp(d.money.expense)}</div>
        </div>
        <div className="au-card au-stat wl-kpi">
          <div className="k">Produktivitas</div>
          <div className="v">{d.productivity}<span className="au-muted" style={{ fontSize: '1rem' }}>/100</span></div>
          <div className="wl-meter"><i style={{ width: `${d.productivity}%` }} /></div>
        </div>
        <div className="au-card au-stat wl-kpi">
          <div className="k">Keseimbangan</div>
          <div className="v" style={{ fontSize: '1.15rem' }}>{d.balance.label}</div>
          <div className={`wl-meter ${balanceKind}`}><i style={{ width: `${d.balance.score}%` }} /></div>
        </div>
      </div>

      <div className="au-grid cols-2" style={{ marginTop: '1rem' }}>
        {/* ------------------------------------------------ quick log */}
        <div className="au-card">
          <h3>Catat cepat <small>ketik atau ucapkan — AI yang merapikan</small></h3>
          <div className="wl-quick">
            <textarea
              className="au-textarea" value={quick} onChange={(e) => { setQuick(e.target.value); setProposal(null); }}
              placeholder="mis. kerja 9-17, istirahat 12-13, selesai fitur login, meeting klien, makan siang 25rb, bayaran proyek 1,5jt"
              style={{ paddingRight: '3.2rem' }}
            />
            {dict.supported && (
              <button type="button" className={`wl-mic ${dict.on ? 'on' : ''}`} onClick={dict.toggle} title={dict.on ? 'Berhenti merekam' : 'Dikte dengan suara'} aria-pressed={dict.on}>
                <IconMic size={18} />
              </button>
            )}
          </div>
          <div className="au-row" style={{ marginTop: '0.6rem' }}>
            <button className="au-btn primary" disabled={!quick.trim() || busy === 'parse'} onClick={parse}>
              {busy === 'parse' ? <span className="au-spin" /> : <IconSparkles size={16} />} Proses
            </button>
            <span className="au-tiny">Belum disimpan sampai Anda menekan Simpan.</span>
          </div>
          {p && (
            <div className="wl-proposal">
              <div className="au-row between">
                <b style={{ fontSize: '0.88rem' }}>Akan disimpan ke {date}</b>
                <Chip kind="info">{proposal.engine === 'ai' ? `AI${proposal.model ? ` · ${proposal.model.split('/').pop()}` : ''}` : 'tanpa AI'}</Chip>
              </div>
              <ul>
                {p.work.map((w, i) => <li key={`w${i}`}>Kerja {w.start}–{w.end}</li>)}
                {p.breaks.map((b, i) => <li key={`b${i}`}>Istirahat {b.start}–{b.end}</li>)}
                {p.tasks.map((t, i) => <li key={`t${i}`}>Tugas: {t.title}{t.done ? ' ✓' : ''}</li>)}
                {p.finance.map((f, i) => <li key={`f${i}`}>{f.type === 'income' ? 'Pemasukan' : 'Pengeluaran'} {rp(f.amount)} · {f.category}</li>)}
                {p.report && <li>Laporan: {p.report}</li>}
                {!p.work.length && !p.breaks.length && !p.tasks.length && !p.finance.length && !p.report && <li>Tidak ada yang bisa dicatat.</li>}
              </ul>
              <div className="au-row">
                <button className="au-btn primary sm" disabled={busy === 'apply'} onClick={applyProposal}><IconCheck size={15} /> Simpan</button>
                <button className="au-btn sm" onClick={() => setProposal(null)}>Batal</button>
              </div>
            </div>
          )}
        </div>

        {/* ------------------------------------------------- evaluation */}
        <div className="au-card">
          <h3>
            Evaluasi
            <small><Chip kind={balanceKind}>{d.balance.score}/100</Chip></small>
          </h3>
          {d.balance.checks.map((c) => (
            <div key={c.id} className={`wl-check-item ${c.level}`}><b />{c.message}</div>
          ))}
          {d.evaluation ? (
            <div className="au-pre" style={{ marginTop: '0.7rem' }}>{d.evaluation}</div>
          ) : (
            <div className="au-tiny" style={{ marginTop: '0.6rem' }}>Belum ada evaluasi AI untuk hari ini.</div>
          )}
          <div className="au-row" style={{ marginTop: '0.75rem' }}>
            <button className="au-btn" disabled={busy === 'eval'} onClick={() => run('eval', () => api(`/evaluate/${date}`, { method: 'POST' }), 'Evaluasi diperbarui.')}>
              {busy === 'eval' ? <span className="au-spin" /> : <IconSparkles size={16} />} Evaluasi dengan AI
            </button>
            {data.telegram.connected && (
              <button className="au-btn" disabled={busy === 'tg'} onClick={() => run('tg', () => api('/telegram/send', { method: 'POST', body: { date } }), 'Ringkasan dikirim ke Telegram.')}>
                {busy === 'tg' ? <span className="au-spin" /> : <IconSend size={16} />} Kirim ke Telegram
              </button>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------ tasks */}
        <div className="au-card">
          <h3>Yang dikerjakan <small>{d.tasks.done}/{d.tasks.total} selesai</small></h3>
          <form className="au-row" style={{ flexWrap: 'nowrap', marginBottom: '0.5rem' }} onSubmit={(e) => {
            e.preventDefault();
            if (!taskTitle.trim()) return;
            run('task', () => api('/tasks', { method: 'POST', body: { date, title: taskTitle, done: true } })).then(() => setTaskTitle(''));
          }}>
            <input className="au-input" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="mis. Perbaiki bug pembayaran" />
            <button className="au-btn" disabled={!taskTitle.trim()}><IconPlus size={16} /></button>
          </form>
          {d.taskList.length === 0 && <div className="au-tiny">Belum ada tugas tercatat.</div>}
          {d.taskList.map((t) => (
            <div key={t.id} className={`wl-row ${t.done ? 'done' : ''}`}>
              <button className={`wl-check ${t.done ? 'on' : ''}`} aria-label={t.done ? 'Tandai belum' : 'Tandai selesai'}
                onClick={() => run(`t${t.id}`, () => api(`/tasks/${t.id}`, { method: 'PATCH', body: { done: !t.done } }))}>
                {t.done ? <IconCheck size={14} /> : null}
              </button>
              <div className="grow"><div className="title">{t.title}</div></div>
              <button className="wl-icon-btn" aria-label="Hapus tugas" onClick={() => run(`d${t.id}`, () => api(`/tasks/${t.id}`, { method: 'DELETE' }))}><IconTrash size={16} /></button>
            </div>
          ))}
        </div>

        {/* ---------------------------------------------------- finance */}
        <div className="au-card">
          <h3>Keuangan <small>{rp(d.money.net)} bersih</small></h3>
          <form className="au-row" style={{ marginBottom: '0.5rem' }} onSubmit={(e) => {
            e.preventDefault();
            run('fin', () => api('/finance', { method: 'POST', body: { date, ...fin } }), 'Dicatat.').then((r) => r && setFin({ ...fin, amount: '', note: '' }));
          }}>
            <select className="au-select" style={{ width: 'auto' }} value={fin.type} onChange={(e) => setFin({ ...fin, type: e.target.value })}>
              <option value="expense">Pengeluaran</option>
              <option value="income">Pemasukan</option>
            </select>
            <input className="au-input" style={{ flex: '1 1 110px', width: 'auto' }} value={fin.amount} onChange={(e) => setFin({ ...fin, amount: e.target.value })} placeholder="25rb / 1,5jt" />
            <input className="au-input" style={{ flex: '2 1 140px', width: 'auto' }} value={fin.note} onChange={(e) => setFin({ ...fin, note: e.target.value })} placeholder="keterangan" />
            <button className="au-btn" disabled={!fin.amount.trim()}><IconPlus size={16} /></button>
          </form>
          {d.financeList.length === 0 && <div className="au-tiny">Belum ada catatan uang.</div>}
          {d.financeList.map((f) => (
            <div key={f.id} className="wl-row">
              <Chip kind={f.type === 'income' ? 'ok' : 'warn'}>{f.type === 'income' ? 'masuk' : 'keluar'}</Chip>
              <div className="grow">
                <div className="title">{f.note || f.category}</div>
                <div className="muted">{f.category}</div>
              </div>
              <span className={`wl-amount ${f.type === 'income' ? 'wl-up' : ''}`}>{f.type === 'income' ? '+' : '-'}{rp(f.amount)}</span>
              <button className="wl-icon-btn" aria-label="Hapus" onClick={() => run(`f${f.id}`, () => api(`/finance/${f.id}?date=${date}`, { method: 'DELETE' }))}><IconTrash size={16} /></button>
            </div>
          ))}
        </div>

        {/* ----------------------------------------------------- report */}
        <div className="au-card">
          <h3>
            Laporan harian
            <small className={`wl-counter ${reportLen > REPORT_TARGET ? 'over' : ''}`}>{reportLen}/{REPORT_TARGET}</small>
          </h3>
          <textarea className="au-textarea" value={report} maxLength={600} onChange={(e) => setReport(e.target.value)}
            placeholder="Apa yang Anda kerjakan hari ini, hambatan, dan rencana besok (±300 karakter)." />
          <div className="au-row between" style={{ marginTop: '0.6rem' }}>
            <div className="wl-moods" role="radiogroup" aria-label="Mood hari ini">
              {MOODS.map((m, i) => (
                <button key={m} type="button" role="radio" aria-checked={mood === i + 1} className={`wl-mood ${mood === i + 1 ? 'on' : ''}`} onClick={() => setMood(i + 1)}>{m}</button>
              ))}
            </div>
            <button className="au-btn primary" disabled={busy === 'report'}
              onClick={() => run('report', () => api(`/report/${date}`, { method: 'PUT', body: { text: report, mood } }), 'Laporan disimpan.')}>
              Simpan laporan
            </button>
          </div>
        </div>

        {/* --------------------------------------------------- activity */}
        <div className="au-card">
          <h3>
            Bukti aktivitas
            <small>
              <button className="au-btn sm" disabled={busy === 'act'} onClick={() => run('act', () => api(`/activity/${date}/refresh`, { method: 'POST' }), 'Aktivitas diperbarui.')}>
                {busy === 'act' ? <span className="au-spin" /> : <IconRefresh size={14} />} Segarkan
              </button>
            </small>
          </h3>
          {!d.activityDetail ? (
            <div className="au-tiny">Belum dipindai. Hubungkan folder/GitHub di tab <b>Sumber data</b>, lalu tekan Segarkan.</div>
          ) : (
            <>
              <div className="au-row" style={{ gap: '0.4rem', marginBottom: '0.5rem' }}>
                <Chip kind="brand">{d.activity.commits} commit</Chip>
                <Chip kind="info">{d.activity.filesChanged} file diubah</Chip>
                {d.activityDetail.github && <Chip>{d.activityDetail.github.prs || 0} PR</Chip>}
              </div>
              {(d.activityDetail.repos || []).map((r) => (
                <div key={r.repo} className="wl-row">
                  <IconGithub size={16} />
                  <div className="grow"><div className="title">{r.name}</div><div className="muted">{r.messages.slice(0, 3).map((m) => m.subject).join(' · ')}</div></div>
                  <Chip>{r.commits}</Chip>
                </div>
              ))}
              {(d.activityDetail.folders || []).filter((f) => f.filesChanged).map((f) => (
                <div key={f.path} className="wl-row">
                  <IconFolder size={16} />
                  <div className="grow"><div className="title">{f.label}</div><div className="muted">{Object.entries(f.byExt).map(([k, v]) => `${k} ${v}`).join(' · ')}{f.truncated ? ' · (dipotong)' : ''}</div></div>
                  <Chip>{f.filesChanged}</Chip>
                </div>
              ))}
              {(d.activityDetail.github?.events || []).slice(0, 5).map((e, i) => (
                <div key={i} className="wl-row">
                  <IconGithub size={16} />
                  <div className="grow"><div className="title">{e.repo}</div><div className="muted">{e.summary} · {timeOf(e.at)}</div></div>
                </div>
              ))}
              {(d.activityDetail.errors || []).length > 0 && <div className="au-alert warn" style={{ marginTop: '0.5rem' }}>{d.activityDetail.errors.slice(0, 3).join(' · ')}</div>}
            </>
          )}
        </div>

        {/* --------------------------------------------------- segments */}
        <div className="au-card">
          <h3>Sesi kerja & istirahat <small>{d.segments.length}</small></h3>
          <form className="au-row" style={{ marginBottom: '0.5rem' }} onSubmit={(e) => {
            e.preventDefault();
            run('seg', () => api('/segments', { method: 'POST', body: { date, ...seg } }), 'Sesi ditambahkan.');
          }}>
            <select className="au-select" style={{ width: 'auto' }} value={seg.kind} onChange={(e) => setSeg({ ...seg, kind: e.target.value })}>
              <option value="work">Kerja</option>
              <option value="break">Istirahat</option>
            </select>
            <input className="au-input" style={{ width: 'auto' }} type="time" value={seg.start} onChange={(e) => setSeg({ ...seg, start: e.target.value })} />
            <span className="au-muted">–</span>
            <input className="au-input" style={{ width: 'auto' }} type="time" value={seg.end} onChange={(e) => setSeg({ ...seg, end: e.target.value })} />
            <button className="au-btn"><IconPlus size={16} /></button>
          </form>
          {d.segments.length === 0 && <div className="au-tiny">Belum ada sesi. Pakai tombol Mulai kerja, atau tambahkan manual.</div>}
          {d.segments.map((s) => (
            <div key={s.id} className="wl-row">
              <Chip kind={s.kind === 'work' ? 'brand' : 'warn'}>{s.kind === 'work' ? 'kerja' : 'istirahat'}</Chip>
              <div className="grow"><div className="title">{timeOf(s.start_at)} – {s.end_at ? timeOf(s.end_at) : 'sekarang'}</div><div className="muted">{s.source}</div></div>
              <button className="wl-icon-btn" aria-label="Hapus sesi" onClick={() => run(`s${s.id}`, () => api(`/segments/${s.id}`, { method: 'DELETE' }))}><IconTrash size={16} /></button>
            </div>
          ))}
        </div>
      </div>

      {confirmReset && (
        <div className="au-modal-bg" role="dialog" aria-modal="true" onClick={() => setConfirmReset(false)}>
          <div className="au-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reset {d.label}?</h3>
            <div className="au-muted" style={{ marginBottom: '0.8rem' }}>
              Semua sesi kerja & istirahat tanggal ini ({d.segments.length} sesi, {fmtMin(d.workedMin)}) akan dihapus. Ini tidak bisa dibatalkan.
            </div>
            <label className="au-check" style={{ marginBottom: '1rem' }}>
              <input type="checkbox" checked={resetAll} onChange={(e) => setResetAll(e.target.checked)} />
              <span>Hapus juga tugas, keuangan, dan laporan tanggal ini</span>
            </label>
            <div className="au-row" style={{ justifyContent: 'flex-end' }}>
              <button className="au-btn" onClick={() => setConfirmReset(false)}>Batal</button>
              <button className="au-btn danger" disabled={busy === 'reset'} onClick={() => run('reset',
                () => api(`/days/${date}/reset`, { method: 'POST', body: { tasks: resetAll, finance: resetAll, report: resetAll } }),
                (r) => { setConfirmReset(false); setResetAll(false); return `Dihapus: ${r.removed.segments} sesi${resetAll ? `, ${r.removed.tasks} tugas, ${r.removed.finance} catatan uang` : ''}.`; })}>
                {busy === 'reset' && <span className="au-spin" />} Ya, reset
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ================================================================= TRENDS

function TrendsTab({ data, today, notify }) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const [m, setM] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    api(`/month/${month}`).then(setM).catch((e) => notify('err', e.message));
  }, [month, notify, data]);
  useEffect(() => { api('/history?limit=30').then((r) => setHistory(r.days)).catch(() => {}); }, [data]);

  const week = data.week;
  const maxMin = Math.max(60, ...week.days.map((d) => Math.max(d.workedMin, d.targetMin)));
  const ws = week.summary;

  return (
    <>
      <div className="au-card">
        <h3>7 hari terakhir <small>{fmtMin(ws.workedMin)}{ws.targetMin ? ` · ${Math.round((ws.achievement || 0) * 100)}% target` : ''}</small></h3>
        <div className="wl-bars" role="img" aria-label="Jam kerja tujuh hari terakhir">
          {week.days.map((d, i) => {
            const h = (d.workedMin / maxMin) * 100;
            const cls = !d.workedMin ? 'none' : (d.targetMin && d.workedMin < d.targetMin * 0.9 ? 'under' : '');
            return (
              <div className="wl-bar" key={d.date} title={`${d.date}: ${fmtMin(d.workedMin)}`}>
                <div className="val">{d.workedMin ? fmtMin(d.workedMin) : ''}</div>
                <div className={`col ${cls}`} style={{ height: `${Math.max(2, h)}%`, animationDelay: `${i * 60}ms` }}>
                  {d.targetMin > 0 && <span className="tgt" style={{ bottom: `${(d.targetMin / Math.max(d.workedMin, 1)) * 100}%`, display: d.workedMin ? 'block' : 'none' }} />}
                </div>
                <div className="lbl">{DAY_SHORT[weekdayOf(d.date)]} {d.date.slice(8)}</div>
              </div>
            );
          })}
        </div>
        <div className="au-row" style={{ gap: '0.4rem', marginTop: '0.8rem' }}>
          <Chip>rata-rata {fmtMin(ws.avgWorkedMin)}/hari aktif</Chip>
          <Chip kind="ok">{ws.tasksDone} tugas</Chip>
          <Chip kind="brand">{ws.commits} commit</Chip>
          <Chip kind={ws.net < 0 ? 'err' : 'ok'}>bersih {rp(ws.net)}</Chip>
          <Chip kind="info">keseimbangan {ws.avgBalance}/100</Chip>
        </div>
      </div>

      <div className="au-grid cols-2" style={{ marginTop: '1rem' }}>
        <div className="au-card">
          <h3>
            Bulan
            <small className="au-row" style={{ gap: '0.4rem' }}>
              <input className="au-input" type="month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ width: 'auto' }} />
              <a className="au-btn sm" href={`/api/worklog/export.csv?from=${month}-01&to=${m?.to || `${month}-28`}`} download><IconDownload size={14} /> CSV</a>
            </small>
          </h3>
          {!m ? <div className="au-muted">Memuat…</div> : (
            <>
              <div className="wl-kpis" style={{ marginTop: 0 }}>
                <div className="wl-kpi"><div className="k">Jam kerja</div><div className="v">{fmtMin(m.summary.workedMin)}</div><div className="d">{m.summary.activeDays} hari aktif</div></div>
                <div className="wl-kpi"><div className="k">Pemasukan</div><div className="v wl-up">{rp(m.summary.income)}</div>
                  {m.summary.incomeTarget > 0 && <div className="wl-meter ok"><i style={{ width: `${Math.min(100, (m.summary.incomeProgress || 0) * 100)}%` }} /></div>}
                </div>
                <div className="wl-kpi"><div className="k">Pengeluaran</div><div className="v">{rp(m.summary.expense)}</div><div className="d">bersih {rp(m.summary.net)}</div></div>
              </div>
              {m.expenseByCategory.length > 0 && <b style={{ fontSize: '0.85rem', display: 'block', marginTop: '0.9rem' }}>Pengeluaran per kategori</b>}
              {m.expenseByCategory.map((c) => (
                <div className="wl-cat" key={c.category}>
                  <span>{c.category}</span>
                  <span className="track"><i style={{ width: `${(c.amount / m.expenseByCategory[0].amount) * 100}%` }} /></span>
                  <span className="wl-amount">{rp(c.amount)}</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="au-card">
          <h3>Riwayat laporan <small>{history.length} hari</small></h3>
          {history.length === 0 && <div className="au-tiny">Belum ada riwayat.</div>}
          {history.map((h) => (
            <div key={h.date} className="wl-row">
              <div className="grow">
                <div className="title">{h.date} · {fmtMin(h.workedMin)} · {h.tasksDone} tugas</div>
                <div className="muted">{h.report || '— tanpa laporan —'}</div>
              </div>
              <span className={`wl-amount ${h.net < 0 ? 'wl-down' : ''}`} style={{ fontSize: '0.8rem' }}>{h.net ? rp(h.net) : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ================================================================ SOURCES

function SourcesTab({ data, notify, refresh }) {
  const s = data.settings.sources;
  const [folder, setFolder] = useState({ path: '', label: '' });
  const [gh, setGh] = useState({ username: s.github.username || '', repos: (s.github.repos || []).join(', ') });
  const [author, setAuthor] = useState(s.gitAuthor || '');
  const [busy, setBusy] = useState(false);

  const act = async (fn, ok) => {
    setBusy(true);
    try { await fn(); notify('ok', ok); await refresh(); } catch (e) { notify('err', e.message); } finally { setBusy(false); }
  };

  return (
    <div className="au-grid cols-2">
      <div className="au-card">
        <h3><span className="au-row" style={{ gap: '0.4rem' }}><IconFolder size={18} /> Folder & SSD</span> <small>{s.folders.length}/20</small></h3>
        <div className="au-muted" style={{ marginBottom: '0.6rem' }}>
          Hubungkan folder proyek atau drive (mis. <code>D:\Proyek</code>). Sistem hanya membaca <b>nama & waktu ubah file</b> — tidak membaca isi file — dan <b>git log</b> dari repo di dalamnya.
        </div>
        <form className="au-row" style={{ marginBottom: '0.6rem' }} onSubmit={(e) => {
          e.preventDefault();
          act(() => api('/sources/folders', { method: 'POST', body: folder }), 'Folder terhubung.').then(() => setFolder({ path: '', label: '' }));
        }}>
          <input className="au-input" style={{ flex: '2 1 200px', width: 'auto' }} value={folder.path} onChange={(e) => setFolder({ ...folder, path: e.target.value })} placeholder="D:\Proyek atau C:\Users\Anda\Documents\kode" />
          <input className="au-input" style={{ flex: '1 1 110px', width: 'auto' }} value={folder.label} onChange={(e) => setFolder({ ...folder, label: e.target.value })} placeholder="label (opsional)" />
          <button className="au-btn primary" disabled={busy || !folder.path.trim()}><IconPlus size={16} /> Hubungkan</button>
        </form>
        {s.folders.length === 0 && <div className="au-tiny">Belum ada folder terhubung.</div>}
        {s.folders.map((f) => (
          <div key={f.path} className="wl-row">
            <IconFolder size={16} />
            <div className="grow"><div className="title">{f.label || f.path}</div><div className="muted">{f.path}</div></div>
            <button className="wl-icon-btn" aria-label="Putuskan" onClick={() => act(() => api('/sources/folders', { method: 'DELETE', body: { path: f.path } }), 'Folder diputus.')}><IconTrash size={16} /></button>
          </div>
        ))}
        <div className="au-field" style={{ marginTop: '0.9rem' }}>
          <label>Filter penulis commit (opsional)</label>
          <div className="au-row" style={{ flexWrap: 'nowrap' }}>
            <input className="au-input" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="email atau nama git Anda" />
            <button className="au-btn" disabled={busy} onClick={() => act(() => api('/settings', { method: 'PUT', body: { sources: { gitAuthor: author } } }), 'Disimpan.')}>Simpan</button>
          </div>
        </div>
      </div>

      <div className="au-card">
        <h3><span className="au-row" style={{ gap: '0.4rem' }}><IconGithub size={18} /> GitHub</span> <small>{data.github.tokenConfigured ? 'token: ada' : 'tanpa token'}</small></h3>
        <div className="au-muted" style={{ marginBottom: '0.6rem' }}>
          Menghitung push, commit, PR, dan issue Anda per hari. Tanpa token hanya aktivitas publik (60 request/jam).
          Untuk repo privat isi <code>GITHUB_TOKEN</code> di <b>.env</b> (token hanya-baca) lalu restart.
        </div>
        <div className="au-field">
          <label>Username GitHub</label>
          <input className="au-input" value={gh.username} onChange={(e) => setGh({ ...gh, username: e.target.value })} placeholder="mis. wi5nuu" />
        </div>
        <div className="au-field">
          <label>Batasi ke repo (opsional)</label>
          <input className="au-input" value={gh.repos} onChange={(e) => setGh({ ...gh, repos: e.target.value })} placeholder="wi5nuu/WANAR-AI, wi5nuu/portfolio" />
        </div>
        <button className="au-btn primary" disabled={busy} onClick={() => act(() => api('/settings', { method: 'PUT', body: { sources: { github: { username: gh.username.trim(), repos: gh.repos } } } }), 'GitHub tersimpan.')}>
          Simpan
        </button>
      </div>
    </div>
  );
}

// =============================================================== SETTINGS

function SettingsTab({ data, notify, refresh }) {
  const s = data.settings;
  const [f, setF] = useState({
    workStart: s.workStart, workEnd: s.workEnd, breakStart: s.breakStart || '', breakEnd: s.breakEnd || '',
    targetAuto: s.targetHoursAuto, targetHours: s.targetHours,
    followSchedule: s.followSchedule, autoStop: s.autoStop, autoStart: s.autoStart,
    workdays: s.workdays, hourlyRate: s.hourlyRate || '', monthlyIncomeTarget: s.monthlyIncomeTarget || '',
    telegram: { ...s.telegram },
  });
  const [busy, setBusy] = useState(false);
  const suggested = useMemo(() => {
    const m = (t) => { const [h, mm] = String(t || '0:0').split(':').map(Number); return h * 60 + mm; };
    const brk = f.breakStart && f.breakEnd ? Math.max(0, Math.min(m(f.workEnd), m(f.breakEnd)) - Math.max(m(f.workStart), m(f.breakStart))) : 0;
    return Math.max(0, (m(f.workEnd) - m(f.workStart) - brk) / 60);
  }, [f.workStart, f.workEnd, f.breakStart, f.breakEnd]);

  const save = async () => {
    setBusy(true);
    try {
      await api('/settings', {
        method: 'PUT',
        body: {
          ...f,
          targetAuto: undefined,
          targetHours: f.targetAuto ? null : Number(f.targetHours),
          hourlyRate: f.hourlyRate === '' ? 0 : f.hourlyRate, monthlyIncomeTarget: f.monthlyIncomeTarget === '' ? 0 : f.monthlyIncomeTarget,
        },
      });
      notify('ok', 'Pengaturan disimpan.');
      await refresh();
    } catch (e) { notify('err', e.message); } finally { setBusy(false); }
  };

  const toggleDay = (d) => setF((x) => ({ ...x, workdays: x.workdays.includes(d) ? x.workdays.filter((y) => y !== d) : [...x.workdays, d].sort() }));

  return (
    <div className="au-grid cols-2">
      <div className="au-card">
        <h3>Jam kerja</h3>
        <div className="au-split">
          <div className="au-field"><label>Mulai</label><input className="au-input" type="time" value={f.workStart} onChange={(e) => setF({ ...f, workStart: e.target.value })} /></div>
          <div className="au-field"><label>Selesai</label><input className="au-input" type="time" value={f.workEnd} onChange={(e) => setF({ ...f, workEnd: e.target.value })} /></div>
          <div className="au-field"><label>Istirahat mulai</label><input className="au-input" type="time" value={f.breakStart} onChange={(e) => setF({ ...f, breakStart: e.target.value })} /></div>
          <div className="au-field"><label>Istirahat selesai</label><input className="au-input" type="time" value={f.breakEnd} onChange={(e) => setF({ ...f, breakEnd: e.target.value })} /></div>
        </div>
        <div className="au-field">
          <label>Target jam/hari</label>
          <label className="au-check">
            <input type="checkbox" checked={f.targetAuto} onChange={(e) => setF({ ...f, targetAuto: e.target.checked, targetHours: e.target.checked ? suggested : f.targetHours })} />
            <span>Otomatis dari jadwal: <b>{suggested} jam</b></span>
          </label>
          {!f.targetAuto && (
            <input className="au-input" type="number" min="0" max="24" step="0.25" value={f.targetHours} onChange={(e) => setF({ ...f, targetHours: e.target.value })} style={{ maxWidth: 140 }} />
          )}
        </div>
        <div className="au-field">
          <label>Mode jam kerja</label>
          <label className="au-check">
            <input type="checkbox" checked={f.followSchedule} onChange={(e) => setF({ ...f, followSchedule: e.target.checked })} />
            <span><b>Ikuti jadwal otomatis</b> <span className="au-muted">— setelah Mulai, istirahat & lanjut kerja berjalan sendiri sesuai jam di atas</span></span>
          </label>
          <label className="au-check">
            <input type="checkbox" checked={f.autoStop} disabled={!f.followSchedule} onChange={(e) => setF({ ...f, autoStop: e.target.checked })} />
            <span><b>Berhenti otomatis di jam selesai</b> <span className="au-muted">— tekan Mulai lagi untuk mencatat lembur</span></span>
          </label>
          <label className="au-check">
            <input type="checkbox" checked={f.autoStart} onChange={(e) => setF({ ...f, autoStart: e.target.checked })} />
            <span><b>Mulai otomatis di jam mulai</b> <span className="au-muted">— hanya hari kerja & bila server menyala</span></span>
          </label>
        </div>
        <div className="au-field">
          <label>Hari kerja</label>
          <div className="wl-days-toggle">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => <button key={d} type="button" className={f.workdays.includes(d) ? 'on' : ''} onClick={() => toggleDay(d)}>{DAY_SHORT[d]}</button>)}
          </div>
        </div>
        <div className="au-split">
          <div className="au-field"><label>Tarif per jam (opsional)</label><input className="au-input" value={f.hourlyRate} onChange={(e) => setF({ ...f, hourlyRate: e.target.value })} placeholder="mis. 75rb" /></div>
          <div className="au-field"><label>Target pemasukan/bulan</label><input className="au-input" value={f.monthlyIncomeTarget} onChange={(e) => setF({ ...f, monthlyIncomeTarget: e.target.value })} placeholder="mis. 10jt" /></div>
        </div>
        <button className="au-btn primary" disabled={busy} onClick={save}>{busy && <span className="au-spin" />} Simpan pengaturan</button>
      </div>

      <div className="au-card">
        <h3>Telegram <small><Chip kind={data.telegram.connected ? 'ok' : 'warn'}>{data.telegram.connected ? 'terhubung' : 'belum'}</Chip></small></h3>
        <div className="au-muted" style={{ marginBottom: '0.6rem' }}>
          Di bot Anda: <code>/mulai</code> <code>/istirahat</code> <code>/lanjut</code> <code>/selesai</code> <code>/catat …</code> <code>/uang -25rb makan</code> <code>/laporan …</code> <code>/hariini</code> <code>/minggu</code>.
          Hanya chat pemilik ({data.telegram.chatId || 'TELEGRAM_AI_CHAT_IDS'}) yang bisa memakainya.
        </div>
        <label className="au-check" style={{ marginBottom: '0.5rem' }}>
          <input type="checkbox" checked={f.telegram.dailyReport} onChange={(e) => setF({ ...f, telegram: { ...f.telegram, dailyReport: e.target.checked } })} />
          <span><b>Kirim ringkasan + evaluasi setiap hari kerja</b> <span className="au-muted">pada jam selesai kerja</span></span>
        </label>
        <label className="au-check" style={{ marginBottom: '0.5rem' }}>
          <input type="checkbox" checked={f.telegram.scheduleNotices !== false} onChange={(e) => setF({ ...f, telegram: { ...f.telegram, scheduleNotices: e.target.checked } })} />
          <span><b>Notifikasi jadwal</b> <span className="au-muted">"waktunya istirahat", "lanjut kerja", "jam kerja selesai"</span></span>
        </label>
        <label className="au-check" style={{ marginBottom: '0.8rem' }}>
          <input type="checkbox" checked={f.telegram.morningReminder} onChange={(e) => setF({ ...f, telegram: { ...f.telegram, morningReminder: e.target.checked } })} />
          <span><b>Pengingat pagi</b> <span className="au-muted">bila belum mulai bekerja pada jam mulai</span></span>
        </label>
        <div className="au-split">
          <div className="au-field"><label>Jam kirim ringkasan</label><input className="au-input" type="time" value={f.telegram.reportTime || f.workEnd} onChange={(e) => setF({ ...f, telegram: { ...f.telegram, reportTime: e.target.value } })} /></div>
          <div className="au-field"><label>Chat ID (opsional)</label><input className="au-input" value={f.telegram.chatId} onChange={(e) => setF({ ...f, telegram: { ...f.telegram, chatId: e.target.value } })} placeholder={data.telegram.chatId || 'otomatis'} /></div>
        </div>
        <button className="au-btn primary" disabled={busy} onClick={save}>Simpan</button>
      </div>
    </div>
  );
}

// =================================================================== PAGE

export default function Worklog() {
  const [tab, setTab] = useState('today');
  const [data, setData] = useState(null);
  const [date, setDate] = useState(null);
  const [error, setError] = useState('');
  const [toasts, setToasts] = useState([]);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(Date.now());
  const fetchedAt = useRef(Date.now());
  const timer = useRef(null);

  const notify = useCallback((kind, text) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const load = useCallback(async (d) => {
    try {
      const r = await api(`/overview${d ? `?date=${d}` : ''}`);
      fetchedAt.current = Date.now();
      setData(r);
      setDate((cur) => cur || r.status.date);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(date); }, [date, load]);
  const refresh = useCallback(() => load(date), [date, load]);

  // realtime: server changes (Telegram /mulai, agent tool, other tab) refresh the page
  useEffect(() => {
    let es;
    try {
      const t = getToken();
      es = new EventSource(`/api/worklog/events${t ? `?token=${encodeURIComponent(t)}` : ''}`);
    } catch { return undefined; }
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.addEventListener('change', () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(refresh, 300);
    });
    return () => { es.close(); clearTimeout(timer.current); };
  }, [refresh]);

  // Refresh right when the schedule flips (break / resume / stop), so the
  // ring pauses and resumes on the exact minute without waiting for polling.
  useEffect(() => {
    const at = data?.status?.next?.at;
    if (!at) return undefined;
    const t = setTimeout(refresh, Math.max(500, at - Date.now() + 1500));
    return () => clearTimeout(t);
  }, [data, refresh]);

  // 1-second ticker for the live clock
  useEffect(() => {
    const i = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  const liveWorkedMs = useMemo(() => {
    if (!data) return 0;
    const base = data.status.workedMin * 60_000;
    return data.status.state === 'working' ? base + (tick - fetchedAt.current) : base;
  }, [data, tick]);

  const today = data?.status.date || '';

  return (
    <DashboardLayout>
      <div className="au-page">
        <div className="au-hero">
          <div>
            <h1><span>Jurnal</span> kerja</h1>
            <p>Jam kerja, istirahat, tugas, keuangan, dan laporan harian — dievaluasi otomatis, terhubung ke folder, GitHub, dan Telegram Anda.</p>
          </div>
          <span className={`au-live ${live ? 'on' : ''}`}><i className="au-dot" /> {live ? 'Realtime aktif' : 'Menyambungkan…'}</span>
        </div>

        {error && <div className="au-alert err">{error}</div>}

        <div className="au-tabs" role="tablist">
          {[['today', 'Hari ini'], ['trends', 'Tren & laporan'], ['sources', 'Sumber data'], ['settings', 'Pengaturan']].map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`au-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>

        {!data ? <div className="au-card au-empty">Memuat jurnal…</div> : (
          <>
            {tab === 'today' && <TodayTab data={data} date={date} setDate={setDate} today={today} notify={notify} refresh={refresh} liveWorkedMs={liveWorkedMs} />}
            {tab === 'trends' && <TrendsTab data={data} today={today} notify={notify} />}
            {tab === 'sources' && <SourcesTab data={data} notify={notify} refresh={refresh} />}
            {tab === 'settings' && <SettingsTab key={JSON.stringify(data.settings)} data={data} notify={notify} refresh={refresh} />}
          </>
        )}
      </div>

      <div className="au-toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`au-toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </DashboardLayout>
  );
}
