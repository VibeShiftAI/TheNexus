'use client';

/**
 * Base Node Component
 * Shared foundation for all workflow nodes
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
}

export function BaseNode({
    icon,
    title,
    color,
    children,
    selected,
    handles = { top: true, bottom: true },
}: BaseNodeProps) {
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
                <span className="node-icon">{icon}</span>
                <span className="node-title">{title}</span>
            </div>

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
          min-width: 160px;
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
          gap: 8px;
          padding: 10px 14px;
          border-bottom: 2px solid;
          border-radius: 10px 10px 0 0;
          background: linear-gradient(135deg, ${color}20, transparent);
        }

        .node-icon {
          font-size: 1.25rem;
        }

        .node-title {
          font-size: 0.875rem;
          font-weight: 600;
          color: #fff;
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
