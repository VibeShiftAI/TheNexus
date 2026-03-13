'use client';

/**
 * Agent Node Component
 * Generic node that renders any agent type from the registry.
 * Passes rich metadata (category, I/O, model, node_type) to BaseNode.
 */

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

interface AgentNodeData {
    label?: string;
    icon?: string;
    description?: string;
    category?: string;
    inputs?: string[];
    outputs?: string[];
    model?: string;
    node_type?: string;
}

export function AgentNode({ data, selected }: NodeProps) {
    const nodeData = data as AgentNodeData | undefined;
    const label = String(nodeData?.label || 'Agent');
    const icon = String(nodeData?.icon || '🤖');
    const description = String(nodeData?.description || 'Custom agent');

    return (
        <BaseNode
            icon={icon}
            title={label}
            color="#10b981"
            selected={selected}
            category={nodeData?.category}
            inputs={nodeData?.inputs}
            outputs={nodeData?.outputs}
            model={nodeData?.model}
            nodeType={nodeData?.node_type}
        >
            <p>{description}</p>
        </BaseNode>
    );
}
