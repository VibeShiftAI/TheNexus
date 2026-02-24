'use client';

/**
 * Processor Card - Enhanced Agent Node with Model & Tools Display
 * 
 * Per The Nexus Protocol Phase 4, this shows:
 * - LLM model badge (e.g., "GPT-4", "Claude-3")
 * - Enabled tool icons from MCP servers
 * - Visual distinction from Action (deterministic) nodes
 */

import React from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Bot, Cpu, Wrench, ChevronDown, ChevronUp } from 'lucide-react';

interface ProcessorCardData {
    label?: string;
    icon?: string;
    description?: string;
    model?: string;
    tools?: Array<{ name: string; icon?: string }>;
    config?: Record<string, unknown>;
}

export function ProcessorCard({ data, selected }: NodeProps) {
    const nodeData = data as ProcessorCardData | undefined;
    const [expanded, setExpanded] = React.useState(false);

    const label = String(nodeData?.label || 'Processor');
    const icon = nodeData?.icon || '🤖';
    const model = nodeData?.model || 'gemini-3-flash-preview';
    const tools = nodeData?.tools || [];
    const description = nodeData?.description;

    // Extract model name for display
    const modelDisplay = model.includes('/')
        ? model.split('/').pop()
        : model.length > 20
            ? model.substring(0, 17) + '...'
            : model;

    return (
        <div className={`processor-card ${selected ? 'selected' : ''}`}>
            <Handle
                type="target"
                position={Position.Top}
                className="handle handle-top"
            />

            {/* Header with gradient */}
            <div className="card-header">
                <div className="header-left">
                    <span className="card-icon">{icon}</span>
                    <span className="card-title">{label}</span>
                </div>
                <div className="header-right">
                    <Cpu size={12} />
                    <span className="model-badge">{modelDisplay}</span>
                </div>
            </div>

            {/* Tools row */}
            {tools.length > 0 && (
                <div className="tools-row">
                    <Wrench size={10} className="tools-icon" />
                    <div className="tools-list">
                        {tools.slice(0, 4).map((tool, i) => (
                            <span key={i} className="tool-chip" title={tool.name}>
                                {tool.icon || '🔧'} {tool.name.length > 10 ? tool.name.substring(0, 8) + '...' : tool.name}
                            </span>
                        ))}
                        {tools.length > 4 && (
                            <span className="tool-more">+{tools.length - 4}</span>
                        )}
                    </div>
                </div>
            )}

            {/* Expandable description */}
            {description && (
                <button
                    className="expand-btn"
                    onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                >
                    {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
            )}

            {expanded && description && (
                <div className="card-content">
                    <p>{description}</p>
                </div>
            )}

            <Handle
                type="source"
                position={Position.Bottom}
                className="handle handle-bottom"
            />

            <style jsx>{`
                .processor-card {
                    background: linear-gradient(145deg, #1a1a2e 0%, #16162a 100%);
                    border: 2px solid #3d3d5c;
                    border-radius: 12px;
                    min-width: 180px;
                    max-width: 220px;
                    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.15);
                    transition: all 0.2s ease;
                    overflow: hidden;
                }

                .processor-card:hover {
                    border-color: #6366f1;
                    box-shadow: 0 6px 24px rgba(99, 102, 241, 0.25);
                }

                .processor-card.selected {
                    border-color: #6366f1;
                    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.3);
                }

                .card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 10px 12px;
                    background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, transparent 50%);
                    border-bottom: 1px solid #3d3d5c;
                }

                .header-left {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .card-icon {
                    font-size: 1.1rem;
                }

                .card-title {
                    font-size: 0.8rem;
                    font-weight: 600;
                    color: #fff;
                }

                .header-right {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    color: #a5b4fc;
                }

                .model-badge {
                    font-size: 0.65rem;
                    font-weight: 500;
                    padding: 2px 6px;
                    background: rgba(99, 102, 241, 0.2);
                    border-radius: 4px;
                    color: #a5b4fc;
                }

                .tools-row {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 8px 12px;
                    background: rgba(0, 0, 0, 0.2);
                }

                .tools-icon {
                    color: #666;
                    flex-shrink: 0;
                }

                .tools-list {
                    display: flex;
                    gap: 4px;
                    flex-wrap: wrap;
                }

                .tool-chip {
                    font-size: 0.6rem;
                    padding: 2px 5px;
                    background: #2a2a40;
                    border: 1px solid #3d3d5c;
                    border-radius: 4px;
                    color: #888;
                }

                .tool-more {
                    font-size: 0.6rem;
                    color: #666;
                    padding: 2px 4px;
                }

                .expand-btn {
                    width: 100%;
                    padding: 4px;
                    background: none;
                    border: none;
                    color: #666;
                    cursor: pointer;
                    transition: color 0.2s;
                }

                .expand-btn:hover {
                    color: #6366f1;
                }

                .card-content {
                    padding: 8px 12px;
                    font-size: 0.7rem;
                    color: #888;
                    border-top: 1px solid #2a2a40;
                }

                :global(.handle) {
                    width: 12px !important;
                    height: 12px !important;
                    background: #6366f1 !important;
                    border: 2px solid #1a1a2e !important;
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
