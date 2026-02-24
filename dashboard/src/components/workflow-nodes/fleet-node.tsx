'use client';

import React from 'react';
import { NodeProps } from '@xyflow/react';
import { BaseNode } from './base-node';

/**
 * FleetNode - Represents a fleet of AI agents (research, architect, builder, audit)
 * 
 * Each fleet is a coordinated group of agents that work together on a specific phase.
 */
export function FleetNode({ data, selected }: NodeProps) {
    // Extract fleet info from node data
    const label = data?.label as string || 'Fleet';
    const config = data?.config as { model?: string } || {};

    // Determine icon based on fleet type
    const getFleetIcon = () => {
        const labelLower = label.toLowerCase();
        if (labelLower.includes('research')) return '🔍';
        if (labelLower.includes('architect')) return '📐';
        if (labelLower.includes('builder')) return '🔨';
        if (labelLower.includes('audit')) return '🔒';
        return '🤖'; // Default fleet icon
    };

    // Determine color based on fleet type
    const getFleetColor = () => {
        const labelLower = label.toLowerCase();
        if (labelLower.includes('research')) return '#06b6d4'; // cyan
        if (labelLower.includes('architect')) return '#f59e0b'; // amber
        if (labelLower.includes('builder')) return '#10b981'; // emerald
        if (labelLower.includes('audit')) return '#ef4444'; // red
        return '#6366f1'; // Default indigo
    };

    return (
        <BaseNode
            icon={getFleetIcon()}
            title={label}
            color={getFleetColor()}
            selected={selected}
        >
            <div className="fleet-info">
                {config.model && (
                    <p className="fleet-model" style={{ fontSize: '0.75rem', color: '#888', margin: 0 }}>
                        {config.model}
                    </p>
                )}
            </div>
        </BaseNode>
    );
}
