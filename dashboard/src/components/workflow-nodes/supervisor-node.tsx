'use client';

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

export function SupervisorNode({ data, selected }: NodeProps) {
    const nodeData = data as { label?: string; category?: string; inputs?: string[]; outputs?: string[]; model?: string; node_type?: string } | undefined;
    return (
        <BaseNode
            icon="👑"
            title="Supervisor"
            color="#8b5cf6"
            selected={selected}
            category={nodeData?.category || 'orchestration'}
            inputs={nodeData?.inputs}
            outputs={nodeData?.outputs}
            model={nodeData?.model}
            nodeType={nodeData?.node_type}
        >
            <p>Orchestrates agent coordination</p>
        </BaseNode>
    );
}
