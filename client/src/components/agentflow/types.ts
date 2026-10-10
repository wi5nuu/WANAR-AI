/**
 * AgentFlow type contracts
 * by Wisnu Alfian Nur Ashar
 */

export type NodeKind = 'terminator' | 'process' | 'decision' | 'document'
  | 'subprocess' | 'delay' | 'merge';

export type NodeStatus = 'pending' | 'active' | 'done' | 'error';
export type EdgeStatus = 'idle' | 'active' | 'done' | 'error';
export type LaneTone = 'dark' | 'light';
export type Side = 'top' | 'bottom' | 'left' | 'right';
export type ViewMode = 'simple' | 'tech';

export interface NodeText {
  title: string;
  desc: string;
}

export interface FlowNode {
  id: string;
  kind: NodeKind;
  lane: string;
  x: number;
  y: number;
  w: number;
  h: number;
  simple: NodeText;
  tech: NodeText;
  icon?: string;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  techLabel?: string;
  waypoints?: [number, number][];
  trigger?: string;
  exitSide?: Side;
  entrySide?: Side;
  labelPos?: [number, number];
}

export interface FlowLane {
  id: string;
  title: string;
  tone: LaneTone;
  y: number;
  h: number;
}

export interface FlowGraph {
  lanes: FlowLane[];
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface FlowStep {
  name: string;
  args?: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
}

export interface FlowSwitch {
  from: string | null;
  to: string;
  model: string | null;
  reason: string;
  at: number;
}

export interface FlowState {
  stage: string;
  steps: FlowStep[];
  activeTool: { name: string; args?: Record<string, unknown>; startedAt?: number } | null;
  activeProvider: string | null;
  activeModel: string | null;
  switches: FlowSwitch[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  errorAt?: string | null;
  /** edgeId yang benar-benar dilalui run terakhir (diisi komponen, bukan backend) */
  trace?: string[];
}

export type NodeStatusMap = Record<string, NodeStatus>;
export type EdgeStatusMap = Record<string, EdgeStatus>;
