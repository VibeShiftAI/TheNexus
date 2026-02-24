'use client';

/**
 * Agent Node Component
 * Generic node that renders any agent type from Agent Manager
 */

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

export function AgentNode({ data, selected }: NodeProps) {
    const nodeData = data as { label?: string; icon?: string; description?: string } | undefined;
    const label = String(nodeData?.label || 'Agent');
    const icon = String(nodeData?.icon || '🤖');
    const description = String(nodeData?.description || 'Custom agent');

    return (
        <BaseNode
            icon={icon}
            title={label}
            color="#10b981"
            selected={selected}
        >
            <p>{description}</p>
        </BaseNode>
    );
}
