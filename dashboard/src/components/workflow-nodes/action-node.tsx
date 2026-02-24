'use client';

/**
 * Action Node - Deterministic Tool Execution Block
 * 
 * Per The Nexus Protocol Phase 4, this handles:
 * - Non-LLM direct tool calls (e.g., API calls, file ops)
 * - Distinct visual styling from Processor (LLM) nodes
 * - Hexagonal or gear-themed appearance
 */

import React from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Cog, Zap, ArrowRight } from 'lucide-react';

interface ActionNodeData {
    label?: string;
    icon?: string;
    description?: string;
    action?: string;
    tool?: string;
    config?: Record<string, unknown>;
}

export function ActionNode({ data, selected }: NodeProps) {
    const nodeData = data as ActionNodeData | undefined;

    const label = String(nodeData?.label || 'Action');
    const icon = nodeData?.icon || '⚙️';
    const action = nodeData?.action || nodeData?.tool;
    const description = nodeData?.description;

    return (
        <div className={`action-node ${selected ? 'selected' : ''}`}>
            <Handle
                type="target"
                position={Position.Top}
                className="handle handle-top"
            />

            {/* Gear accent */}
            <div className="gear-accent">
                <Cog size={14} />
            </div>

            {/* Main content */}
            <div className="action-header">
                <span className="action-icon">{icon}</span>
                <span className="action-title">{label}</span>
            </div>

            {action && (
                <div className="action-badge">
                    <Zap size={10} />
                    <span>{action}</span>
                </div>
            )}

            {description && (
                <div className="action-content">
                    <p>{description}</p>
                </div>
            )}

            <Handle
                type="source"
                position={Position.Bottom}
                className="handle handle-bottom"
            />

            <style jsx>{`
                .action-node {
                    background: linear-gradient(145deg, #1f2937 0%, #111827 100%);
                    border: 2px solid #374151;
                    border-radius: 8px;
                    min-width: 140px;
                    max-width: 180px;
                    box-shadow: 0 4px 16px rgba(251, 191, 36, 0.1);
                    transition: all 0.2s ease;
                    position: relative;
                    overflow: visible;
                }

                .action-node:hover {
                    border-color: #f59e0b;
                    box-shadow: 0 6px 20px rgba(251, 191, 36, 0.2);
                }

                .action-node.selected {
                    border-color: #f59e0b;
                    box-shadow: 0 0 0 3px rgba(251, 191, 36, 0.25);
                }

                .gear-accent {
                    position: absolute;
                    top: -10px;
                    right: -10px;
                    width: 28px;
                    height: 28px;
                    background: linear-gradient(135deg, #f59e0b, #d97706);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    box-shadow: 0 2px 8px rgba(251, 191, 36, 0.4);
                }

                .action-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 10px 12px;
                    border-bottom: 1px solid #374151;
                }

                .action-icon {
                    font-size: 1rem;
                }

                .action-title {
                    font-size: 0.8rem;
                    font-weight: 600;
                    color: #f3f4f6;
                }

                .action-badge {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    padding: 6px 12px;
                    background: rgba(251, 191, 36, 0.1);
                    border-bottom: 1px solid #374151;
                    color: #fbbf24;
                    font-size: 0.65rem;
                    font-weight: 500;
                }

                .action-content {
                    padding: 8px 12px;
                    font-size: 0.7rem;
                    color: #9ca3af;
                }

                :global(.action-node .handle) {
                    width: 10px !important;
                    height: 10px !important;
                    background: #f59e0b !important;
                    border: 2px solid #111827 !important;
                }

                :global(.action-node .handle-top) {
                    top: -5px !important;
                }

                :global(.action-node .handle-bottom) {
                    bottom: -5px !important;
                }
            `}</style>
        </div>
    );
}
