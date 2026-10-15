/**
 * Peta Sistem Live — 3D, realtime view of how Wanar AI handles every request:
 * which channel it came from (web, Telegram, email, check-ins…), what the core
 * decided, which provider/model the router chose and WHY, failovers, tools,
 * tokens, what went out and where. Click a glowing dot (or any request in the
 * list) to read its full journey; click a node for its status and quota.
 *
 * by Wisnu Alfian Nur Ashar
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openStream, getAutomationToken } from '../../lib/stream.js';
import { MapScene, webglAvailable } from './scene.js';
import {
  CHANNEL_META, STATUS_LABEL, explainStep, whyThisModel, providerStatus, skipText,
  fmtMs, fmtNum, fmtClock, untilText, FAIL_REASON,
} from './explain.js';
import './systemmap.css';

const TOKEN_KEY = 'automationToken';

async function api(path, { method = 'GET' } = {}, retried = false) {
  const headers = {};
  const t = getAutomationToken();
  if (t) headers['X-Automation-Token'] = t;
  const res = await fetch(`/api/system-map${path}`, { method, headers });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && !retried) {
    const entered = window.prompt('Masukkan token otomasi (AUTOMATION_TOKEN di .env server):');
    if (entered) {
      try { localStorage.setItem(TOKEN_KEY, entered.trim()); } catch { /* private mode */ }
      return api(path, { method }, true);
    }
  }
  if (!res.ok || data.success === false) throw new Error(data.error || `Permintaan gagal (HTTP ${res.status})`);
  return data;
}

// ---------------------------------------------------------------- demo trace

function demoTrace() {
  const id = `demo_${Date.now().toString(36)}`;
  const ev = (type, dt, d) => ({ type, dt, at: Date.now() + dt, ...d });
  return {
    id, demo: true, channel: 'telegram', title: 'Pesan Telegram (demo)', status: 'ok',
    input: 'Tolong ingatkan saya meeting jam 3 sore ya', output: 'Siap, Pak Wisnu. Saya ingatkan jam 14:45 dan tepat jam 15:00.\n\n✓ Pengingat 14:45 — meeting\n✓ Pengingat 15:00 — meeting\n✓ Tugas dicatat: meeting',
    startedAt: Date.now(), endedAt: Date.now() + 5200, provider: 'openagentic', model: 'glm-5.3-flash',
    tokens: { prompt: 1840, completion: 96, total: 1936, estimated: false },
    events: [
      ev('receive', 30, { channel: 'telegram', kind: 'chat', chars: 41, history: 6 }),
      ev('intent', 120, { name: 'ai-plan', detail: 'Dijawab AI dalam format rencana JSON {reply, actions}', model: true }),
      ev('context', 180, { messages: 7, systemChars: 6400, promptTokens: 1840, temperature: 0.55, maxTokens: 1200 }),
      ev('route', 200, { requested: { provider: 'openagentic', model: 'deepseek-v4.1-flash-free' }, source: 'default', defaultProvider: 'openagentic', total: 9, chain: [
        { i: 0, provider: 'openagentic', model: 'deepseek-v4.1-flash-free', reason: 'primary', skip: null, available: true },
        { i: 1, provider: 'openagentic', model: 'glm-5.3-flash', reason: 'same-provider', skip: null, available: true },
        { i: 2, provider: 'clouvia', model: 'deepseek-v4.1-flash', reason: 'cross-provider', skip: { why: 'auth' }, available: true },
      ] }),
      ev('attempt', 260, { provider: 'openagentic', model: 'deepseek-v4.1-flash-free', reason: 'primary', index: 0 }),
      ev('fail', 1500, { provider: 'openagentic', model: 'deepseek-v4.1-flash-free', reason: 'quota', error: 'free-models-per-day', ms: 1240 }),
      ev('attempt', 1560, { provider: 'openagentic', model: 'glm-5.3-flash', reason: 'same-provider', index: 1 }),
      ev('first_token', 2300, { provider: 'openagentic', ms: 740 }),
      ev('success', 3600, { provider: 'openagentic', model: 'glm-5.3-flash', ms: 2040, chars: 410 }),
      ev('usage', 3610, { provider: 'openagentic', model: 'glm-5.3-flash', prompt: 1840, completion: 96, estimated: false }),
      ev('plan', 3700, { parsed: true, attempts: 1, reply: 'Siap, Pak Wisnu. Saya ingatkan jam 14:45 dan tepat jam 15:00.', actions: ['reminder', 'reminder', 'task'] }),
      ev('actions', 3800, { results: ['✓ Pengingat 14:45 — meeting', '✓ Pengingat 15:00 — meeting', '✓ Tugas dicatat: meeting'], ok: 3, failed: 0 }),
      ev('deliver', 4100, { channel: 'telegram', parts: 1, chars: 128, ok: true }),
    ],
  };
}

// ---------------------------------------------------------------- component

export default function SystemMap({ mode = 'simple', demoTick = 0 }) {
  const tech = mode === 'tech';
  const hostRef = useRef(null);
  const sceneRef = useRef(null);
  const [gl] = useState(() => webglAvailable());
  const [overview, setOverview] = useState(null);
  const [traces, setTraces] = useState([]);
  const [liveStep, setLiveStep] = useState({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState('live');       // live | detail | quota | help
  const [selected, setSelected] = useState(null);    // {kind:'trace', id} | {kind:'node', info}
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState('');
  const [filter, setFilter] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const demoRef = useRef(new Map());
  const selectedRef = useRef(null);
  selectedRef.current = selected;

  const reduced = useMemo(() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }, []);

  const loadOverview = useCallback(async (refresh = false) => {
    try {
      const d = await api(`/overview${refresh ? '?refresh=1' : ''}`);
      setOverview(d);
      setTraces((prev) => mergeTraces(d.traces || [], prev));
      setError('');
      sceneRef.current?.setGraph(d);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const openTrace = useCallback(async (id) => {
    setSelected({ kind: 'trace', id });
    setPanel('detail');
    setDetailErr('');
    sceneRef.current?.setHighlight(id);
    const local = demoRef.current.get(id);
    if (local) { setDetail(local); return; }
    try {
      const d = await api(`/traces/${encodeURIComponent(id)}`);
      setDetail(d.trace);
    } catch (e) {
      setDetail(null);
      setDetailErr(e.message);
    }
  }, []);

  const openNode = useCallback((info) => {
    if (!info) return;
    setSelected({ kind: 'node', info });
    setPanel('detail');
    const id = info.type === 'channel' ? `c:${info.id}` : info.type === 'provider' ? `p:${info.id}` : info.type === 'model' ? `m:${info.provider}:${info.id}` : info.type;
    sceneRef.current?.focusNode(id);
  }, []);

  // 3D scene lifecycle
  useEffect(() => {
    if (!gl || !hostRef.current) return undefined;
    const sc = new MapScene(hostRef.current, { reducedMotion: reduced, onSelectNode: openNode, onSelectTrace: openTrace });
    sceneRef.current = sc;
    if (overview) sc.setGraph(overview);
    return () => { sc.dispose(); sceneRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, reduced]);

  // data: first load + gentle polling (quota, health, usage)
  useEffect(() => {
    loadOverview();
    const t = setInterval(() => { if (!document.hidden) loadOverview(); }, 20_000);
    return () => clearInterval(t);
  }, [loadOverview]);

  // realtime: every trace event from every channel
  useEffect(() => {
    let refreshTimer = null;
    const close = openStream('/api/system-map/events', {
      onOpen: () => setConnected(true),
      onDown: () => setConnected(false),
      events: {
        trace: (e) => {
          let msg;
          try { msg = JSON.parse(e.data); } catch { return; }
          sceneRef.current?.handle(msg);
          if (msg.kind === 'start' || msg.kind === 'end') {
            setTraces((prev) => upsertTrace(prev, msg.trace));
          }
          if (msg.kind === 'event') {
            const ex = explainStep(msg.event);
            setLiveStep((s) => ({ ...s, [msg.traceId]: `${ex.icon} ${ex.title}` }));
            setTraces((prev) => prev.map((t) => (t.id === msg.traceId ? patchSummary(t, msg.event) : t)));
            const sel = selectedRef.current;
            if (sel?.kind === 'trace' && sel.id === msg.traceId) {
              setDetail((d) => (d && d.id === msg.traceId ? { ...d, events: [...(d.events || []), msg.event] } : d));
            }
          }
          if (msg.kind === 'end') {
            const sel = selectedRef.current;
            if (sel?.kind === 'trace' && sel.id === msg.trace.id) {
              api(`/traces/${encodeURIComponent(msg.trace.id)}`).then((d) => setDetail(d.trace)).catch(() => {});
            }
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => loadOverview(), 1500);
          }
        },
      },
    });
    return () => { clearTimeout(refreshTimer); close(); };
  }, [loadOverview]);

  // demo button in the header
  useEffect(() => {
    if (!demoTick) return;
    const t = demoTrace();
    demoRef.current.set(t.id, t);
    setTraces((prev) => [summaryOf(t), ...prev].slice(0, 120));
    sceneRef.current?.replay(t);
  }, [demoTick]);

  const replay = useCallback(() => {
    if (detail) sceneRef.current?.replay(detail);
  }, [detail]);

  const shown = useMemo(() => traces.filter((t) => !filter || t.channel === filter), [traces, filter]);

  return (
    <div className="sm-root">
      <div className="sm-stage">
        {gl ? <div ref={hostRef} className="sm-host" /> : (
          <div className="sm-nogl">
            <b>Perangkat ini tidak mendukung WebGL (3D).</b>
            <span>Semua data tetap tersedia di panel: jejak live, detail proses, kuota & token.</span>
          </div>
        )}
        <div className="sm-hud">
          <span className={`sm-live ${connected ? 'on' : ''}`}><i />{connected ? 'Realtime' : 'Menyambung…'}</span>
          {overview?.usage && (
            <span className="sm-chip" title={overview.usage.source}>
              🪙 {fmtNum(overview.usage.total)} token hari ini
              {overview.usage.limit ? ` · sisa ${fmtNum(overview.usage.remaining)}` : ''}
            </span>
          )}
          <span className="sm-chip">⭐ default: {overview?.router?.defaultProvider || '-'}</span>
          {gl && <button type="button" className="sm-hud-btn" onClick={() => sceneRef.current?.resetView()}>⟲ Pusatkan</button>}
          <button type="button" className="sm-hud-btn" onClick={() => setPanel('help')}>❔ Cara baca</button>
        </div>
        {error && <div className="sm-error">⚠️ {error}</div>}
      </div>

      <aside className="sm-panel">
        <div className="sm-tabs" role="tablist">
          <button role="tab" aria-selected={panel === 'live'} className={panel === 'live' ? 'on' : ''} onClick={() => setPanel('live')}>📡 Jejak live</button>
          <button role="tab" aria-selected={panel === 'detail'} className={panel === 'detail' ? 'on' : ''} onClick={() => setPanel('detail')} disabled={!selected}>🔍 Detail</button>
          <button role="tab" aria-selected={panel === 'quota'} className={panel === 'quota' ? 'on' : ''} onClick={() => setPanel('quota')}>🪙 Kuota & token</button>
        </div>

        <div className="sm-panel-body">
          {panel === 'live' && (
            <LivePanel traces={shown} liveStep={liveStep} filter={filter} setFilter={setFilter} channels={overview?.channels || []} onOpen={openTrace} selectedId={selected?.kind === 'trace' ? selected.id : null} />
          )}
          {panel === 'detail' && selected?.kind === 'trace' && (
            <TraceDetail trace={detail} error={detailErr} tech={tech} onReplay={gl ? replay : null} />
          )}
          {panel === 'detail' && selected?.kind === 'node' && (
            <NodeDetail info={selected.info} overview={overview} tech={tech} traces={traces} onOpenTrace={openTrace} onFilter={(c) => { setFilter(c); setPanel('live'); }} />
          )}
          {panel === 'detail' && !selected && <p className="sm-empty">Klik titik cahaya, node, atau salah satu jejak untuk melihat detailnya.</p>}
          {panel === 'quota' && (
            <QuotaPanel overview={overview} tech={tech} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await loadOverview(true); setRefreshing(false); }} onOpenProvider={(p) => openNode({ type: 'provider', ...p })} />
          )}
          {panel === 'help' && <HelpPanel />}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- list state

function summaryOf(t) {
  return {
    id: t.id, channel: t.channel, title: t.title, input: String(t.input || '').slice(0, 220), output: String(t.output || '').slice(0, 220),
    status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, ms: (t.endedAt || Date.now()) - t.startedAt,
    provider: t.provider, model: t.model, tokens: t.tokens, attempts: (t.events || []).filter((e) => e.type === 'attempt').length,
    tools: (t.events || []).filter((e) => e.type === 'tool_start').length, demo: t.demo,
  };
}

function upsertTrace(list, t) {
  const i = list.findIndex((x) => x.id === t.id);
  if (i === -1) return [t, ...list].slice(0, 120);
  const next = list.slice();
  next[i] = { ...next[i], ...t };
  return next;
}

function mergeTraces(fresh, prev) {
  const map = new Map(prev.map((t) => [t.id, t]));
  for (const t of fresh) map.set(t.id, { ...map.get(t.id), ...t });
  return [...map.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 120);
}

function patchSummary(t, ev) {
  const n = { ...t };
  if (ev.type === 'attempt') { n.attempts = (n.attempts || 0) + 1; n.provider = ev.provider; n.model = ev.model; }
  if (ev.type === 'success') { n.provider = ev.provider; n.model = ev.model; }
  if (ev.type === 'tool_start') n.tools = (n.tools || 0) + 1;
  if (ev.type === 'usage') {
    const tk = { ...(n.tokens || { prompt: 0, completion: 0, total: 0, estimated: true }) };
    tk.prompt += ev.prompt || 0; tk.completion += ev.completion || 0; tk.total = tk.prompt + tk.completion;
    if (ev.estimated === false) tk.estimated = false;
    n.tokens = tk;
  }
  return n;
}

// ---------------------------------------------------------------- panels

function StatusBadge({ status }) {
  return <span className={`sm-badge ${status}`}>{status === 'running' && <i className="sm-spin" />}{STATUS_LABEL[status] || status}</span>;
}

function LivePanel({ traces, liveStep, filter, setFilter, channels, onOpen, selectedId }) {
  return (
    <div>
      <div className="sm-filters">
        <button className={!filter ? 'on' : ''} onClick={() => setFilter(null)}>Semua</button>
        {channels.map((c) => (
          <button key={c.id} className={filter === c.id ? 'on' : ''} onClick={() => setFilter(c.id)} title={c.detail}>
            {CHANNEL_META[c.id]?.icon} {CHANNEL_META[c.id]?.label}{c.stats?.requests ? ` · ${c.stats.requests}` : ''}
          </button>
        ))}
      </div>
      {traces.length === 0 && (
        <p className="sm-empty">Belum ada aktivitas{filter ? ' di kanal ini' : ''}. Kirim pesan ke bot Telegram atau chat di aplikasi — setiap langkahnya akan muncul di sini dan bergerak di peta. Tombol <b>▶ Simulasi Demo</b> menampilkan contohnya.</p>
      )}
      <ul className="sm-list">
        {traces.map((t) => {
          const ch = CHANNEL_META[t.channel] || CHANNEL_META.system;
          return (
            <li key={t.id}>
              <button className={`sm-item ${selectedId === t.id ? 'sel' : ''}`} onClick={() => onOpen(t.id)} style={{ '--c': ch.color }}>
                <span className="sm-item-top">
                  <span className="sm-item-ch">{ch.icon} {ch.label}{t.demo ? ' · demo' : ''}</span>
                  <StatusBadge status={t.status} />
                </span>
                <span className="sm-item-in">{t.input || t.title}</span>
                {t.status === 'running' && liveStep[t.id] && <span className="sm-item-step">{liveStep[t.id]}</span>}
                <span className="sm-item-meta">
                  <span>{fmtClock(t.startedAt)}</span>
                  {t.provider && <span>☁️ {t.provider}{t.model ? ` / ${t.model}` : ''}</span>}
                  {t.attempts > 1 && <span>🔀 {t.attempts} percobaan</span>}
                  {t.tools > 0 && <span>🛠️ {t.tools} alat</span>}
                  {t.tokens?.total > 0 && <span>🪙 {fmtNum(t.tokens.total)}{t.tokens.estimated ? '≈' : ''}</span>}
                  {t.status !== 'running' && <span>⏱️ {fmtMs(t.ms)}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Raw({ value }) {
  if (value == null || value === '') return null;
  let text = value;
  if (typeof value !== 'string') { try { text = JSON.stringify(value, null, 2); } catch { text = String(value); } }
  else { try { text = JSON.stringify(JSON.parse(value), null, 2); } catch { /* keep text */ } }
  return <pre className="sm-raw">{text}</pre>;
}

function TraceDetail({ trace, error, tech, onReplay }) {
  if (error) return <p className="sm-empty">⚠️ {error}</p>;
  if (!trace) return <p className="sm-empty">Memuat…</p>;
  const ch = CHANNEL_META[trace.channel] || CHANNEL_META.system;
  const why = whyThisModel(trace);
  const events = trace.events || [];
  const t0 = trace.startedAt;
  return (
    <div className="sm-detail">
      <div className="sm-detail-head" style={{ '--c': ch.color }}>
        <div>
          <div className="sm-detail-ch">{ch.icon} {ch.label}{trace.demo ? ' · demo' : ''}</div>
          <div className="sm-detail-title">{trace.title}</div>
        </div>
        <StatusBadge status={trace.status} />
      </div>
      <div className="sm-kpis">
        <div><small>Waktu</small><b>{fmtClock(trace.startedAt)}</b></div>
        <div><small>Durasi</small><b>{fmtMs((trace.endedAt || Date.now()) - trace.startedAt)}</b></div>
        <div><small>Model</small><b title={trace.model || ''}>{trace.provider ? `${trace.provider}${trace.model ? ` / ${trace.model}` : ''}` : 'tanpa AI'}</b></div>
        <div><small>Token</small><b>{fmtNum(trace.tokens?.total)}{trace.tokens?.total ? (trace.tokens.estimated ? ' (perkiraan)' : ' (asli)') : ''}</b></div>
      </div>
      {why && <div className="sm-why"><b>Kenapa model ini?</b> {why}</div>}
      {onReplay && <button type="button" className="sm-btn" onClick={onReplay}>▶ Putar ulang perjalanan pesan di peta 3D</button>}

      <h4>📥 Pesan masuk</h4>
      <div className="sm-msg in">{trace.input || <em>(kosong)</em>}</div>

      <h4>🧩 Proses langkah demi langkah ({events.length})</h4>
      <ol className="sm-timeline">
        {events.map((ev, i) => {
          const x = explainStep(ev, { tech });
          return (
            <li key={i} className={`tone-${x.tone}`}>
              <span className="sm-tl-dot" aria-hidden="true">{x.icon}</span>
              <div className="sm-tl-body">
                <div className="sm-tl-title"><b>{x.title}</b><small>+{fmtMs(ev.dt ?? (ev.at - t0))}</small></div>
                {x.text && <div className="sm-tl-text">{x.text}</div>}
                {x.chain && x.chain.length > 0 && (
                  <table className="sm-chain">
                    <thead><tr><th>#</th><th>Provider / model</th><th>Kenapa di antrian</th><th>Status saat itu</th></tr></thead>
                    <tbody>
                      {x.chain.map((c) => (
                        <tr key={c.i} className={c.skip || c.available === false ? 'skip' : ''}>
                          <td>{c.i + 1}</td>
                          <td>{c.provider}<br /><small>{c.model}</small></td>
                          <td>{c.reason === 'primary' ? 'pilihan utama' : c.reason === 'same-provider' ? 'model lain, provider sama' : 'provider lain (tier)'}</td>
                          <td>{c.available === false ? 'API key belum diisi' : skipText(c.skip)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {(tech || ev.type === 'plan' || ev.type === 'tool_start' || ev.type === 'tool_end' || ev.type === 'fail') && (x.raw != null || x.data) && (
                  <details className="sm-tl-raw" open={tech && ev.type !== 'tool_end'}>
                    <summary>{ev.type === 'plan' ? 'Jawaban yang ditulis AI' : ev.type === 'tool_start' ? 'Argumen' : ev.type === 'tool_end' ? 'Hasil alat' : 'Detail teknis'}</summary>
                    <Raw value={x.raw ?? x.data} />
                  </details>
                )}
                {tech && <details className="sm-tl-raw"><summary>Event mentah</summary><Raw value={ev} /></details>}
              </div>
            </li>
          );
        })}
        {trace.status === 'running' && <li className="tone-info"><span className="sm-tl-dot"><i className="sm-spin" /></span><div className="sm-tl-body"><div className="sm-tl-text">Masih berjalan — langkah baru muncul otomatis…</div></div></li>}
      </ol>

      <h4>📤 Jawaban keluar</h4>
      <div className="sm-msg out">{trace.output || <em>{trace.status === 'running' ? '(sedang disusun…)' : '(tidak ada teks keluar)'}</em>}</div>
      {trace.error && <div className="sm-msg err">⚠️ {trace.error}</div>}
      <p className="sm-note">Jejak disimpan di memori server saja (tidak ke disk), maksimal 150 permintaan terakhir. Kunci API & sandi otomatis disamarkan.</p>
    </div>
  );
}

function NodeDetail({ info, overview, tech, traces, onOpenTrace, onFilter }) {
  if (info.type === 'channel') {
    const ch = CHANNEL_META[info.id] || CHANNEL_META.system;
    const mine = traces.filter((t) => t.channel === info.id).slice(0, 8);
    return (
      <div className="sm-detail">
        <div className="sm-detail-head" style={{ '--c': ch.color }}>
          <div><div className="sm-detail-ch">Kanal</div><div className="sm-detail-title">{ch.icon} {ch.label}</div></div>
          <span className={`sm-badge ${info.active ? 'ok' : 'stopped'}`}>{info.active ? 'aktif' : 'nonaktif'}</span>
        </div>
        <p className="sm-tl-text">{info.detail}</p>
        <div className="sm-kpis">
          <div><small>Permintaan 24j</small><b>{info.stats?.requests || 0}</b></div>
          <div><small>Gagal</small><b>{info.stats?.errors || 0}</b></div>
          <div><small>Terakhir</small><b>{info.stats?.lastAt ? fmtClock(info.stats.lastAt) : '-'}</b></div>
        </div>
        <ChannelFlow id={info.id} />
        {tech && info.status && <Raw value={info.status} />}
        <h4>Aktivitas terakhir</h4>
        {mine.length ? mine.map((t) => (
          <button key={t.id} className="sm-mini" onClick={() => onOpenTrace(t.id)}>
            <span>{fmtClock(t.startedAt)}</span><span className="sm-mini-in">{t.input || t.title}</span><StatusBadge status={t.status} />
          </button>
        )) : <p className="sm-empty">Belum ada aktivitas di kanal ini.</p>}
        <button type="button" className="sm-btn ghost" onClick={() => onFilter(info.id)}>Saring daftar jejak ke kanal ini</button>
      </div>
    );
  }
  if (info.type === 'core') {
    return (
      <div className="sm-detail">
        <div className="sm-detail-head" style={{ '--c': '#60a5fa' }}><div><div className="sm-detail-ch">Pusat</div><div className="sm-detail-title">🧠 Wanar Core &amp; Router</div></div></div>
        <p className="sm-tl-text">Semua pesan dari semua kanal masuk ke sini. Core memutuskan: cukup dijawab kode (instan, 0 token) atau perlu AI. Bila perlu AI, router memilih provider & model.</p>
        <h4>Cara router memilih</h4>
        <p className="sm-tl-text">{info.router?.strategy}</p>
        <p className="sm-tl-text">Provider default sekarang: <b>{info.router?.defaultProvider}</b>.</p>
        <h4>Perpindahan otomatis terakhir</h4>
        {(info.router?.recentFailovers || []).length ? (info.router.recentFailovers).map((f, i) => (
          <div key={i} className="sm-mini static"><span>{fmtClock(f.at)}</span><span className="sm-mini-in">{f.provider}/{f.model} — {FAIL_REASON[f.reason] || f.reason}</span></div>
        )) : <p className="sm-empty">Belum ada kegagalan sejak server menyala.</p>}
      </div>
    );
  }
  if (info.type === 'tools') {
    return (
      <div className="sm-detail">
        <div className="sm-detail-head" style={{ '--c': '#a78bfa' }}><div><div className="sm-detail-ch">Alat</div><div className="sm-detail-title">🛠️ {info.count} alat yang bisa dipakai AI</div></div></div>
        <p className="sm-tl-text">Di chat web, AI boleh memanggil alat (browser, file, perintah, dll). Setiap panggilan alat terlihat sebagai titik ungu di peta dan tercatat di detail jejak beserta argumen dan hasilnya.</p>
        {Object.entries(info.groups || {}).map(([g, list]) => (
          <div key={g} className="sm-tools"><b>{g}</b><span>{list.join(', ')}</span></div>
        ))}
      </div>
    );
  }
  if (info.type === 'provider') {
    const p = (overview?.providers || []).find((x) => x.id === info.id) || info;
    return <ProviderCard p={p} tech={tech} expanded />;
  }
  if (info.type === 'model') {
    return (
      <div className="sm-detail">
        <div className="sm-detail-head" style={{ '--c': '#cbd5e1' }}><div><div className="sm-detail-ch">Model · {info.providerLabel}</div><div className="sm-detail-title">{info.id}</div></div></div>
        <div className="sm-kpis">
          <div><small>Token hari ini</small><b>{fmtNum(info.tokensToday)}</b></div>
          <div><small>Terakhir berhasil</small><b>{info.lastSuccess ? fmtClock(info.lastSuccess) : '-'}</b></div>
          <div><small>Status</small><b>{skipText(info.skip)}</b></div>
        </div>
        {info.lastFailure && <p className="sm-tl-text">Gagal terakhir {fmtClock(info.lastFailure.at)}: {FAIL_REASON[info.lastFailure.reason] || info.lastFailure.reason}{info.lastFailure.until > Date.now() ? ` — ${untilText(info.lastFailure.until)}` : ''}.</p>}
      </div>
    );
  }
  return null;
}

/** "Di Telegram ngapain?" — what each channel really does, step by step. */
function ChannelFlow({ id }) {
  const flows = {
    telegram: [
      'Anda mengirim pesan ke bot → server membaca lewat polling Telegram (hanya chat milik Anda yang dijawab AI).',
      'Core cek dulu: perintah (/brief, /peka, /email…), “kirim/batal” draf email, daftar pengingat → dijawab kode, instan, 0 token.',
      'Selain itu → AI menyusun jawaban + aksi (pengingat, tugas, uang, jam kerja, email) dengan konteks jurnal, jadwal & obrolan sebelumnya.',
      'Router memilih provider/model (default → cadangan bila gagal), aksi dijalankan & divalidasi kode.',
      'Jawaban dikirim balik ke Telegram (dipecah per 3.500 karakter bila panjang) dan diingat untuk obrolan berikutnya.',
    ],
    web: ['Pesan dari chat aplikasi dikirim lewat streaming.', 'Router memilih provider/model sesuai form (atau default), bisa memakai alat (browser, file…).', 'Jawaban mengalir token demi token ke layar.'],
    email: ['Email masuk terdeteksi realtime (IMAP IDLE).', 'Dicocokkan ke percakapan; email massal/marketing diabaikan.', 'Sesuai kebijakan: dibalas otomatis, dibuatkan draf untuk disetujui, atau hanya diberitahukan ke Telegram. Rapat di email langsung masuk jadwal.'],
    companion: ['Setiap 10 menit membaca keadaan Anda (lama bekerja, tugas, jam).', 'Bila pantas (maks 3x/hari, jeda ≥ 90 menit, 07:00–21:30) AI menulis sapaan peduli.', 'Dikirim ke Telegram dan diingat, jadi balasan Anda nyambung.'],
    briefing: ['Pagi hari kerja: jadwal, pengingat, email & tugas disusun dari data (tanpa AI, 0 token).', 'Dikirim ke Telegram.'],
    automation: ['Kampanye & pesan terjadwal; AI dipakai bila perlu menulis draf.'],
    system: ['Panggilan AI internal lain (CLI, prompt lab, tugas latar).'],
  };
  const list = flows[id];
  if (!list) return null;
  return (
    <>
      <h4>Apa yang terjadi di kanal ini</h4>
      <ol className="sm-flow">{list.map((s, i) => <li key={i}>{s}</li>)}</ol>
    </>
  );
}

function Meter({ used, limit, label }) {
  if (limit == null || !Number.isFinite(Number(limit)) || Number(limit) <= 0) return null;
  const pct = Math.max(0, Math.min(100, (Number(used) / Number(limit)) * 100));
  return (
    <div className="sm-meter" role="meter" aria-valuemin={0} aria-valuemax={Number(limit)} aria-valuenow={Number(used)} aria-label={label}>
      <span style={{ width: `${pct}%` }} className={pct > 85 ? 'hot' : pct > 60 ? 'warm' : ''} />
    </div>
  );
}

function ProviderCard({ p, tech, expanded = false, onOpen }) {
  const st = providerStatus(p);
  const h = p.quota?.headers;
  const a = p.quota?.api;
  const hasProviderData = Boolean(h || (a && !a.error));
  return (
    <div className={`sm-card ${expanded ? 'expanded' : ''}`}>
      <div className="sm-card-head">
        <button type="button" className="sm-card-name" onClick={onOpen} disabled={!onOpen}>
          {p.isDefault ? '⭐ ' : ''}{p.label}
        </button>
        <span className={`sm-badge ${st.tone}`}>{st.text}</span>
      </div>
      <div className="sm-card-sub">tier {p.tier} · {p.modelCount} model · {p.host || '-'}</div>
      <div className="sm-kv"><span>Token hari ini (dihitung Wanar)</span><b>{fmtNum(p.usageToday)}</b></div>

      {a && !a.error && (
        <div className="sm-quota">
          <div className="sm-quota-src">Dari provider · {a.source} · {fmtClock(a.at)}</div>
          {a.creditLimit != null
            ? <><div className="sm-kv"><span>Sisa kredit</span><b>${Number(a.creditRemaining ?? 0).toFixed(4)} dari ${Number(a.creditLimit).toFixed(2)}</b></div><Meter used={a.creditUsed} limit={a.creditLimit} label="Kredit terpakai" /></>
            : <div className="sm-kv"><span>Batas kredit</span><b>tanpa batas (bayar sesuai pakai)</b></div>}
          {a.creditUsed != null && <div className="sm-kv"><span>Kredit terpakai</span><b>${Number(a.creditUsed).toFixed(4)}</b></div>}
          {a.freeTier != null && <div className="sm-kv"><span>Akun gratis</span><b>{a.freeTier ? 'ya (kuota model :free terbatas per hari)' : 'tidak'}</b></div>}
        </div>
      )}
      {a?.error && <div className="sm-quota err">Gagal membaca kuota dari provider: {a.error}</div>}
      {h && (
        <div className="sm-quota">
          <div className="sm-quota-src">Dari header rate-limit respons terakhir · {fmtClock(h.at)}</div>
          {h.info.remainingRequests != null && <><div className="sm-kv"><span>Sisa request</span><b>{h.info.remainingRequests}{h.info.limitRequests ? ` / ${h.info.limitRequests}` : ''}</b></div><Meter used={Number(h.info.limitRequests) - Number(h.info.remainingRequests)} limit={h.info.limitRequests} label="Request terpakai" /></>}
          {h.info.remainingTokens != null && <><div className="sm-kv"><span>Sisa token</span><b>{fmtNum(h.info.remainingTokens)}{h.info.limitTokens ? ` / ${fmtNum(h.info.limitTokens)}` : ''}</b></div><Meter used={Number(h.info.limitTokens) - Number(h.info.remainingTokens)} limit={h.info.limitTokens} label="Token terpakai" /></>}
          {(h.info.resetRequests || h.info.resetTokens) && <div className="sm-kv"><span>Reset</span><b>{h.info.resetRequests || h.info.resetTokens}</b></div>}
          {h.info.retryAfter && <div className="sm-kv"><span>Coba lagi setelah</span><b>{h.info.retryAfter} dtk</b></div>}
          {tech && <Raw value={h.raw} />}
        </div>
      )}
      {p.configured && !hasProviderData && (
        <div className="sm-quota muted">Provider ini tidak mengirim sisa kuota (lewat API maupun header) — yang tampil hanya pemakaian yang dihitung Wanar dan status kuota dari kegagalan nyata (mis. “kuota habis, pulih jam …”).</div>
      )}
      {expanded && (
        <>
          <h4>Model ({p.modelCount})</h4>
          <div className="sm-models">
            {(p.models || []).map((m) => (
              <div key={m.id} className={`sm-model ${m.skip ? 'warn' : m.lastSuccess ? 'ok' : ''}`}>
                <span className="sm-model-id">{m.id}{m.id === p.defaultModel ? ' · default' : ''}</span>
                <span className="sm-model-meta">{fmtNum(m.tokensToday)} tkn · {m.skip ? skipText(m.skip) : m.lastSuccess ? `berhasil ${fmtClock(m.lastSuccess)}` : 'siap'}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function QuotaPanel({ overview, tech, refreshing, onRefresh, onOpenProvider }) {
  if (!overview) return <p className="sm-empty">Memuat…</p>;
  const u = overview.usage;
  const live = overview.providers.filter((p) => p.configured);
  const idle = overview.providers.filter((p) => !p.configured);
  return (
    <div>
      <div className="sm-card total">
        <div className="sm-card-head"><b>Token hari ini — semua kanal</b><button type="button" className="sm-btn small" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Memuat…' : '↻ Tanya provider'}</button></div>
        <div className="sm-big">{fmtNum(u.total)}{u.limit ? <small> / {fmtNum(u.limit)} batas harian</small> : null}</div>
        <Meter used={u.total} limit={u.limit} label="Token harian terpakai" />
        {u.limit && <div className="sm-kv"><span>Sisa anggaran harian Wanar</span><b>{fmtNum(u.remaining)}</b></div>}
        <div className="sm-quota-src">{u.source} · {u.date}. Sisa kuota tiap provider ada di kartu di bawah, beserta sumber datanya.</div>
      </div>
      {live.map((p) => <ProviderCard key={p.id} p={p} tech={tech} onOpen={() => onOpenProvider(p)} />)}
      {idle.length > 0 && (
        <details className="sm-idle">
          <summary>{idle.length} provider belum aktif (API key belum diisi)</summary>
          <p>{idle.map((p) => p.label).join(', ')}</p>
        </details>
      )}
    </div>
  );
}

function HelpPanel() {
  return (
    <div className="sm-help">
      <h4>Cara membaca peta</h4>
      <ul>
        <li><b>Kiri</b> — kanal masuk: Chat Web, Telegram, Email, Sapaan Peka, Briefing, Otomasi, Sistem.</li>
        <li><b>Tengah</b> — 🧠 Wanar Core: memutuskan dijawab kode atau AI, lalu router memilih model. Di bawahnya 🛠️ alat.</li>
        <li><b>Kanan</b> — provider aktif (⭐ = default) dan modelnya. Provider redup di belakang = belum ada API key.</li>
        <li><b>Cincin</b> di node: <span className="c-ok">hijau</span> sehat · <span className="c-warn">oranye</span> ada model jeda/kuota · <span className="c-err">merah</span> key ditolak/dikarantina · abu-abu nonaktif.</li>
      </ul>
      <h4>Arti titik cahaya</h4>
      <ul>
        <li><span className="c-in">●</span> biru — pesan masuk dari kanal ke Core (gelembungnya berisi potongan pesan).</li>
        <li><span className="c-warn">●</span> kuning — Core mengirim permintaan ke provider → model.</li>
        <li><span className="c-ok">●</span> hijau — jawaban kembali dari model, atau terkirim ke kanal.</li>
        <li><span className="c-err">●</span> merah — gagal (kuota, rate limit, key, dll) → router pindah otomatis.</li>
        <li><span className="c-tool">●</span> ungu — AI memakai alat dan hasilnya kembali.</li>
      </ul>
      <h4>Interaksi</h4>
      <ul>
        <li>Klik/ketuk <b>titik cahaya</b> atau gelembung pesan → seluruh proses pesan itu: isi pesan, keputusan, rute & alasannya, setiap percobaan, token, jawaban, dan ke mana dikirim.</li>
        <li>Klik <b>node</b> → status kanal / provider / model, kuota & sisa token.</li>
        <li>Seret untuk memutar, cubit/scroll untuk zoom, <b>⟲ Pusatkan</b> untuk kembali.</li>
        <li><b>Mode Teknis</b> menampilkan data mentah (argumen alat, error asli, header rate-limit).</li>
      </ul>
      <h4>Tentang angka token & kuota</h4>
      <ul>
        <li>“asli” = dilaporkan provider; “perkiraan” = dihitung dari panjang teks (≈ 3,6 karakter/token) karena provider tidak mengirim angkanya.</li>
        <li>Sisa kuota hanya ditampilkan bila provider memberikannya (API resmi atau header rate-limit). Bila tidak, peta jujur menyatakan tidak tersedia.</li>
      </ul>
    </div>
  );
}
