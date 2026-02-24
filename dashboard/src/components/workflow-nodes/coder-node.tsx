'use client';

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

export function CoderNode({ data, selected }: NodeProps) {
    return (
        <BaseNode
            icon="💻"
            title="Coder"
            color="#6366f1"
            selected={selected}
        >
            <p>Writes code from plans</p>
        </BaseNode>
    );
}
