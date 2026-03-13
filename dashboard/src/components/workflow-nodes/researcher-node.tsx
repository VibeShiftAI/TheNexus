'use client';

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

export function ResearcherNode({ data, selected }: NodeProps) {
    const nodeData = data as { label?: string; category?: string; inputs?: string[]; outputs?: string[]; model?: string; node_type?: string } | undefined;
    return (
        <BaseNode
            icon="🔬"
            title="Researcher"
            color="#10b981"
            selected={selected}
            category={nodeData?.category || 'research'}
            inputs={nodeData?.inputs}
            outputs={nodeData?.outputs}
            model={nodeData?.model}
            nodeType={nodeData?.node_type}
        >
            <p>Researches topics and produces reports</p>
        </BaseNode>
    );
}
