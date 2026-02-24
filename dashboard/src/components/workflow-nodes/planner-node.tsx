'use client';

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

export function PlannerNode({ data, selected }: NodeProps) {
    return (
        <BaseNode
            icon="📋"
            title="Planner"
            color="#f59e0b"
            selected={selected}
        >
            <p>Creates implementation plans</p>
        </BaseNode>
    );
}
