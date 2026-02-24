'use client';

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

export function SupervisorNode({ data, selected }: NodeProps) {
    return (
        <BaseNode
            icon="👔"
            title="Supervisor"
            color="#8b5cf6"
            selected={selected}
        >
            <p>Routes between workers</p>
        </BaseNode>
    );
}
