/**
 * AgentFlow Component - Visualisasi alur kerja AI Agent (v2, swimlane klinis)
 * by Wisnu Alfian Nur Ashar
 *
 * Menampilkan:
 *  - Flowchart swimlane bergaya referensi klinis (bentuk node standar + edge orthogonal)
 *  - "Garis hidup": dash berjalan + comet dot mengikuti proses nyata
 *  - Baris aktivitas live (AgentLiveBar), riwayat failover, daftar tool
 *  - Tombol "▶ Simulasi Demo" untuk melihat animasi tanpa backend
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlowGraph, FlowNode, FlowState, ViewMode } from './agentflow/types';
import { AGENT_GRAPH } from './agentflow/flowGraph';
import { FlowchartCanvas } from './agentflow/FlowchartCanvas';
import './agentflow/agentflow.css';

// ── Metadata tool → layanan yang benar-benar dipakai di backend ──
interface ToolMeta { service: string; label: string; icon: string; color: string }

const TOOL_META: Record<string, ToolMeta> = {
  browser_open: { service: 'Playwright (Chromium)', label: 'Membuka halaman web', icon: '🌐', color: '#0ea5e9' },
  browser_search_page: { service: 'Playwright (Chromium)', label: 'Mencari teks di halaman', icon: '🔍', color: '#0ea5e9' },
  browser_extract_links: { service: 'Playwright (Chromium)', label: 'Mengambil daftar link', icon: '🔗', color: '#0ea5e9' },
  browser_crawl: { service: 'Playwright (Chromium)', label: 'Menjelajah banyak halaman', icon: '🕸️', color: '#0ea5e9' },
  browser_apply: { service: 'Playwright (Chromium)', label: 'Mengisi form lamaran', icon: '📝', color: '#10b981' },
  browser_job_scan: { service: 'Playwright (Chromium)', label: 'Scan lowongan kerja', icon: '💼', color: '#10b981' },
  web_fetch: { service: 'HTTP Fetch (axios)', label: 'Mengambil konten URL', icon: '📡', color: '#8b5cf6' },
  glob: { service: 'Filesystem', label: 'Mencari file', icon: '📁', color: '#f59e0b' },
  grep: { service: 'Filesystem', label: 'Mencari isi file', icon: '🔎', color: '#f59e0b' },
  file_info: { service: 'Filesystem', label: 'Info file', icon: '📄', color: '#f59e0b' },
  read_file: { service: 'Filesystem', label: 'Membaca file', icon: '📖', color: '#f59e0b' },
  write_file: { service: 'Filesystem', label: 'Menulis file', icon: '💾', color: '#f59e0b' },
  edit_file: { service: 'Filesystem', label: 'Mengubah file', icon: '✏️', color: '#f59e0b' },
  list_directory: { service: 'Filesystem', label: 'Melihat folder', icon: '📂', color: '#f59e0b' },
  bash: { service: 'Shell', label: 'Menjalankan perintah', icon: '⌨️', color: '#64748b' },
  npm: { service: 'Shell', label: 'Menjalankan npm', icon: '📦', color: '#64748b' },
  token_usage: { service: 'System', label: 'Cek pemakaian token', icon: '📊', color: '#64748b' },
  system_info: { service: 'System', label: 'Info sistem', icon: '💻', color: '#64748b' },
  database_stats: { service: 'System', label: 'Statistik database', icon: '🗄️', color: '#64748b' },
  security_scan: { service: 'Security Scanner', label: 'Scan keamanan', icon: '🛡️', color: '#ef4444' },
  auth_test: { service: 'Security Scanner', label: 'Uji autentikasi', icon: '🔐', color: '#ef4444' },
  api_fuzzing: { service: 'Security Scanner', label: 'Uji fuzzing API', icon: '🧪', color: '#ef4444' },
  code_audit: { service: 'Security Scanner', label: 'Audit kode', icon: '🔎', color: '#ef4444' },
  dependency_scan: { service: 'Security Scanner', label: 'Scan dependensi', icon: '📦', color: '#ef4444' },
  network_scan: { service: 'Security Scanner', label: 'Scan jaringan', icon: '📶', color: '#ef4444' },
  exploit_db_search: { service: 'Security Scanner', label: 'Cari exploit', icon: '💣', color: '#ef4444' },
  generate_report: { service: 'Security Scanner', label: 'Buat laporan', icon: '📋', color: '#ef4444' },
  todo_write: { service: 'Task Manager', label: 'Menyusun rencana', icon: '✅', color: '#14b8a6' },
  todo_read: { service: 'Task Manager', label: 'Membaca rencana', icon: '📝', color: '#14b8a6' },
  todo_complete: { service: 'Task Manager', label: 'Menyelesaikan tugas', icon: '🏁', color: '#14b8a6' },
  todo_clear: { service: 'Task Manager', label: 'Membersihkan tugas', icon: '🧹', color: '#14b8a6' },
  mouse_control: { service: 'Desktop Control', label: 'Menggerakkan mouse', icon: '🖱️', color: '#a855f7' },
  screen_capture: { service: 'Desktop Control', label: 'Menangkap layar', icon: '📸', color: '#a855f7' },
  agent_explore: { service: 'Sub-Agent', label: 'Menjelajah kode', icon: '🤖', color: '#6366f1' },
  agent_security: { service: 'Sub-Agent', label: 'Analisis keamanan', icon: '🤖', color: '#6366f1' },
  agent_refactor: { service: 'Sub-Agent', label: 'Refactor kode', icon: '🔧', color: '#6366f1' },
  agent_test: { service: 'Sub-Agent', label: 'Menulis test', icon: '🤖', color: '#6366f1' },
  agent_document: { service: 'Sub-Agent', label: 'Membuat dokumentasi', icon: '🤖', color: '#6366f1' },
  code_analysis: { service: 'Code Intelligence', label: 'Analisis kode', icon: '🧠', color: '#6366f1' },
  dependency_graph: { service: 'Code Intelligence', label: 'Graf dependensi', icon: '🕸️', color: '#6366f1' },
  code_metrics: { service: 'Code Intelligence', label: 'Metrik kode', icon: '📈', color: '#6366f1' },
  find_duplicates: { service: 'Code Intelligence', label: 'Cari duplikasi', icon: '🧬', color: '#6366f1' },
};

const DEFAULT_META: ToolMeta = { service: 'Tool', label: 'Menjalankan alat', icon: '⚙️', color: '#64748b' };

export function getToolMeta(name: string): ToolMeta {
  return TOOL_META[name] || { ...DEFAULT_META, service: name, label: `Menjalankan ${name}` };
}

export function failoverReasonSimple(reason: string): string {
  switch (reason) {
    case 'timeout': return 'mesin itu terlalu lama menjawab';
    case 'rate-limit': return 'mesin itu sedang penuh (kuota habis sementara)';
    case 'error': return 'mesin itu sedang bermasalah';
    case 'network': return 'koneksi ke mesin itu putus';
    case 'empty': return 'mesin itu tidak menjawab';
    case 'same-provider': return 'coba model lain yang masih tersedia';
    case 'cross-provider': return 'coba mesin lain yang masih sehat';
    default: return 'mesin itu gagal, coba yang lain';
  }
}

function StatusDot({ status }: { status: 'done' | 'active' | 'pending' | 'error' }) {
  const color = status === 'done' ? '#10b981'
    : status === 'active' ? '#f59e0b'
    : status === 'error' ? '#ef4444'
    : '#cbd5e1';
  return (
    <span style={{
      display: 'inline-block',
      width: '10px',
      height: '10px',
      borderRadius: '50%',
      background: color,
      boxShadow: status === 'active' || status === 'error' ? `0 0 0 4px ${color}22` : 'none',
      animation: status === 'active' ? 'flowPulse 1.2s ease-in-out infinite' : 'none',
      flexShrink: 0,
    }} />
  );
}

/**
 * Baris aktivitas live — "popup line" yang berjalan.
 */
export function AgentLiveBar({ flow }: { flow: FlowState | null }) {
  if (!flow) return null;
  const active = flow.activeTool;
  if (!active && flow.stage !== 'thinking') return null;

  const meta = active ? getToolMeta(active.name) : null;
  const text = meta ? `${meta.service} — ${meta.label}` : 'AI sedang berpikir…';
  const switches = flow.switches || [];
  const via = flow.activeProvider && switches.length > 0
    ? `via ${flow.activeProvider}${flow.activeModel ? '/' + flow.activeModel : ''}`
    : null;

  return (
    <div className="agent-live-bar" role="status" aria-live="polite">
      <span className="agent-live-bar-spinner" aria-hidden="true" />
      <span className="agent-live-bar-text">{text}</span>
      {via && <span className="agent-live-bar-via">{via}</span>}
    </div>
  );
}

interface DemoEvent {
  after: number;
  patch: Partial<FlowState>;
}

const IDLE_DEMO: FlowState = {
  stage: 'idle', steps: [], activeTool: null, activeProvider: null,
  activeModel: null, switches: [], startedAt: null, finishedAt: null, error: null,
};

const DEMO_SCRIPT: DemoEvent[] = [
  { after: 0, patch: { stage: 'user_input', startedAt: Date.now(), finishedAt: null, error: null, steps: [], switches: [], activeTool: null } },
  { after: 1300, patch: { stage: 'thinking' } },
  { after: 1500, patch: {
    stage: 'tool_running', activeProvider: 'openagentic', activeModel: 'glm-5.3-flash',
    activeTool: { name: 'browser_open', startedAt: Date.now() },
    steps: [{ name: 'browser_open', status: 'running', startedAt: Date.now() }],
  } },
  { after: 2000, patch: {
    stage: 'thinking', activeTool: null,
    steps: [{ name: 'browser_open', status: 'done', startedAt: Date.now() - 2000, finishedAt: Date.now() }],
  } },
  { after: 1200, patch: {
    stage: 'tool_running', activeTool: { name: 'browser_search_page', startedAt: Date.now() },
    steps: [
      { name: 'browser_open', status: 'done', startedAt: Date.now() - 4000, finishedAt: Date.now() - 2000 },
      { name: 'browser_search_page', status: 'running', startedAt: Date.now() },
    ],
  } },
  { after: 1700, patch: {
    stage: 'thinking', activeTool: null,
    steps: [
      { name: 'browser_open', status: 'done', startedAt: Date.now() - 5700, finishedAt: Date.now() - 3700 },
      { name: 'browser_search_page', status: 'done', startedAt: Date.now() - 1700, finishedAt: Date.now() },
    ],
  } },
  { after: 1200, patch: {
    switches: [{ from: 'glm-5.3-flash', to: 'grok-4.5', model: 'grok-4.5', reason: 'rate-limit', at: Date.now() }],
  } },
  { after: 1000, patch: { stage: 'done', activeTool: null, finishedAt: Date.now() } },
];

function edgeIdsForNode(graph: FlowGraph, nodeId: string): string[] {
  return graph.edges.filter(e => e.from === nodeId || e.to === nodeId).map(e => e.id);
}

export default function AgentFlow({ flow, onClose }: { flow: FlowState; onClose: () => void }) {
  const [mode, setMode] = useState<ViewMode>('simple');
  const [demo, setDemo] = useState<FlowState | null>(null);
  const demoTimersRef = useRef<number[]>([]);
  const activeNodeRef = useRef<SVGGElement>(null);

  const view = demo ?? flow;
  const steps = view.steps || [];

  const clearDemo = useCallback(() => {
    demoTimersRef.current.forEach(t => window.clearTimeout(t));
    demoTimersRef.current = [];
    setDemo(null);
  }, []);

  const startDemo = useCallback(() => {
    clearDemo();
    let acc = 0;
    let state: FlowState = { ...IDLE_DEMO };
    setDemo(state);
    DEMO_SCRIPT.forEach(ev => {
      acc += ev.after;
      const t = window.setTimeout(() => {
        state = { ...state, ...ev.patch };
        setDemo(state);
        if (ev.patch.stage === 'done') {
          const stop = window.setTimeout(() => setDemo(null), 4200);
          demoTimersRef.current.push(stop);
        }
      }, acc);
      demoTimersRef.current.push(t);
    });
  }, [clearDemo]);

  const stopDemo = useCallback(() => { clearDemo(); }, [clearDemo]);

  useEffect(() => () => clearDemo(), [clearDemo]);

  const modalRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Esc: keluar fullscreen dulu, tekan lagi baru tutup modal.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.fullscreenElement) {
        e.stopPropagation();
        document.exitFullscreen().catch(() => {});
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (modalRef.current?.requestFullscreen) {
        await modalRef.current.requestFullscreen();
      }
    } catch { /* beberapa browser menolak; abaikan */ }
  }, []);

  useEffect(() => {
    activeNodeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [view.stage, steps.length]);

  const elapsed = useMemo(() => {
    if (!view.startedAt) return 0;
    const end = view.finishedAt || Date.now();
    return Math.max(0, Math.round((end - view.startedAt) / 100) / 10);
  }, [view.startedAt, view.finishedAt]);

  const isRunning = Boolean(view.stage) && !['idle', 'done', 'error', 'stopped'].includes(view.stage);
  const switches = view.switches || [];
  const shownSwitches = switches.filter(s => s.reason !== 'initial');

  const toolLabel = useMemo(() => {
    if (!view.activeTool) return null;
    const meta = getToolMeta(view.activeTool.name);
    return mode === 'simple'
      ? { title: meta.label, desc: meta.service }
      : { title: view.activeTool.name, desc: meta.service };
  }, [view.activeTool, mode]);

  const [selectedNode, setSelectedNode] = useState<FlowNode | null>(null);
  const [trace, setTrace] = useState<string[]>([]);

  useEffect(() => { setSelectedNode(null); }, [view.startedAt]);

  const panelRows = useMemo(() => {
    if (!selectedNode) return null;
    const id = selectedNode.id;
    if (id === 'tool_running' || id === 'tool_result') {
      if (steps.length === 0) return [];
      return steps.map((s, i) => {
        const meta = getToolMeta(s.name);
        const dur = s.finishedAt && s.startedAt ? `${Math.round((s.finishedAt - s.startedAt) / 100) / 10}s` : 'berjalan…';
        return { key: i, icon: meta.icon, name: mode === 'simple' ? meta.label : s.name, detail: `${meta.service} · ${dur}`, state: s.status };
      });
    }
    if (id === 'thinking' || id === 'needs_tool') {
      return [{
        key: 0, icon: '🧠', name: mode === 'simple' ? 'Sesi berpikir' : 'chatStream()',
        detail: `${steps.length} tool diputuskan AI · via ${view.activeProvider ?? '?'}${view.activeModel ? '/' + view.activeModel : ''}`,
        state: 'done' as const,
      }];
    }
    if (id === 'retry' || id === 'failover' || id === 'err_end') {
      const sw = (view.switches || []).filter(s => s.reason !== 'initial');
      if (sw.length === 0) return [];
      return sw.map((s, i) => ({
        key: i, icon: '🔀', name: `${s.from ?? '?'} → ${s.to}`,
        detail: mode === 'simple' ? failoverReasonSimple(s.reason) : s.reason,
        state: 'done' as const,
      }));
    }
    return [];
  }, [selectedNode, steps, mode, view.activeProvider, view.activeModel, view.switches]);

  return (
    <div className={`agent-flow-overlay ${isFullscreen ? 'is-fullscreen' : ''}`} onClick={onClose}>
      <div ref={modalRef} className={`agent-flow-modal glass-strong ${isFullscreen ? 'fullscreen' : ''}`} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="agent-flow-header">
          <div>
            <div className="agent-flow-title">
              <span className="agent-flow-title-icon">🧭</span>
              Alur Kerja AI Agent
            </div>
            <div className="agent-flow-subtitle">
              {demo ? 'Simulasi demo — garis hidup berjalan tanpa backend'
                : isRunning ? 'Sedang berjalan — garis menyala mengikuti proses nyata'
                : view.stage === 'done' ? `Selesai dalam ${elapsed}s`
                : view.stage === 'error' ? 'Berhenti karena error'
                : view.stage === 'stopped' ? 'Dihentikan'
                : 'Belum ada aktivitas — kirim pesan atau jalankan simulasi'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className={`af-demo-btn${demo ? ' on' : ''}`}
              onClick={demo ? stopDemo : startDemo}
            >
              {demo ? '⏹ Stop Demo' : '▶ Simulasi Demo'}
            </button>
            <button
              className="af-fullscreen-btn"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Keluar layar penuh' : 'Layar penuh'}
              title={isFullscreen ? 'Keluar layar penuh (Esc)' : 'Perbesar ke seluruh layar'}
            >
              {isFullscreen ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20"/>
                  <polyline points="20 10 14 10 14 4"/>
                  <line x1="14" y1="10" x2="21" y2="3"/>
                  <line x1="3" y1="21" x2="10" y2="14"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9"/>
                  <polyline points="9 21 3 21 3 15"/>
                  <line x1="21" y1="3" x2="14" y2="10"/>
                  <line x1="3" y1="21" x2="10" y2="14"/>
                </svg>
              )}
            </button>
            <button className="agent-flow-close" onClick={onClose} aria-label="Tutup">✕</button>
          </div>
        </div>

        {/* Mode toggle */}
        <div className="agent-flow-toggle">
          <button className={mode === 'simple' ? 'active' : ''} onClick={() => setMode('simple')}>Mode Dasar</button>
          <button className={mode === 'tech' ? 'active' : ''} onClick={() => setMode('tech')}>Mode Teknis</button>
        </div>

        {/* Canvas */}
        <div className="agent-flow-body">
          <FlowchartCanvas
            flow={view}
            graph={AGENT_GRAPH}
            mode={mode}
            toolLabel={toolLabel}
            activeNodeRef={activeNodeRef}
            onNodeSelect={setSelectedNode}
            onTraceChange={setTrace}
          />

          {/* Panel samping: detail node terpilih */}
          {selectedNode && (
            <aside className="af-panel" aria-label={`Detail node ${selectedNode.simple.title}`}>
              <div className="af-panel-head">
                <span>
                  {mode === 'simple' ? selectedNode.simple.title : selectedNode.tech.title}
                  {' — '}
                  <em style={{ fontWeight: 500, fontStyle: 'normal', color: 'var(--text-tertiary)' }}>
                    {trace.length > 0
                      ? `dilewati ${trace.some(id => edgeIdsForNode(AGENT_GRAPH, selectedNode.id).includes(id)) ? 'ya' : 'belum'} pada run ini`
                      : 'klik setelah run untuk melihat jejak'}
                  </em>
                </span>
                <button className="af-panel-close" onClick={() => setSelectedNode(null)} aria-label="Tutup panel">✕</button>
              </div>
              {panelRows && panelRows.length > 0 ? panelRows.map(r => (
                <div key={r.key} className="af-panel-item">
                  <span><b>{r.icon} {r.name}</b> · {r.detail}</span>
                  <span className={r.state === 'error' ? 'err' : 'ok'}>{r.state === 'error' ? 'gagal' : r.state === 'running' ? 'jalan…' : 'ok'}</span>
                </div>
              )) : <div className="af-panel-empty">Tidak ada langkah tool terkait node ini.</div>}
            </aside>
          )}

          {/* Riwayat perpindahan provider/model otomatis */}
          {shownSwitches.length > 0 && (
            <div className="agent-flow-switches">
              <div className="agent-flow-section-label">
                {mode === 'simple' ? 'AI pindah mesin otomatis' : 'Provider failover'}
              </div>
              {shownSwitches.map((s, i) => (
                <div key={i} className="agent-flow-switch">
                  <span className="agent-flow-switch-icon">🔀</span>
                  <span className="agent-flow-switch-body">
                    <span className="agent-flow-switch-name">
                      {s.from || '?'} → {s.to}{s.model ? ` (${s.model})` : ''}
                    </span>
                    <span className="agent-flow-switch-reason">
                      {mode === 'simple' ? failoverReasonSimple(s.reason) : s.reason}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Langkah tool yang benar-benar dieksekusi */}
          {steps.length > 0 && (
            <div className="agent-flow-tools">
              <div className="agent-flow-section-label">
                {mode === 'simple' ? 'Alat yang dipakai AI' : 'Tool calls dieksekusi'}
              </div>
              {steps.map((s, i) => {
                const meta = getToolMeta(s.name);
                const dur = s.finishedAt && s.startedAt
                  ? ` · ${Math.round((s.finishedAt - s.startedAt) / 100) / 10}s`
                  : '';
                return (
                  <div key={i} className={`agent-flow-tool ${s.status}`}>
                    <span className="agent-flow-tool-icon" style={{ background: meta.color + '1a', color: meta.color }}>{meta.icon}</span>
                    <span className="agent-flow-tool-body">
                      <span className="agent-flow-tool-name">
                        {mode === 'simple' ? meta.label : s.name}
                        {s.status === 'running' && <span className="agent-live-dots"><i /><i /><i /></span>}
                      </span>
                      <span className="agent-flow-tool-service">
                        {meta.service}{dur}
                        {s.status === 'error' && ' · gagal'}
                        {s.status === 'done' && ' · selesai'}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Legend */}
        <div className="agent-flow-legend">
          <span><StatusDot status="done" /> Selesai</span>
          <span><StatusDot status="active" /> Sedang jalan</span>
          <span><StatusDot status="pending" /> Menunggu</span>
          <span><StatusDot status="error" /> Error</span>
        </div>

        {view.error && (
          <div className="agent-flow-error" style={{ margin: '0 16px 12px' }}>⚠️ {view.error}</div>
        )}
      </div>
    </div>
  );
}
