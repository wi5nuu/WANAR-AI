/**
 * FlowEdgePath — "garis hidup" lengkap:
 *  base + glow + marching-ants + gradient bergerak + comet berekor + fill-sweep done.
 * by Wisnu Alfian Nur Ashar
 */

import { memo } from 'react';
import type { EdgeStatus, FlowEdge, ViewMode } from './types';
import { TRAVEL_MS } from './flowGraph';

interface Props {
  edge: FlowEdge;
  d: string;
  status: EdgeStatus;
  mode: ViewMode;
  labelPoint: [number, number];
  reducedMotion: boolean;
  flowSpeed: number;
  traced?: boolean;
  untraced?: boolean;
}

function FlowEdgePathImpl({
  edge, d, status, mode, labelPoint, reducedMotion, flowSpeed, traced, untraced,
}: Props) {
  const showLabel = mode === 'simple'
    ? edge.label
    : (edge.label ? `${edge.label} / ${edge.techLabel ?? ''}`.trim() : edge.techLabel);

  const travelDur = Math.max(200, TRAVEL_MS / (flowSpeed || 1));

  return (
    <g
      className={`af-edge af-es-${status}${traced ? ' af-traced' : ''}${untraced ? ' af-untraced' : ''}`}
      role="presentation"
    >
      {/* area hover yang lebih luas */}
      <path className="af-edge-hit" d={d} />
      <path className="af-edge-base" d={d} markerEnd="url(#af-arrow)" />
      {(status === 'active' || status === 'done' || status === 'error') && (
        <path className="af-edge-glow" d={d} />
      )}
      {status === 'active' && !reducedMotion && (
        <>
          <path className="af-edge-dash" d={d} />
          <path className="af-edge-grad" d={d} />
        </>
      )}
      {status === 'active' && !reducedMotion && (
        <g className="af-comet-group">
          <g>
            <animateMotion dur={`${travelDur}ms`} repeatCount="indefinite" rotate="auto" path={d} />
            <circle className="af-comet af-comet-head" r={4} cx={0} cy={0} />
            <circle className="af-comet af-comet-t1" r={3} cx={-6} cy={0} />
            <circle className="af-comet af-comet-t2" r={2} cx={-12} cy={0} />
          </g>
        </g>
      )}
      {status === 'done' && !reducedMotion && (
        <path key="sweep" className="af-edge-sweep" d={d} pathLength={100} />
      )}
      {showLabel && (
        <text className="af-edge-label" x={labelPoint[0] + 4} y={labelPoint[1] - 4}>
          {showLabel}
        </text>
      )}
    </g>
  );
}

export const FlowEdgePath = memo(FlowEdgePathImpl);
