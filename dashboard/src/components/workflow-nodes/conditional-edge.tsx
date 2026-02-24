'use client';

/**
 * Conditional Edge - Traffic Light Visual Styling
 * 
 * Per The Nexus Protocol Phase 4, this provides:
 * - Green solid edges for success/unconditional paths
 * - Red dashed edges for failure/retry paths
 * - Animated flow visualization
 * - Condition labels on edges
 */

import React from 'react';
import {
    BaseEdge,
    EdgeLabelRenderer,
    EdgeProps,
    getSmoothStepPath,
    getBezierPath,
} from '@xyflow/react';

interface ConditionalEdgeData {
    condition?: 'success' | 'failure' | 'retry' | 'default' | string;
    label?: string;
    animated?: boolean;
}

const EDGE_STYLES = {
    success: {
        stroke: '#22c55e',
        strokeDasharray: 'none',
        strokeWidth: 2,
        glow: 'rgba(34, 197, 94, 0.3)',
    },
    failure: {
        stroke: '#ef4444',
        strokeDasharray: '6 4',
        strokeWidth: 2,
        glow: 'rgba(239, 68, 68, 0.3)',
    },
    retry: {
        stroke: '#f59e0b',
        strokeDasharray: '4 4',
        strokeWidth: 2,
        glow: 'rgba(245, 158, 11, 0.3)',
    },
    default: {
        stroke: '#6366f1',
        strokeDasharray: 'none',
        strokeWidth: 2,
        glow: 'rgba(99, 102, 241, 0.2)',
    },
};

export function ConditionalEdge({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    selected,
    style = {},
}: EdgeProps) {
    const edgeData = data as ConditionalEdgeData | undefined;
    const condition = edgeData?.condition || 'default';
    const label = edgeData?.label;
    const animated = edgeData?.animated ?? (condition !== 'default');

    const edgeStyle = EDGE_STYLES[condition as keyof typeof EDGE_STYLES] || EDGE_STYLES.default;

    const [edgePath, labelX, labelY] = getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        borderRadius: 10,
    });

    return (
        <>
            {/* Glow effect for selected or animated edges */}
            {(selected || animated) && (
                <path
                    d={edgePath}
                    fill="none"
                    stroke={edgeStyle.glow}
                    strokeWidth={8}
                    className="edge-glow"
                />
            )}

            {/* Main edge path */}
            <BaseEdge
                id={id}
                path={edgePath}
                style={{
                    stroke: edgeStyle.stroke,
                    strokeWidth: edgeStyle.strokeWidth,
                    strokeDasharray: edgeStyle.strokeDasharray,
                    ...style,
                }}
                className={animated ? 'animated-edge' : ''}
            />

            {/* Condition label */}
            {label && (
                <EdgeLabelRenderer>
                    <div
                        style={{
                            position: 'absolute',
                            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                            pointerEvents: 'all',
                        }}
                        className="edge-label"
                    >
                        <span
                            style={{
                                background: edgeStyle.stroke,
                                color: '#fff',
                                padding: '2px 8px',
                                borderRadius: '10px',
                                fontSize: '0.6rem',
                                fontWeight: 600,
                                boxShadow: `0 2px 8px ${edgeStyle.glow}`,
                            }}
                        >
                            {label}
                        </span>
                    </div>
                </EdgeLabelRenderer>
            )}

            <style jsx global>{`
                .animated-edge {
                    animation: dash 1.5s linear infinite;
                }

                @keyframes dash {
                    to {
                        stroke-dashoffset: -20;
                    }
                }

                .edge-glow {
                    filter: blur(4px);
                    opacity: 0.5;
                }

                .edge-label {
                    z-index: 10;
                }
            `}</style>
        </>
    );
}

/**
 * Success Edge - Green solid line
 */
export function SuccessEdge(props: EdgeProps) {
    return <ConditionalEdge {...props} data={{ ...props.data, condition: 'success' }} />;
}

/**
 * Failure Edge - Red dashed line
 */
export function FailureEdge(props: EdgeProps) {
    return <ConditionalEdge {...props} data={{ ...props.data, condition: 'failure' }} />;
}

/**
 * Retry Edge - Orange dashed line
 */
export function RetryEdge(props: EdgeProps) {
    return <ConditionalEdge {...props} data={{ ...props.data, condition: 'retry' }} />;
}
