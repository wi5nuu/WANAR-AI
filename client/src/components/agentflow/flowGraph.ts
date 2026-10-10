/**
 * AGENT_GRAPH — deklaratif graf alur kerja agent + util routing orthogonal
 * by Wisnu Alfian Nur Ashar
 *
 * Aturan geometri (mengikuti referensi klinis):
 *  - diamond decision/merge: tinggi:lebar = 1:1.6
 *  - jarak minimum antar node = 40px
 *  - cabang Yes keluar SISI KANAN diamond, cabang No keluar SISI BAWAH
 *  - label Yes/No menempel di sisi keluar
 */

import type { FlowEdge, FlowGraph, FlowLane, FlowNode, Side } from './types';

export const CANVAS_W = 1200;
export const CANVAS_H = 820;
export const LANE_X = 20;
export const LANE_W = 1160;

export const TRAVEL_MS = 900;

export const LANES: FlowLane[] = [
  { id: 'input', title: 'Input & Parsing', tone: 'dark', y: 20, h: 180 },
  { id: 'reason', title: 'Reasoning / LLM', tone: 'light', y: 200, h: 220 },
  { id: 'tool', title: 'Tool Execution', tone: 'dark', y: 420, h: 220 },
  { id: 'out', title: 'Output & Delivery', tone: 'light', y: 640, h: 180 },
];

const N = (
  id: string, kind: FlowNode['kind'], lane: string,
  x: number, y: number, w: number, h: number,
  simple: FlowNode['simple'], tech: FlowNode['tech'], icon: string,
): FlowNode => ({ id, kind, lane, x, y, w, h, simple, tech, icon });

/**
 * Layout grid — semua pasangan node sejalur berjarak ≥ 40px.
 * diamond: w = 1.6h.
 */
export const NODES: FlowNode[] = [
  N('user_input', 'terminator', 'input', 60, 92, 200, 56,
    { title: 'Pesan Masuk', desc: 'Kamu mengirim pertanyaan' },
    { title: 'user_input', desc: 'POST /api/chat/stream' }, '💬'),

  N('parse', 'decision', 'input', 318, 50, 224, 140,
    { title: 'Pesan Valid?', desc: 'Cek maksud & kelayakan' },
    { title: 'parse_input', desc: 'intent + threshold check' }, ''),

  N('ctx', 'document', 'input', 620, 88, 200, 64,
    { title: 'Konteks Percakapan', desc: 'Riwayat & lampiran dirangkum' },
    { title: 'build_context', desc: 'history + attachments → prompt' }, ''),

  N('thinking', 'subprocess', 'reason', 320, 279, 220, 68,
    { title: 'AI Berpikir', desc: 'Membaca & merencanakan' },
    { title: 'LLM Reasoning', desc: 'chatStream() token by token' }, '🧠'),

  N('needs_tool', 'decision', 'reason', 660, 238, 240, 150,
    { title: 'Perlu Alat?', desc: 'Putuskan aksi berikutnya' },
    { title: 'tool_choice', desc: 'finish_reason = tool_calls | stop' }, ''),

  N('tool_running', 'subprocess', 'tool', 620, 480, 260, 76,
    { title: 'AI Memakai Alat', desc: 'Menjalankan tool pilihan AI' },
    { title: 'executeTool(name, args)', desc: 'tool dispatch + sandbox' }, '🛠️'),

  N('tool_result', 'document', 'tool', 960, 480, 200, 76,
    { title: 'Hasil Alat', desc: 'Keluaran tool dibaca AI' },
    { title: 'tool_result', desc: 'result → messages[tool]' }, ''),

  N('failover', 'merge', 'tool', 327, 488, 96, 60,
    { title: 'Gagal?', desc: 'Titik kumpul error' },
    { title: 'error_merge', desc: 'catch → retry policy' }, ''),

  N('retry', 'process', 'tool', 60, 480, 220, 76,
    { title: 'Pindah Mesin', desc: 'Cari provider lain yang sehat' },
    { title: 'smart-failover', desc: 'provider_switch event' }, '🔀'),

  N('compose', 'process', 'out', 460, 692, 200, 64,
    { title: 'Susun Jawaban', desc: 'Jawaban final disiapkan' },
    { title: 'compose_answer', desc: 'final content assembly' }, ''),

  N('stream', 'process', 'out', 700, 692, 180, 64,
    { title: 'Jawaban Dikirim', desc: 'Kata demi kata muncul' },
    { title: 'SSE stream', desc: 'data: {content} chunk' }, ''),

  N('done', 'terminator', 'out', 940, 696, 160, 56,
    { title: 'Selesai', desc: 'Jawaban lengkap tersaji' },
    { title: 'done', desc: 'finishedAt set' }, '✨'),

  N('err_end', 'terminator', 'out', 60, 696, 200, 56,
    { title: 'Berhenti (Error)', desc: 'Semua jalur habis' },
    { title: 'flow.error', desc: 'abort + error surfaced' }, ''),
];

const E = (
  id: string, from: string, to: string, extra: Partial<FlowEdge> = {},
): FlowEdge => ({ id, from, to, ...extra });

export const EDGES: FlowEdge[] = [
  E('e_input_parse', 'user_input', 'parse', {
    exitSide: 'right', entrySide: 'left', techLabel: 'on_submitted',
  }),
  // parse: Ya (kanan) → ctx ; Tidak (bawah) → failover
  E('e_parse_ctx', 'parse', 'ctx', {
    label: 'Ya', techLabel: 'valid', exitSide: 'right', entrySide: 'left', labelPos: [556, 110],
  }),
  E('e_parse_fail', 'parse', 'failover', {
    label: 'Tidak', techLabel: 'invalid', exitSide: 'bottom', entrySide: 'left',
    waypoints: [[430, 215], [285, 215], [285, 518]], labelPos: [444, 207],
  }),
  E('e_ctx_think', 'ctx', 'thinking', {
    exitSide: 'bottom', entrySide: 'top', waypoints: [[720, 250]],
  }),
  E('e_think_tool', 'thinking', 'needs_tool', {
    exitSide: 'right', entrySide: 'left', techLabel: 'thinking',
  }),
  // needs_tool: Ya (kanan) → tool_running ; Tidak (bawah) → compose
  E('e_tool_yes', 'needs_tool', 'tool_running', {
    label: 'Ya', techLabel: 'tool_calls', exitSide: 'right', entrySide: 'top',
    waypoints: [[930, 313], [930, 440], [750, 440]], labelPos: [908, 303],
  }),
  E('e_tool_no', 'needs_tool', 'compose', {
    label: 'Tidak', techLabel: 'stop', exitSide: 'bottom', entrySide: 'top',
    waypoints: [[780, 430], [560, 430]], labelPos: [793, 403],
  }),
  E('e_run_result', 'tool_running', 'tool_result', {
    exitSide: 'right', entrySide: 'left', techLabel: 'tool_end',
  }),
  // loop hasil → berpikir lagi
  E('e_result_think', 'tool_result', 'thinking', {
    techLabel: 'tool_result → loop', exitSide: 'top', entrySide: 'right',
    waypoints: [[1060, 230], [600, 230], [600, 313]],
  }),
  // cabang error dari thinking & tool_running
  E('e_think_fail', 'thinking', 'failover', {
    techLabel: 'think_error', exitSide: 'bottom', entrySide: 'top',
    waypoints: [[430, 430], [375, 430]],
  }),
  E('e_tool_fail', 'tool_running', 'failover', {
    techLabel: 'on_error', exitSide: 'left', entrySide: 'right',
  }),
  E('e_fail_retry', 'failover', 'retry', {
    exitSide: 'left', entrySide: 'right', techLabel: 'retry',
  }),
  E('e_retry_think', 'retry', 'thinking', {
    techLabel: 'provider_switch', exitSide: 'top', entrySide: 'left', waypoints: [[170, 313]],
  }),
  E('e_fail_end', 'failover', 'err_end', {
    techLabel: 'exhausted', exitSide: 'bottom', entrySide: 'top',
    waypoints: [[375, 610], [160, 610]],
  }),
  E('e_compose_stream', 'compose', 'stream', {
    exitSide: 'right', entrySide: 'left', techLabel: 'compose_done',
  }),
  E('e_stream_done', 'stream', 'done', {
    exitSide: 'right', entrySide: 'left', techLabel: 'done',
  }),
];

export const AGENT_GRAPH: FlowGraph = { lanes: LANES, nodes: NODES, edges: EDGES };

const NODE_BY_ID = new Map<string, FlowNode>(NODES.map(n => [n.id, n]));

export function getNode(id: string): FlowNode {
  const node = NODE_BY_ID.get(id);
  if (!node) throw new Error(`flowGraph: unknown node "${id}"`);
  return node;
}

export function center(n: FlowNode): [number, number] {
  return [n.x + n.w / 2, n.y + n.h / 2];
}

export function anchor(n: FlowNode, side: Side): [number, number] {
  const [cx, cy] = center(n);
  if (side === 'left') return [n.x, cy];
  if (side === 'right') return [n.x + n.w, cy];
  if (side === 'top') return [cx, n.y];
  return [cx, n.y + n.h];
}

function isVertical(side: Side): boolean {
  return side === 'top' || side === 'bottom';
}

function pickSides(from: FlowNode, to: FlowNode): [Side, Side] {
  const [ax, ay] = center(from);
  const [bx, by] = center(to);
  const dx = bx - ax;
  const dy = by - ay;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
  }
  return dx > 0 ? ['right', 'left'] : ['left', 'right'];
}

function elbow(fromPt: [number, number], exit: Side, toPt: [number, number], entry: Side): [number, number][] {
  const [ax, ay] = fromPt;
  const [bx, by] = toPt;
  if (isVertical(exit) && isVertical(entry)) {
    const my = (ay + by) / 2;
    return [[ax, my], [bx, my]];
  }
  if (!isVertical(exit) && !isVertical(entry)) {
    const mx = (ax + bx) / 2;
    return [[mx, ay], [mx, by]];
  }
  if (isVertical(exit) && !isVertical(entry)) return [[ax, by]];
  return [[bx, ay]];
}

function joinSide(from: [number, number], to: [number, number]): Side {
  return Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1])
    ? (to[0] >= from[0] ? 'right' : 'left')
    : (to[1] >= from[1] ? 'bottom' : 'top');
}

/**
 * Path SVG orthogonal ("M x y L x y ...") dari node asal ke tujuan.
 * Sisi keluar/masuk otomatis atau via override; waypoints untuk koridor manual.
 */
export function computeOrthogonalPath(
  from: FlowNode,
  to: FlowNode,
  waypoints?: [number, number][],
  exitOverride?: Side,
  entryOverride?: Side,
): string {
  const [autoExit, autoEntry] = pickSides(from, to);
  const exit = exitOverride ?? autoExit;
  const entry = entryOverride ?? autoEntry;
  const a = anchor(from, exit);
  const b = anchor(to, entry);
  const pts: [number, number][] = [a];

  if (waypoints && waypoints.length > 0) {
    const first = waypoints[0];
    pts.push(...elbow(a, exit, first, joinSide(a, first)));
    pts.push(...waypoints);
    const last = waypoints[waypoints.length - 1];
    pts.push(...elbow(last, joinSide(last, b), b, entry));
  } else {
    pts.push(...elbow(a, exit, b, entry));
  }
  pts.push(b);

  const dedup: [number, number][] = [];
  for (const p of pts) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
    const pp = dedup[dedup.length - 2];
    if (prev && pp) {
      const collinear = (prev[0] === pp[0] && prev[0] === p[0]) || (prev[1] === pp[1] && prev[1] === p[1]);
      if (collinear) { dedup[dedup.length - 1] = p; continue; }
    }
    dedup.push(p);
  }
  return dedup.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ');
}

export function edgePath(edge: FlowEdge): string {
  return computeOrthogonalPath(getNode(edge.from), getNode(edge.to), edge.waypoints, edge.exitSide, edge.entrySide);
}

/** Titik label edge: override eksplisit, atau tengah segmen terpanjang. */
export function edgeLabelPoint(edge: FlowEdge, d: string): [number, number] {
  if (edge.labelPos) return edge.labelPos;
  const nums = d.replace(/[ML]/g, ' ').trim().split(/\s+/).map(Number);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  if (pts.length < 2) return [0, 0];
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (len > bestLen) { bestLen = len; best = i; }
  }
  const [x1, y1] = pts[best];
  const [x2, y2] = pts[best + 1];
  return [(x1 + x2) / 2, (y1 + y2) / 2];
}

/** Perkiraan lebar teks (px) utk pemenggalan ellipsis — sans-serif ±0.55em per char. */
export function approxTextWidth(s: string, fontSizePx: number): number {
  return s.length * fontSizePx * 0.55;
}

/** Potong teks ke maxChars + ellipsis bila overflow. */
export function fitText(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : `${s.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** Bagi deskripsi ke maksimal 2 baris + ellipsis. */
export function wrapDesc(s: string, maxCharsPerLine: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxCharsPerLine) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w;
    if (lines.length === 2) { lines[1] = `${lines[1].slice(0, Math.max(1, maxCharsPerLine - 1))}…`; return lines; }
  }
  if (cur && lines.length < 2) lines.push(cur);
  else if (cur && lines.length === 2) lines[1] = `${lines[1].slice(0, Math.max(1, maxCharsPerLine - 1))}…`;
  return lines;
}
