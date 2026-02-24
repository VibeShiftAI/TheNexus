'use client';

/**
 * Super Node - Collapsible Sub-Graph Container
 * 
 * Per The Nexus Protocol Phase 4, this enables:
 * - Grouping multiple nodes into a collapsible cluster
 * - Visual distinction as a "container" node
 * - Expand/collapse functionality
 */

import React from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { FolderOpen, Folder, Layers, ChevronDown, ChevronUp } from 'lucide-react';

interface SuperNodeData {
    label?: string;
    icon?: string;
    description?: string;
    childCount?: number;
    expanded?: boolean;
    color?: string;
    config?: Record<string, unknown>;
}

interface SuperNodeProps extends NodeProps {
    onToggle?: (nodeId: string) => void;
}

export function SuperNode({ id, data, selected }: SuperNodeProps) {
    const nodeData = data as SuperNodeData | undefined;
    const [expanded, setExpanded] = React.useState(nodeData?.expanded ?? false);

    const label = String(nodeData?.label || 'Sub-Graph');
    const icon = nodeData?.icon;
    const childCount = nodeData?.childCount || 0;
    const description = nodeData?.description;
    const color = nodeData?.color || '#8b5cf6';

    const handleToggle = (e: React.MouseEvent) => {
        e.stopPropagation();
        setExpanded(!expanded);
    };

    return (
        <div
            className={`super-node ${selected ? 'selected' : ''} ${expanded ? 'expanded' : 'collapsed'}`}
            style={{ '--accent-color': color } as React.CSSProperties}
        >
            <Handle
                type="target"
                position={Position.Top}
                className="handle handle-top"
            />

            {/* Header */}
            <div className="super-header">
                <div className="header-left">
                    {expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
                    <span className="super-title">{label}</span>
                </div>
                <button className="toggle-btn" onClick={handleToggle}>
                    {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
            </div>

            {/* Child count indicator */}
            <div className="child-indicator">
                <Layers size={12} />
                <span>{childCount} node{childCount !== 1 ? 's' : ''}</span>
            </div>

            {/* Description when expanded */}
            {expanded && description && (
                <div className="super-content">
                    <p>{description}</p>
                </div>
            )}

            {/* Visual indicator that this is a container */}
            <div className="container-pattern" />

            <Handle
                type="source"
                position={Position.Bottom}
                className="handle handle-bottom"
            />

            <style jsx>{`
                .super-node {
                    background: linear-gradient(145deg, #1e1b4b 0%, #0f0f23 100%);
                    border: 2px dashed var(--accent-color, #8b5cf6);
                    border-radius: 16px;
                    min-width: 160px;
                    max-width: 200px;
                    box-shadow: 0 4px 20px rgba(139, 92, 246, 0.15);
                    transition: all 0.3s ease;
                    position: relative;
                    overflow: hidden;
                }

                .super-node.expanded {
                    min-width: 180px;
                    border-style: solid;
                }

                .super-node:hover {
                    border-color: var(--accent-color, #8b5cf6);
                    box-shadow: 0 6px 24px rgba(139, 92, 246, 0.25);
                }

                .super-node.selected {
                    box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.3);
                }

                .super-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 10px 12px;
                    background: linear-gradient(135deg, rgba(139, 92, 246, 0.2) 0%, transparent 50%);
                    border-bottom: 1px solid rgba(139, 92, 246, 0.3);
                    color: var(--accent-color, #8b5cf6);
                }

                .header-left {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .super-title {
                    font-size: 0.8rem;
                    font-weight: 600;
                    color: #e9d5ff;
                }

                .toggle-btn {
                    padding: 4px;
                    background: rgba(139, 92, 246, 0.2);
                    border: none;
                    border-radius: 4px;
                    color: var(--accent-color, #8b5cf6);
                    cursor: pointer;
                    transition: all 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .toggle-btn:hover {
                    background: rgba(139, 92, 246, 0.4);
                }

                .child-indicator {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 8px 12px;
                    color: #a78bfa;
                    font-size: 0.7rem;
                }

                .super-content {
                    padding: 8px 12px;
                    font-size: 0.7rem;
                    color: #9ca3af;
                    border-top: 1px solid rgba(139, 92, 246, 0.2);
                }

                .container-pattern {
                    position: absolute;
                    bottom: 0;
                    left: 0;
                    right: 0;
                    height: 4px;
                    background: repeating-linear-gradient(
                        90deg,
                        var(--accent-color, #8b5cf6) 0px,
                        var(--accent-color, #8b5cf6) 4px,
                        transparent 4px,
                        transparent 8px
                    );
                    opacity: 0.5;
                }

                :global(.super-node .handle) {
                    width: 14px !important;
                    height: 14px !important;
                    background: #8b5cf6 !important;
                    border: 2px solid #0f0f23 !important;
                }

                :global(.super-node .handle-top) {
                    top: -7px !important;
                }

                :global(.super-node .handle-bottom) {
                    bottom: -7px !important;
                }
            `}</style>
        </div>
    );
}
