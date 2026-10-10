/**
 * FlowchartCanvas — kanvas SVG tunggal (lane → edges → nodes → efek)
 * + zoom/pan, minimap, follow, tooltip, highlight cabang decision.
 * by Wisnu Alfian Nur Ashar
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { FlowGraph, FlowNode, FlowState, ViewMode } from './types';
import { CANVAS_H, CANVAS_W, LANE_W, LANE_X, edgeLabelPoint, edgePath, getNode } from './flowGraph';
import { TRAVEL_MS } from './flowGraph';
import { deriveAll } from './deriveStatus';
import { FlowEdgePath } from './FlowEdgePath';
import { FlowNodeShape } from './FlowNodeShape';

interface Props {
  flow: FlowState;
  graph: FlowGraph;
  mode: ViewMode;
  toolLabel: { title: string; desc: string } | null;
  activeNodeRef?: RefObject<SVGGElement>;
  onNodeSelect?: (node: FlowNode | null) => void;
  onTraceChange?: (edgeIds: string[]) => void;
}

interface View { k: number; tx: number; ty: number }

const MIN_K = 0.4;
const MAX_K = 3;

function clampK(k: number): number {
  return Math.min(MAX_K, Math.max(MIN_K, k));
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function readFlowSpeed(wrap: HTMLDivElement | null): number {
  if (!wrap) return 1;
  const raw = getComputedStyle(wrap).getPropertyValue('--flow-speed').trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Tick ringan — HANYA saat ada edge aktif; bukan per-frame. */
function useFlowTick(active: boolean): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick(Date.now()), Math.max(80, TRAVEL_MS / 6));
    return () => window.clearInterval(id);
  }, [active]);
  return tick;
}

interface TooltipData {
  node: FlowNode;
  x: number;
  y: number;
  status: string;
  duration: string;
}

export function FlowchartCanvas({ flow, graph, mode, toolLabel, activeNodeRef, onNodeSelect, onTraceChange }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [flowSpeed, setFlowSpeed] = useState(1);
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const [follow, setFollow] = useState(true);
  const [animateView, setAnimateView] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [selected, setSelected] = useState<FlowNode | null>(null);
  const [trace, setTrace] = useState<string[]>([]);
  const traceRunRef = useRef<number | null>(null);
  const lastEdgeRef = useRef<string | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const paths = useMemo(
    () => graph.edges.map(e => ({ edge: e, d: edgePath(e), lp: edgeLabelPoint(e, edgePath(e)) })),
    [graph],
  );

  useEffect(() => { setFlowSpeed(readFlowSpeed(wrapRef.current)); }, []);

  const tick = useFlowTick(
    flow.stage === 'user_input' || flow.stage === 'thinking'
      || flow.stage === 'tool_running' || (flow.stage === 'error' && !flow.finishedAt),
  );
  const derived = deriveAll(flow, graph, tick);

  const runKey = flow.startedAt;
  useEffect(() => {
    if (traceRunRef.current !== runKey) {
      traceRunRef.current = runKey ?? null;
      setTrace([]);
      lastEdgeRef.current = null;
    }
  }, [runKey]);

  useEffect(() => {
    const id = derived.activeEdge;
    if (!id || id === lastEdgeRef.current) return;
    lastEdgeRef.current = id;
    setTrace(t => (t[t.length - 1] === id ? t : [...t, id]));
  }, [derived.activeEdge]);

  useEffect(() => { onTraceChange?.(trace); }, [trace, onTraceChange]);

  const activeNodeId = useMemo(
    () => Object.keys(derived.nodes).find(id => derived.nodes[id] === 'active') ?? null,
    [derived.nodes],
  );

  /** world (viewBox) → pixel layar relatif ke wrap */
  const worldToPx = useCallback((wx: number, wy: number): [number, number] => {
    const el = svgRef.current;
    if (!el) return [0, 0];
    const r = el.getBoundingClientRect();
    const s = Math.min(r.width / CANVAS_W, r.height / CANVAS_H);
    const ox = (r.width - CANVAS_W * s) / 2;
    const oy = (r.height - CANVAS_H * s) / 2;
    return [ox + (wx * view.k + view.tx) * s, oy + (wy * view.k + view.ty) * s];
  }, [view]);

  const handleNodeEnter = useCallback((node: FlowNode) => {
    const status = derived.nodes[node.id] ?? 'pending';
    let duration = '—';
    if (node.id === 'tool_running' && flow.steps.length > 0) {
      const total = flow.steps.reduce((acc, s) => acc + ((s.finishedAt ?? Date.now()) - s.startedAt), 0);
      duration = `${Math.round(total / 100) / 10}s · ${flow.steps.length}×`;
    } else if (flow.startedAt && flow.finishedAt) {
      duration = `${Math.round((flow.finishedAt - flow.startedAt) / 100) / 10}s total`;
    } else if (flow.startedAt && activeNodeId === node.id) {
      duration = `${Math.round((Date.now() - flow.startedAt) / 100) / 10}s berjalan`;
    }
    const [px, py] = worldToPx(node.x + node.w / 2, node.y);
    setTooltip({ node, x: px, y: py, status, duration });
  }, [derived.nodes, flow, activeNodeId, worldToPx]);

  const handleNodeLeave = useCallback(() => setTooltip(null), []);

  const handleNodeClick = useCallback((node: FlowNode) => {
    setSelected(prev => {
      const next = prev?.id === node.id ? null : node;
      onNodeSelect?.(next);
      return next;
    });
  }, [onNodeSelect]);

  // ── wheel zoom (non-passive, preventDefault) ──
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / CANVAS_W, r.height / CANVAS_H);
      const ox = (r.width - CANVAS_W * s) / 2;
      const oy = (r.height - CANVAS_H * s) / 2;
      const vx = (e.clientX - r.left - ox) / s;
      const vy = (e.clientY - r.top - oy) / s;
      setView(v0 => {
        const k = clampK(v0.k * Math.exp(-e.deltaY * 0.0016));
        const wx = (vx - v0.tx) / v0.k;
        const wy = (vy - v0.ty) / v0.k;
        return { k, tx: vx - wx * k, ty: vy - wy * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setAnimateView(false);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = Math.min(r.width / CANVAS_W, r.height / CANVAS_H);
    const dx = (e.clientX - d.x) / s;
    const dy = (e.clientY - d.y) / s;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setView(v0 => ({ ...v0, tx: v0.tx + dx, ty: v0.ty + dy }));
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const resetView = useCallback(() => {
    setAnimateView(true);
    setView({ k: 1, tx: 0, ty: 0 });
  }, []);

  // ── follow: auto-center node aktif ──
  useEffect(() => {
    if (!follow || !activeNodeId) return;
    const n = getNode(activeNodeId);
    setAnimateView(true);
    setView(v0 => ({
      k: Math.max(v0.k, 1),
      tx: CANVAS_W / 2 - (n.x + n.w / 2) * Math.max(v0.k, 1),
      ty: CANVAS_H / 2 - (n.y + n.h / 2) * Math.max(v0.k, 1),
    }));
  }, [follow, activeNodeId]);

  const decisionTraces = useMemo(() => {
    if (!selected) return null;
    const outs = graph.edges.filter(e => e.from === selected.id);
    if (outs.length === 0) return null;
    return {
      traced: new Set(outs.filter(e => trace.includes(e.id)).map(e => e.id)),
      all: new Set(outs.map(e => e.id)),
    };
  }, [selected, graph.edges, trace]);

  const viewport = useMemo(() => ({
    x: -view.tx / view.k,
    y: -view.ty / view.k,
    w: CANVAS_W / view.k,
    h: CANVAS_H / view.k,
  }), [view]);

  return (
    <div className="af-canvas-wrap" ref={wrapRef}>
      <div className="af-controls" role="group" aria-label="Kontrol tampilan diagram">
        <button className="af-ctrl-btn" onClick={() => setView(v0 => ({ ...v0, k: clampK(v0.k * 1.25) }))} aria-label="Perbesar">＋</button>
        <button className="af-ctrl-btn" onClick={() => setView(v0 => ({ ...v0, k: clampK(v0.k / 1.25) }))} aria-label="Perkecil">－</button>
        <button className="af-ctrl-btn" onClick={resetView}>⟲ Reset</button>
        <label className="af-ctrl-follow">
          <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />
          Ikuti node aktif
        </label>
        <span className="af-ctrl-zoom">{Math.round(view.k * 100)}%</span>
      </div>

      <div className="af-canvas-scroll">
        <svg
          ref={svgRef}
          className="af-svg"
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Diagram alur kerja agent"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          <defs>
            <marker
              id="af-arrow" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="8" markerHeight="6" orient="auto-start-reverse"
            >
              <path className="af-arrowhead" d="M0 0 L10 5 L0 10 Z" />
            </marker>
            <linearGradient id="af-active-grad" x1="-1" y1="0" x2="0" y2="0">
              <stop offset="0%" stopColor="#F59E0B" stopOpacity="0" />
              <stop offset="50%" stopColor="#FDE68A" stopOpacity="1" />
              <stop offset="100%" stopColor="#F59E0B" stopOpacity="0" />
              <animate attributeName="x1" values="-1;1" dur="1.8s" repeatCount="indefinite" />
              <animate attributeName="x2" values="0;2" dur="1.8s" repeatCount="indefinite" />
            </linearGradient>
          </defs>

          <rect className="af-canvas-bg" x={0} y={0} width={CANVAS_W} height={CANVAS_H} />

          <g
            className={`af-viewport${animateView ? ' af-view-anim' : ''}`}
            transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}
          >
            {graph.lanes.map(lane => (
              <g key={lane.id} className="af-lane">
                <line className="af-lane-sep" x1={LANE_X} y1={lane.y} x2={LANE_X + LANE_W} y2={lane.y} />
                <g className="af-lane-chip" transform={`translate(${CANVAS_W / 2} ${lane.y})`}>
                  <rect className={`af-lane-chip-bg af-tone-${lane.tone}`} x={-90} y={-11} width={180} height={22} rx={2} />
                  <text className="af-lane-chip-text" x={0} y={5} textAnchor="middle">{lane.title}</text>
                </g>
              </g>
            ))}

            <g className="af-edges">
              {paths.map(({ edge, d, lp }) => (
                <FlowEdgePath
                  key={edge.id}
                  edge={edge}
                  d={d}
                  status={derived.edges[edge.id] ?? 'idle'}
                  mode={mode}
                  labelPoint={lp}
                  reducedMotion={reducedMotion}
                  flowSpeed={flowSpeed}
                  traced={decisionTraces ? decisionTraces.traced.has(edge.id) : undefined}
                  untraced={decisionTraces
                    ? decisionTraces.all.has(edge.id) && !decisionTraces.traced.has(edge.id)
                    : undefined}
                />
              ))}
            </g>

            <g className="af-nodes">
              {graph.nodes.map(node => {
                const status = derived.nodes[node.id] ?? 'pending';
                const isActive = status === 'active';
                const isToolNode = node.id === 'tool_running';
                return (
                  <FlowNodeShape
                    key={isToolNode ? `tool_running-${flow.steps.length}` : node.id}
                    node={node}
                    status={status}
                    mode={mode}
                    label={isToolNode && (toolLabel || isActive) ? toolLabel : null}
                    badge={isToolNode && isActive ? 'RUNNING' : null}
                    nodeRef={isActive ? activeNodeRef : undefined}
                    onNodeEnter={handleNodeEnter}
                    onNodeLeave={handleNodeLeave}
                    onNodeClick={handleNodeClick}
                  />
                );
              })}
            </g>
          </g>
        </svg>

        {/* Mini-map */}
        <svg
          className="af-minimap"
          width={150}
          height={100}
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          aria-label="Peta kecil diagram"
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect();
            const s = Math.min(r.width / CANVAS_W, r.height / CANVAS_H);
            const wx = (e.clientX - r.left) / s;
            const wy = (e.clientY - r.top) / s;
            setAnimateView(true);
            setView(v0 => ({ ...v0, tx: CANVAS_W / 2 - wx * v0.k, ty: CANVAS_H / 2 - wy * v0.k }));
          }}
        >
          <rect className="af-mm-bg" x={0} y={0} width={CANVAS_W} height={CANVAS_H} />
          {graph.nodes.map(n => (
            <rect
              key={n.id}
              className={`af-mm-node af-mm-${derived.nodes[n.id] ?? 'pending'}`}
              x={n.x} y={n.y} width={n.w} height={n.h} rx={8}
            />
          ))}
          <rect
            className="af-mm-viewport"
            x={viewport.x} y={viewport.y} width={viewport.w} height={viewport.h}
          />
        </svg>
      </div>

      {tooltip && (
        <div className="af-tooltip" style={{ left: tooltip.x, top: tooltip.y }} role="tooltip">
          <div className="af-tooltip-title">{tooltip.node.simple.title}</div>
          <div className="af-tooltip-desc">{tooltip.node.simple.desc}</div>
          <div className="af-tooltip-meta">
            <span className={`af-tooltip-status af-st-${tooltip.status}`}>{tooltip.status}</span>
            <span>⏱ {tooltip.duration}</span>
          </div>
          {mode === 'tech' && <div className="af-tooltip-tech">{tooltip.node.tech.title}</div>}
        </div>
      )}

      {mode === 'tech' && (
        <div className="af-tech-note">
          Loop: <code>thinking → tool_calls → tool_result → thinking</code> · maks 25 iterasi ·
          klik node decision untuk menyorot cabang yang diambil (trace run ini)
        </div>
      )}
    </div>
  );
}
