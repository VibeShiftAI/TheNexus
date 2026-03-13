'use client';

/**
 * Base Node Component
 * Shared foundation for all workflow nodes
 * 
 * Shows: icon, title, category badge, I/O ports summary, model badge, node type indicator
 */

import React from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';

interface BaseNodeData {
    label: string;
    config?: Record<string, unknown>;
}

interface BaseNodeProps {
    icon: string;
    title: string;
    color: string;
    children?: React.ReactNode;
    selected?: boolean;
    handles?: {
        top?: boolean;
        bottom?: boolean;
        left?: boolean;
        right?: boolean;
    };
    // Enhanced details
    category?: string;
    inputs?: string[];
    outputs?: string[];
    model?: string;
    nodeType?: string; // atomic | fleet | orchestrator | utility
}

const NODE_TYPE_ICONS: Record<string, string> = {
    atomic: '⚛️',
    fleet: '🚀',
    orchestrator: '🎯',
    utility: '🔧',
};

const CATEGORY_COLORS: Record<string, string> = {
    research: '#06b6d4',
    planning: '#f59e0b',
    implementation: '#10b981',
    review: '#ef4444',
    orchestration: '#8b5cf6',
    utility: '#6b7280',
    memory: '#ec4899',
    documentation: '#3b82f6',
    general: '#6366f1',
    agent: '#6366f1',
};

export function BaseNode({
    icon,
    title,
    color,
    children,
    selected,
    handles = { top: true, bottom: true },
    category,
    inputs,
    outputs,
    model,
    nodeType,
}: BaseNodeProps) {
    const catColor = category ? (CATEGORY_COLORS[category] || CATEGORY_COLORS.general) : undefined;
    const typeIcon = nodeType ? (NODE_TYPE_ICONS[nodeType] || '') : '';

    // Format model name for display
    const modelDisplay = model
        ? (model.includes('/')
            ? model.split('/').pop()
            : model.length > 22
                ? model.substring(0, 19) + '...'
                : model)
        : null;

    const inputCount = inputs?.length ?? 1;
    const outputCount = outputs?.length ?? 1;

    return (
        <div className={`workflow-node ${selected ? 'selected' : ''}`}>
            {handles.top && (
                <Handle
                    type="target"
                    position={Position.Top}
                    className="handle handle-top"
                />
            )}

            <div className="node-header" style={{ borderColor: color }}>
                <div className="header-main">
                    <span className="node-icon">{icon}</span>
                    <span className="node-title">{title}</span>
                </div>
                {typeIcon && (
                    <span className="type-indicator" title={`${nodeType} node`}>{typeIcon}</span>
                )}
            </div>

            {/* Details row: category + I/O + model */}
            {(category || model || inputs || outputs) && (
                <div className="node-details">
                    {category && (
                        <span
                            className="category-badge"
                            style={{ background: `${catColor}22`, color: catColor, borderColor: `${catColor}44` }}
                        >
                            {category}
                        </span>
                    )}
                    <div className="io-summary" title={`Inputs: ${inputs?.join(', ') || 'main'}\nOutputs: ${outputs?.join(', ') || 'main'}`}>
                        <span className="io-in">{inputCount} in</span>
                        <span className="io-arrow">→</span>
                        <span className="io-out">{outputCount} out</span>
                    </div>
                </div>
            )}

            {modelDisplay && (
                <div className="model-row">
                    <span className="model-icon">🧠</span>
                    <span className="model-name">{modelDisplay}</span>
                </div>
            )}

            {children && <div className="node-content">{children}</div>}

            {handles.bottom && (
                <Handle
                    type="source"
                    position={Position.Bottom}
                    className="handle handle-bottom"
                />
            )}

            <style jsx>{`
        .workflow-node {
          background: #1e1e2e;
          border: 2px solid #333;
          border-radius: 12px;
          min-width: 180px;
          max-width: 240px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
          transition: all 0.2s;
        }

        .workflow-node:hover {
          border-color: #555;
        }

        .workflow-node.selected {
          border-color: ${color};
          box-shadow: 0 0 0 2px ${color}40;
        }

        .node-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 14px;
          border-bottom: 2px solid;
          border-radius: 10px 10px 0 0;
          background: linear-gradient(135deg, ${color}20, transparent);
        }

        .header-main {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }

        .node-icon {
          font-size: 1.25rem;
          flex-shrink: 0;
        }

        .node-title {
          font-size: 0.875rem;
          font-weight: 600;
          color: #fff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .type-indicator {
          font-size: 0.7rem;
          opacity: 0.6;
          flex-shrink: 0;
        }

        .node-details {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 14px;
          border-bottom: 1px solid #2a2a3e;
        }

        .category-badge {
          font-size: 0.6rem;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          white-space: nowrap;
        }

        .io-summary {
          display: flex;
          align-items: center;
          gap: 3px;
          font-size: 0.6rem;
          color: #666;
          margin-left: auto;
          cursor: default;
        }

        .io-in {
          color: #6366f1;
          font-weight: 500;
        }

        .io-arrow {
          color: #444;
        }

        .io-out {
          color: #10b981;
          font-weight: 500;
        }

        .model-row {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 14px 4px;
          border-bottom: 1px solid #2a2a3e;
        }

        .model-icon {
          font-size: 0.65rem;
        }

        .model-name {
          font-size: 0.6rem;
          color: #a5b4fc;
          font-weight: 500;
          font-family: 'JetBrains Mono', 'Fira Code', monospace;
        }

        .node-content {
          padding: 10px 14px;
          font-size: 0.75rem;
          color: #888;
        }

        :global(.handle) {
          width: 12px !important;
          height: 12px !important;
          background: #6366f1 !important;
          border: 2px solid #1e1e2e !important;
        }

        :global(.handle-top) {
          top: -6px !important;
        }

        :global(.handle-bottom) {
          bottom: -6px !important;
        }
      `}</style>
        </div>
    );
}
