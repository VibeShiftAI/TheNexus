'use client';

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

export function ReviewerNode({ data, selected }: NodeProps) {
    const nodeData = data as { label?: string; category?: string; inputs?: string[]; outputs?: string[]; model?: string; node_type?: string } | undefined;
    return (
        <BaseNode
            icon="🔍"
            title="Reviewer"
            color="#ef4444"
            selected={selected}
            category={nodeData?.category || 'review'}
            inputs={nodeData?.inputs}
            outputs={nodeData?.outputs}
            model={nodeData?.model}
            nodeType={nodeData?.node_type}
        >
            <p>Reviews code and provides feedback</p>
        </BaseNode>
    );
}
