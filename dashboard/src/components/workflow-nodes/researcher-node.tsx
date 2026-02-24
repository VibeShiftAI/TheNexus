'use client';

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

export function ResearcherNode({ data, selected }: NodeProps) {
    return (
        <BaseNode
            icon="🔬"
            title="Researcher"
            color="#10b981"
            selected={selected}
        >
            <p>Researches topics and produces reports</p>
        </BaseNode>
    );
}
