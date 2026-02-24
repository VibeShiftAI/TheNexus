'use client';

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

export function ReviewerNode({ data, selected }: NodeProps) {
    return (
        <BaseNode
            icon="👀"
            title="Reviewer"
            color="#ec4899"
            selected={selected}
        >
            <p>Reviews code quality</p>
        </BaseNode>
    );
}
