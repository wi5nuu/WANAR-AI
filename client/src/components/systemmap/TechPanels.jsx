/**
 * Engineer-grade panels for "Mode Teknis": real latency per model, runtime health
 * (event-loop lag, memory), a waterfall of every step with an automatic diagnosis,
 * and the realtime security view. "Mode Dasar" gets the same data in plain words.
 *
 * by Wisnu Alfian Nur Ashar
 */

import { fmtMs, fmtNum, fmtClock, skipText, FAIL_REASON } from './explain.js';

const KIND_LABEL = {
  auth: 'login/token ditolak', forbidden: 'akses dilarang', ratelimit: 'dibatasi (rate limit)', probe: 'pemindaian/penyusupan',
  injection: 'injeksi prompt', secret: 'rahasia disamarkan',
};
const SEV_CLASS = { high: 'err', medium: 'warn', low: 'info', info: 'info' };

// ------------------------------------------------------------ waterfall

/** Rows for the waterfall from the raw events of one trace. */
export function waterfallRows(trace) {
  const ev = trace?.events || [];
  const total = Math.max(1, (trace?.endedAt || Date.now()) - trace.startedAt, ...ev.map((e) => e.dt || 0));
  const rows = [];
  let open = null;
  const tools = new Map();
  for (const e of ev) {
    if (e.type === 'attempt') open = { label: `${e.provider} / ${e.model}`, from: e.dt, kind: 'model' };
    else if ((e.type === 'fail' || e.type === 'success') && open) {
      rows.push({ ...open, to: e.dt, ok: e.type === 'success', note: e.type === 'fail' ? (FAIL_REASON[e.reason] || e.reason) : 'berhasil' });
      open = null;
    } else if (e.type === 'tool_start') tools.set(e.name, e.dt);
    else if (e.type === 'tool_end') {
      const from = tools.get(e.name) ?? Math.max(0, e.dt - (e.ms || 0));
      rows.push({ label: `🔧 ${e.name}`, from, to: e.dt, ok: e.ok !== false, kind: 'tool', note: e.ok === false ? 'gagal' : 'selesai' });
    } else if (e.type === 'skip') rows.push({ label: `⏭ ${e.provider} / ${e.model}`, from: e.dt, to: e.dt, ok: false, kind: 'skip', note: FAIL_REASON[e.why] || e.why });
    else if (e.type === 'deliver') rows.push({ label: `📤 kirim ke ${e.channel}`, from: e.dt, to: e.dt, ok: e.ok !== false, kind: 'deliver', note: e.ok === false ? 'gagal' : `${fmtNum(e.chars)} karakter` });
    else if (e.type === 'first_token') rows.push({ label: '⚡ token pertama', from: e.dt, to: e.dt, ok: true, kind: 'ttft', note: fmtMs(e.ms) });
  }
  if (open) rows.push({ ...open, to: total, ok: null, note: 'berjalan…' });
  return { rows, total };
}

/** Plain facts a senior engineer would read off the trace. */
export function diagnose(trace) {
  const ev = trace?.events || [];
  const notes = [];
  const fails = ev.filter((e) => e.type === 'fail');
  const ok = [...ev].reverse().find((e) => e.type === 'success');
  const ttft = ev.find((e) => e.type === 'first_token');
  const wasted = fails.reduce((a, e) => a + (e.ms || 0), 0);
  const total = (trace.endedAt || Date.now()) - trace.startedAt;
  if (fails.length) {
    notes.push({ tone: 'warn', text: `${fails.length} percobaan gagal memakan ${fmtMs(wasted)} (${Math.round((wasted / Math.max(1, total)) * 100)}% dari total ${fmtMs(total)}). Penyebab: ${[...new Set(fails.map((f) => FAIL_REASON[f.reason] || f.reason))].join(', ')}.` });
  }
  const skips = ev.filter((e) => e.type === 'skip');
  if (skips.length) notes.push({ tone: 'ok', text: `${skips.length} kandidat dilewati tanpa dicoba (sudah diketahui gagal) — menghemat waktu tunggu.` });
  if (ttft) notes.push({ tone: ttft.ms > 4000 ? 'warn' : 'ok', text: `Token pertama tiba ${fmtMs(ttft.ms)} setelah permintaan dikirim${ttft.ms > 4000 ? ' — lambat; pertimbangkan model yang lebih ringan' : ''}.` });
  if (ok && trace.tokens?.completion > 0 && ok.ms > 0) {
    notes.push({ tone: 'info', text: `Kecepatan keluaran ≈ ${Math.round((trace.tokens.completion / ok.ms) * 1000)} token/detik (${fmtNum(trace.tokens.completion)} token dalam ${fmtMs(ok.ms)}).` });
  }
  if (trace.tokens?.prompt > 6000) notes.push({ tone: 'warn', text: `Konteks masuk besar (${fmtNum(trace.tokens.prompt)} token). Memangkas riwayat/instruksi akan mempercepat dan menghemat.` });
  if (!ev.some((e) => e.type === 'route') && ev.some((e) => e.type === 'intent' && !e.model)) notes.push({ tone: 'ok', text: 'Ditangani kode tanpa model: 0 token, hanya milidetik.' });
  if (trace.status === 'error') notes.push({ tone: 'err', text: `Berakhir error: ${trace.error || 'semua kandidat gagal'}.` });
  return notes;
}

export function Waterfall({ trace }) {
  const { rows, total } = waterfallRows(trace);
  if (!rows.length) return null;
  const notes = diagnose(trace);
  return (
    <div className="sm-wf">
      <h4>⏱ Waterfall waktu</h4>
      <div className="sm-wf-axis"><span>0</span><span>{fmtMs(total / 2)}</span><span>{fmtMs(total)}</span></div>
      {rows.map((r, i) => {
        const left = (r.from / total) * 100;
        const width = Math.max(r.to === r.from ? 0.8 : 0, ((r.to - r.from) / total) * 100);
        return (
          <div key={i} className={`sm-wf-row ${r.kind}`}>
            <div className="sm-wf-label" title={r.label}>{r.label}</div>
            <div className="sm-wf-track">
              <span className={`sm-wf-bar ${r.ok === null ? 'run' : r.ok ? 'ok' : 'bad'} ${r.to === r.from ? 'dot' : ''}`} style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%` }} />
            </div>
            <div className="sm-wf-ms">{r.to === r.from ? fmtMs(r.from) : fmtMs(r.to - r.from)}<small>{r.note}</small></div>
          </div>
        );
      })}
      {notes.length > 0 && (
        <div className="sm-diag">
          <h4>🩺 Diagnosis otomatis</h4>
          {notes.map((n, i) => <div key={i} className={`sm-diag-item ${n.tone}`}>{n.text}</div>)}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ engine

function lagVerdict(p99) {
  if (p99 == null) return { tone: 'info', text: '-' };
  if (p99 < 40) return { tone: 'ok', text: 'sangat responsif' };
  if (p99 < 120) return { tone: 'ok', text: 'sehat' };
  if (p99 < 400) return { tone: 'warn', text: 'mulai tertekan' };
  return { tone: 'err', text: 'macet — server kewalahan' };
}

export function EnginePanel({ overview, tech }) {
  if (!overview) return <p className="sm-empty">Memuat…</p>;
  const rt = overview.runtime || {};
  const lat = overview.latency || {};
  const rows = Object.entries(lat).sort((a, b) => (a[1].avgMs ?? 1e9) - (b[1].avgMs ?? 1e9));
  const best = rows[0]?.[0];
  const maxAvg = Math.max(1, ...rows.map(([, v]) => v.p95Ms || v.avgMs || 0));
  const lag = lagVerdict(rt.loopLagMs?.p99);
  const cooling = (overview.providers || []).flatMap((p) => (p.models || []).filter((m) => m.skip).map((m) => ({ p: p.label, id: m.id, skip: m.skip })));
  const downs = (overview.providers || []).filter((p) => p.health?.down || p.health?.circuitOpen);
  return (
    <div>
      <h4 className="sm-h4-first">🖥 Kesehatan mesin (runtime)</h4>
      <div className="sm-kpis">
        <div><small>Event-loop lag p99</small><b className={`t-${lag.tone}`}>{rt.loopLagMs ? `${rt.loopLagMs.p99} ms` : '-'}</b></div>
        <div><small>Status</small><b className={`t-${lag.tone}`}>{lag.text}</b></div>
        <div><small>Memori</small><b>{rt.rssMb ?? '-'} MB <span className="sm-dim">heap {rt.heapMb ?? '-'}</span></b></div>
        <div><small>Beban CPU</small><b>{(rt.load || []).join(' · ') || '-'}</b></div>
        <div><small>Klien realtime</small><b>{rt.sseClients ?? 0}</b></div>
        <div><small>Aktif</small><b>{rt.uptimeSec != null ? fmtMs(rt.uptimeSec * 1000) : '-'}</b></div>
      </div>
      {tech && rt.loopLagMs && <p className="sm-note">Lag p50 {rt.loopLagMs.p50} ms · max {rt.loopLagMs.max} ms (jendela sejak pembacaan terakhir) · {rt.node}</p>}

      <h4>⚡ Kecepatan model (diukur dari panggilan nyata)</h4>
      {rows.length === 0 && <p className="sm-empty">Belum ada panggilan selesai sejak server menyala. Kirim pesan ke bot atau chat — angka akan muncul.</p>}
      {rows.length > 0 && best && <p className="sm-tl-text">Tercepat saat ini: <b>{best}</b> (rata-rata {fmtMs(lat[best].avgMs)}).</p>}
      <div className="sm-lat">
        {rows.map(([prov, v]) => (
          <div key={prov} className="sm-lat-row">
            <div className="sm-lat-head"><b>{prov}</b><span>{v.n} panggilan{v.fails ? ` · ${v.fails} gagal` : ''}</span></div>
            <div className="sm-lat-bar"><span style={{ width: `${Math.min(100, ((v.avgMs || 0) / maxAvg) * 100)}%` }} />{v.p95Ms ? <i style={{ left: `${Math.min(99, (v.p95Ms / maxAvg) * 100)}%` }} /> : null}</div>
            <div className="sm-lat-meta">
              <span>rata² <b>{fmtMs(v.avgMs)}</b></span>
              {tech && <span>p50 <b>{fmtMs(v.p50Ms)}</b></span>}
              {tech && <span>p95 <b>{fmtMs(v.p95Ms)}</b></span>}
              <span>token pertama <b>{fmtMs(v.ttftMs)}</b></span>
              <span>{fmtClock(v.lastAt)}</span>
            </div>
            {tech && Object.entries(v.models || {}).map(([m, mv]) => (
              <div key={m} className="sm-lat-model"><span>{m}</span><span>{mv.n}× · rata² {fmtMs(mv.avgMs)} · p50 {fmtMs(mv.p50Ms)}</span></div>
            ))}
          </div>
        ))}
      </div>

      <h4>🧯 Yang sedang dilewati router</h4>
      {downs.length === 0 && cooling.length === 0 && <p className="sm-empty">Tidak ada. Semua kandidat siap dipakai.</p>}
      {downs.map((p) => <div key={p.id} className="sm-diag-item err"><b>{p.label}</b> seluruhnya dilewati — {p.health.down ? 'kuota/kunci ditolak' : 'dikarantina karena gagal beruntun'}.</div>)}
      {cooling.slice(0, tech ? 40 : 8).map((c, i) => <div key={i} className="sm-diag-item warn"><b>{c.p}</b> / {c.id} — {skipText(c.skip)}</div>)}
      {!tech && cooling.length > 8 && <p className="sm-note">+{cooling.length - 8} lainnya (lihat Mode Teknis)</p>}

      {tech && (
        <>
          <h4>🧭 Strategi router</h4>
          <p className="sm-tl-text">{overview.router?.strategy}</p>
          <h4>Kegagalan terakhir</h4>
          {(overview.router?.recentFailovers || []).slice(0, 12).map((f, i) => (
            <div key={i} className="sm-mini static"><span>{fmtClock(f.at)}</span><span className="sm-mini-in">{f.provider}/{f.model} — {FAIL_REASON[f.reason] || f.reason}</span></div>
          ))}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ security

function Spark({ series }) {
  const max = Math.max(1, ...series.map((s) => s.total));
  return (
    <div className="sm-spark" aria-label="Kejadian keamanan 30 menit terakhir">
      {series.map((s, i) => <span key={i} title={`${s.total} kejadian`} className={s.total ? 'on' : ''} style={{ height: `${Math.max(6, (s.total / max) * 100)}%` }} />)}
    </div>
  );
}

export function SecurityPanel({ security, tech }) {
  if (!security) return <p className="sm-empty">Memuat…</p>;
  const { level, window: w, posture, recent = [], sources = [], series = [], redactions = 0, totals = {} } = security;
  const bad = (posture?.items || []).filter((i) => i.ok === false);
  const score = posture?.score ?? 0;
  return (
    <div>
      <div className={`sm-sec-level ${level.level}`}>
        <div className="sm-sec-ring" style={{ '--p': score }}><b>{score}</b><small>skor</small></div>
        <div>
          <div className="sm-sec-title">{level.label}</div>
          <div className="sm-sec-why">{level.why}</div>
          <div className="sm-sec-why">Postur konfigurasi: {score >= 90 ? 'kuat' : score >= 70 ? 'cukup baik' : 'perlu perhatian'}{bad.length ? ` · ${bad.length} hal perlu dibenahi` : ''}</div>
        </div>
      </div>

      <div className="sm-kpis">
        <div><small>Login ditolak (1 jam)</small><b>{w.auth || 0}</b></div>
        <div><small>Akses dilarang</small><b>{w.forbidden || 0}</b></div>
        <div><small>Dibatasi (429)</small><b>{w.ratelimit || 0}</b></div>
        <div><small>Pemindaian</small><b>{w.probe || 0}</b></div>
        <div><small>Rahasia disamarkan</small><b>{fmtNum(redactions)}</b></div>
      </div>
      <Spark series={series} />

      {bad.length > 0 && (
        <>
          <h4>⚠️ Perlu dibenahi</h4>
          {bad.map((i) => <div key={i.id} className="sm-diag-item warn"><b>{i.label}</b> — {i.detail}</div>)}
        </>
      )}

      <h4>✅ Pemeriksaan postur{tech ? ' (dari konfigurasi nyata)' : ''}</h4>
      <div className="sm-posture">
        {(posture?.items || []).map((i) => (
          <div key={i.id} className={`sm-posture-row ${i.ok === null ? 'na' : i.ok ? 'ok' : 'bad'}`}>
            <span className="sm-posture-mark">{i.ok === null ? '–' : i.ok ? '✓' : '✗'}</span>
            <span><b>{i.label}</b>{tech || i.ok === false ? <small>{i.detail}</small> : null}</span>
          </div>
        ))}
      </div>

      {sources.length > 0 && (
        <>
          <h4>Sumber paling aktif (IP disamarkan)</h4>
          {sources.map((s) => (
            <div key={s.ip} className="sm-mini static"><span>{s.ip}</span><span className="sm-mini-in">{s.kinds.map((k) => KIND_LABEL[k] || k).join(', ')}</span><span>{s.count}×</span></div>
          ))}
        </>
      )}

      <h4>Kejadian terbaru</h4>
      {recent.length === 0 && <p className="sm-empty">Tidak ada kejadian keamanan tercatat sejak server menyala. 🛡️</p>}
      {recent.map((e) => (
        <div key={e.id} className={`sm-sec-ev ${SEV_CLASS[e.severity] || 'info'}`}>
          <span className="sm-sec-time">{fmtClock(e.at)}</span>
          <div>
            <b>{KIND_LABEL[e.kind] || e.kind}</b>{e.status ? <span className="sm-dim"> · {e.status}</span> : null}
            <div className="sm-sec-detail">{e.ip} · {e.method} {e.path}</div>
            {tech && <div className="sm-sec-detail">{e.detail}</div>}
          </div>
        </div>
      ))}
      {tech && <p className="sm-note">Total sejak start: {totals.requests || 0} permintaan · {totals.auth || 0} auth · {totals.forbidden || 0} forbidden · {totals.ratelimit || 0} rate-limit · {totals.probe || 0} probe. Isi permintaan & header tidak pernah disimpan.</p>}
    </div>
  );
}
