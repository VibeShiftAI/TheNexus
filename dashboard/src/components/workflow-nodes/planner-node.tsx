'use client';

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

export function PlannerNode({ data, selected }: NodeProps) {
    const nodeData = data as { label?: string; category?: string; inputs?: string[]; outputs?: string[]; model?: string; node_type?: string } | undefined;
    return (
        <BaseNode
            icon="📋"
            title="Planner"
            color="#f59e0b"
            selected={selected}
            category={nodeData?.category || 'planning'}
            inputs={nodeData?.inputs}
            outputs={nodeData?.outputs}
            model={nodeData?.model}
            nodeType={nodeData?.node_type}
        >
            <p>Creates implementation plans</p>
        </BaseNode>
    );
}
