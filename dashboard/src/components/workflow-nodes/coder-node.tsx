'use client';

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

export function CoderNode({ data, selected }: NodeProps) {
    const nodeData = data as { label?: string; category?: string; inputs?: string[]; outputs?: string[]; model?: string; node_type?: string } | undefined;
    return (
        <BaseNode
            icon="💻"
            title="Coder"
            color="#6366f1"
            selected={selected}
            category={nodeData?.category || 'implementation'}
            inputs={nodeData?.inputs}
            outputs={nodeData?.outputs}
            model={nodeData?.model}
            nodeType={nodeData?.node_type}
        >
            <p>Writes and edits code</p>
        </BaseNode>
    );
}
