/**
 * deriveStatus — murni fungsi pemetaan flow state → status node/edge.
 * Satu-satunya sumber kebenaran = flow (stage, steps, activeTool, error, switches).
 * by Wisnu Alfian Nur Ashar
 */

import type {
  EdgeStatusMap, FlowGraph, FlowState, NodeStatusMap,
} from './types';

const TRUNK = ['user_input', 'parse', 'ctx', 'thinking'];
const TOOL_CHAIN = ['tool_running', 'tool_result'];
const ANSWER_CHAIN = ['compose', 'stream', 'done'];

const MAIN_PATH_EDGES = ['e_input_parse', 'e_parse_ctx', 'e_ctx_think', 'e_think_tool'];
const TOOL_PATH_EDGES = ['e_tool_yes', 'e_run_result', 'e_result_think'];
const ANSWER_PATH_EDGES = ['e_tool_no', 'e_compose_stream', 'e_stream_done'];
const ERROR_CHAIN_EDGES = ['e_fail_retry'];
const ERROR_STOP_EDGES = ['e_fail_end'];

const TRAVEL_MS = 900;

interface Derived {
  nodes: NodeStatusMap;
  edges: EdgeStatusMap;
  activeEdge: string | null;
  /** waktu (ms) sejak active edge mulai menyala, untuk delay pengaktifan node tujuan */
  activeEdgeSince: number;
  toolIteration: number;
}

export function toolIterationOf(flow: FlowState | null): number {
  return flow && flow.steps ? flow.steps.length : 0;
}

/** Urutan node yang sudah benar-benar dilalui jalur utama. */
function visitedNodes(flow: FlowState, iteration: number, hasAnswer: boolean): Set<string> {
  const v = new Set<string>();
  if (flow.stage === 'idle') return v;

  TRUNK.forEach(id => v.add(id));
  if (flow.stage === 'user_input') v.delete('thinking');

  if (iteration > 0) { TOOL_CHAIN.forEach(id => v.add(id)); v.add('needs_tool'); }
  if (hasAnswer) { ANSWER_CHAIN.forEach(id => v.add(id)); v.add('needs_tool'); }
  return v;
}

export function deriveNodeStatuses(flow: FlowState | null, graph: FlowGraph): NodeStatusMap {
  const map: NodeStatusMap = {};
  graph.nodes.forEach(n => { map[n.id] = 'pending'; });
  if (!flow || flow.stage === 'idle') return map;

  const iteration = toolIterationOf(flow);
  const hasAnswer = flow.stage === 'done' || flow.stage === 'error' || Boolean(flow.finishedAt);
  const visited = visitedNodes(flow, iteration, hasAnswer);

  Object.keys(map).forEach(id => { if (visited.has(id)) map[id] = 'done'; });

  const errored = flow.stage === 'error';
  const errAt = flow.errorAt || (flow.steps && flow.steps.length ? 'tool_running' : 'thinking');

  let active: string | null = null;
  if (flow.stage === 'user_input') active = 'user_input';
  else if (flow.stage === 'thinking') active = iteration > 0 ? 'thinking' : 'thinking';
  else if (flow.stage === 'tool_running') active = 'tool_running';
  else if (flow.stage === 'done') active = 'done';
  else if (errored) active = errAt;

  if (errored) {
    map[errAt] = 'error';
    map.failover = 'error';
    map.retry = 'error';
    map.err_end = 'error';
    map.compose = 'pending';
    map.stream = 'pending';
    map.done = 'pending';
    if (active && active !== errAt && map[active] === 'pending') map[active] = 'pending';
  } else if (active) {
    map[active] = 'active';
  }

  if (flow.stage === 'stopped') {
    Object.keys(map).forEach(id => { if (map[id] === 'active') map[id] = 'pending'; });
  }

  if (flow.stage === 'done') {
    map.done = 'done';
    ANSWER_CHAIN.forEach(id => { map[id] = 'done'; });
  }
  return map;
}

/**
 * Status edge. Edge aktif = satu-satunya "garis hidup" yang sedang dialiri.
 * Selesaikan perjalanan dot (TRAVEL_MS) sebelum node tujuan dianggap aktif —
 * dipanggil dengan `now` untuk mendapat status sementara 'pending' selama dot berjalan.
 */
export function deriveEdgeStatuses(
  flow: FlowState | null,
  graph: FlowGraph,
  now: number = Date.now(),
): EdgeStatusMap {
  const { edges } = deriveAll(flow, graph, now);
  return edges;
}

export function deriveAll(flow: FlowState | null, graph: FlowGraph, now = Date.now()): Derived {
  const nodes = deriveNodeStatuses(flow, graph);
  const map: EdgeStatusMap = {};
  graph.edges.forEach(e => { map[e.id] = 'idle'; });
  let activeEdge: string | null = null;
  let activeEdgeSince = 0;

  if (!flow || flow.stage === 'idle') {
    return { nodes, edges: map, activeEdge, activeEdgeSince, toolIteration: 0 };
  }

  const iteration = toolIterationOf(flow);
  const isDone = flow.stage === 'done';
  const isErrored = flow.stage === 'error';

  const markDone = (ids: string[]) => ids.forEach(id => { if (map[id] === 'idle' || map[id] === 'active') map[id] = 'done'; });
  const markActive = (id: string, since: number) => {
    map[id] = 'active';
    activeEdge = id;
    activeEdgeSince = since;
  };

  const t0 = flow.startedAt || now;

  if (flow.stage === 'user_input') {
    const started = t0;
    if (now - started > TRAVEL_MS) markDone(['e_input_parse']);
    else markActive('e_input_parse', started);
  } else {
    markDone(['e_input_parse']);
  }

  if (flow.stage === 'thinking') {
    if (iteration === 0) {
      const started = t0 + TRAVEL_MS;
      const elapsed = now - started;
      if (elapsed > TRAVEL_MS * 2) markDone(['e_parse_ctx', 'e_ctx_think', 'e_think_tool']);
      else if (elapsed > TRAVEL_MS) { markDone(['e_parse_ctx']); markActive('e_ctx_think', t0 + TRAVEL_MS * 2); }
      else markActive('e_parse_ctx', started);
    } else {
      markDone(['e_parse_ctx', 'e_ctx_think', 'e_tool_yes', 'e_run_result']);
      markActive('e_result_think', now - TRAVEL_MS);
    }
  }

  if (flow.stage === 'tool_running') {
    markDone(['e_parse_ctx', 'e_ctx_think', 'e_think_tool']);
    if (iteration <= 1) {
      markActive('e_tool_yes', now - TRAVEL_MS);
    } else {
      markDone(MAIN_PATH_EDGES);
      TOOL_PATH_EDGES.slice(0, 2).forEach(id => { map[id] = 'active'; });
      activeEdge = 'e_tool_yes';
      activeEdgeSince = now - TRAVEL_MS;
    }
  }

  if (isDone) {
    markDone(MAIN_PATH_EDGES);
    if (iteration > 0) markDone(TOOL_PATH_EDGES);
    markDone(ANSWER_PATH_EDGES);
    map.e_result_think = 'done';
  }

  if (isErrored) {
    markDone(MAIN_PATH_EDGES);
    if (iteration > 0) {
      markDone(['e_tool_yes', 'e_run_result']);
      map.e_think_fail = 'idle';
    }
    const errAt = flow.errorAt || (iteration > 0 ? 'tool_running' : 'thinking');
    const started = flow.finishedAt || now;
    map[errAt === 'thinking' ? 'e_think_fail' : 'e_tool_fail'] = 'error';
    ERROR_CHAIN_EDGES.forEach(id => { map[id] = 'error'; });
    ERROR_STOP_EDGES.forEach(id => { map[id] = 'error'; });
    activeEdge = errAt === 'thinking' ? 'e_think_fail' : 'e_tool_fail';
    activeEdgeSince = started;
    ANSWER_PATH_EDGES.forEach(id => { map[id] = 'idle'; });
  }

  if (flow.stage === 'stopped') {
    graph.edges.forEach(id => { if (map[id.id] === 'active') map[id.id] = 'idle'; });
    activeEdge = null;
  }

  Object.keys(nodes).forEach(id => {
    const st = nodes[id];
    if (st !== 'active') return;
    const since = activeEdge ? activeEdgeSince : 0;
    if (since && now - since < TRAVEL_MS) nodes[id] = 'pending';
  });

  return { nodes, edges: map, activeEdge, activeEdgeSince, toolIteration: iteration };
}
