/**
 * FlowNodeShape — bentuk SVG standar flowchart per NodeKind + status.
 * by Wisnu Alfian Nur Ashar
 */

import { memo } from 'react';
import type { FlowNode, NodeStatus, ViewMode } from './types';
import { fitText, wrapDesc } from './flowGraph';

interface Props {
  node: FlowNode;
  status: NodeStatus;
  mode: ViewMode;
  label?: { title: string; desc: string } | null;
  badge?: string | null;
  nodeRef?: React.RefObject<SVGGElement>;
  onNodeEnter?: (node: FlowNode) => void;
  onNodeLeave?: () => void;
  onNodeClick?: (node: FlowNode) => void;
  dimmed?: boolean;
}

const R = 2;

function terminatorPath(x: number, y: number, w: number, h: number): string {
  const r = h / 2;
  return `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}

function rectPath(x: number, y: number, w: number, h: number): string {
  return `M${x + R} ${y} H${x + w - R} V${y + h - R} H${x + R} V${y + R} Z`;
}

function diamondPath(x: number, y: number, w: number, h: number): string {
  return `M${x + w / 2} ${y} L${x + w} ${y + h / 2} L${x + w / 2} ${y + h} L${x} ${y + h / 2} Z`;
}

/** dasar bergelombang dengan kurva quadratic (Q), sesuai referensi */
function documentPath(x: number, y: number, w: number, h: number): string {
  const wave = Math.min(12, h / 5);
  const base = y + h - wave;
  return (
    `M${x + R} ${y} H${x + w - R} Q${x + w} ${y} ${x + w} ${y + R} ` +
    `V${base} ` +
    `Q${x + w * 0.75} ${base + wave * 1.9} ${x + w * 0.5} ${base} ` +
    `Q${x + w * 0.25} ${base - wave * 0.9} ${x} ${base} ` +
    `V${y + R} Q${x} ${y} ${x + R} ${y} Z`
  );
}

function delayPath(x: number, y: number, w: number, h: number): string {
  const r = h / 2;
  return `M${x + R} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + R} Z`;
}

function shapePath(node: FlowNode): string {
  const { x, y, w, h, kind } = node;
  if (kind === 'terminator') return terminatorPath(x, y, w, h);
  if (kind === 'decision' || kind === 'merge') return diamondPath(x, y, w, h);
  if (kind === 'document') return documentPath(x, y, w, h);
  if (kind === 'delay') return delayPath(x, y, w, h);
  return rectPath(x, y, w, h);
}

/** lebar teks efektif per bentuk (diamond paling sempit) */
function usableWidth(node: FlowNode): number {
  if (node.kind === 'decision' || node.kind === 'merge') return node.w * 0.55;
  return node.w - 20;
}

function FlowNodeShapeImpl({
  node, status, mode, label, badge, nodeRef, onNodeEnter, onNodeLeave, onNodeClick, dimmed,
}: Props) {
  const { x, y, w, h, kind } = node;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const info = label ?? (mode === 'simple' ? node.simple : node.tech);
  const isMerge = kind === 'merge';

  const titleSize = isMerge ? 10 : 12;
  const descSize = isMerge ? 9 : 11;
  const avail = usableWidth(node);
  const title = fitText(info.title, Math.floor(avail / (titleSize * 0.6)));
  const desc = wrapDesc(fitText(info.desc, Math.floor((avail * 1.9) / (descSize * 0.55))), Math.floor(avail / (descSize * 0.55)));
  const showDesc = !isMerge && desc.length > 0;

  const titleY = showDesc ? cy - (desc.length > 1 ? 9 : 5) : cy + 4;

  return (
    <g
      ref={nodeRef}
      className={`af-node af-st-${status}${dimmed ? ' af-node-dim' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${info.title}. ${info.desc}. Status: ${status}`}
      onMouseEnter={() => onNodeEnter?.(node)}
      onMouseLeave={onNodeLeave}
      onFocus={() => onNodeEnter?.(node)}
      onBlur={onNodeLeave}
      onClick={() => onNodeClick?.(node)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNodeClick?.(node); }
      }}
    >
      <path className="af-node-shape" d={shapePath(node)} />
      {kind === 'subprocess' && (
        <>
          <line className="af-node-inner" x1={x + 10} y1={y + 2} x2={x + 10} y2={y + h - 2} />
          <line className="af-node-inner" x1={x + w - 10} y1={y + 2} x2={x + w - 10} y2={y + h - 2} />
        </>
      )}
      {node.icon && !label && (
        <text className="af-node-icon" x={cx - avail / 2 + 6} y={y + 16} textAnchor="start">
          {node.icon}
        </text>
      )}
      <text className="af-node-title" x={cx} y={titleY} textAnchor="middle" fontSize={titleSize}>
        {title}
      </text>
      {showDesc && (
        <text className="af-node-desc" x={cx} y={titleY + 14} textAnchor="middle" fontSize={descSize}>
          {desc.map((line, i) => (
            <tspan key={i} x={cx} dy={i === 0 ? 0 : descSize + 2}>{line}</tspan>
          ))}
        </text>
      )}
      {(status === 'active' || badge) && (
        <g className="af-live-badge" transform={`translate(${x + w - 34} ${y - 8})`} aria-hidden="true">
          <rect className="af-live-badge-bg" x={0} y={0} width={36} height={14} rx={R} />
          <text className="af-live-badge-text" x={18} y={10} textAnchor="middle">{badge || 'LIVE'}</text>
        </g>
      )}
    </g>
  );
}

export const FlowNodeShape = memo(FlowNodeShapeImpl);
