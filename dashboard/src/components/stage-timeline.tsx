'use client';

/**
 * StageTimeline - Shows execution steps for a workflow stage
 * 
 * Displays a timeline of agent actions with:
 * - Agent icon and name
 * - Status indicator
 * - Duration
 * - Collapsible input/output data
 * - Handoff indicator to next stage
 */

import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Clock, CheckCircle, XCircle, Loader2, ArrowRight } from 'lucide-react';
import { ExecutionStep, ExecutionStage, getTaskTimeline } from '@/lib/nexus';

interface StageTimelineProps {
    projectId: string;
    taskId: string;
    stage: ExecutionStage;
    nextStage?: ExecutionStage;
    isComplete?: boolean;
}

// Agent icons and display names
const AGENT_INFO: Record<string, { icon: string; name: string; color: string }> = {
    'researcher': { icon: '🔬', name: 'Researcher', color: 'text-blue-400' },
    'planner': { icon: '📋', name: 'Planner', color: 'text-purple-400' },
    'coder': { icon: '💻', name: 'Coder', color: 'text-green-400' },
    'reviewer': { icon: '👀', name: 'Reviewer', color: 'text-amber-400' },
    'supervisor': { icon: '👔', name: 'Supervisor', color: 'text-rose-400' },
    'summarizer': { icon: '📝', name: 'Summarizer', color: 'text-cyan-400' },
};

function getAgentInfo(node: string) {
    // Extract base type from node ID like "researcher-1"
    const baseType = node.split('-')[0].toLowerCase();
    return AGENT_INFO[baseType] || { icon: '⚙️', name: node, color: 'text-slate-400' };
}

function formatDuration(ms?: number) {
    if (!ms) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function StageTimeline({
    projectId,
    taskId,
    stage,
    nextStage,
    isComplete = false
}: StageTimelineProps) {
    const [steps, setSteps] = useState<ExecutionStep[]>([]);
    const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        async function loadSteps() {
            setIsLoading(true);
            const loaded = await getTaskTimeline(projectId, taskId, stage);
            setSteps(loaded);
            setIsLoading(false);
        }
        loadSteps();
    }, [projectId, taskId, stage]);

    const toggleExpand = (stepId: string) => {
        setExpandedSteps(prev => {
            const next = new Set(prev);
            if (next.has(stepId)) {
                next.delete(stepId);
            } else {
                next.add(stepId);
            }
            return next;
        });
    };

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
                <Loader2 size={14} className="animate-spin" />
                Loading execution history...
            </div>
        );
    }

    if (steps.length === 0) {
        return null; // Don't show anything if no steps
    }

    return (
        <div className="stage-timeline mt-8 pt-6 border-t border-slate-800">
            <div className="flex items-center gap-2 mb-4">
                <Clock size={14} className="text-slate-500" />
                <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Execution Timeline
                </span>
            </div>

            <div className="space-y-2">
                {steps.map((step, index) => {
                    const agent = getAgentInfo(step.node);
                    const isExpanded = expandedSteps.has(step.id);
                    const hasData = step.input || step.output;

                    return (
                        <div key={step.id} className="relative">
                            {/* Connector line */}
                            {index < steps.length - 1 && (
                                <div className="absolute left-4 top-10 bottom-0 w-0.5 bg-slate-700" />
                            )}

                            <div
                                className={`flex items-start gap-3 p-3 rounded-lg transition-colors ${hasData ? 'cursor-pointer hover:bg-slate-800/50' : ''
                                    }`}
                                onClick={() => hasData && toggleExpand(step.id)}
                            >
                                {/* Status icon */}
                                <div className="relative shrink-0">
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-lg ${step.status === 'completed' ? 'bg-emerald-500/20' :
                                        step.status === 'running' ? 'bg-blue-500/20' :
                                            step.status === 'failed' ? 'bg-red-500/20' :
                                                'bg-slate-700'
                                        }`}>
                                        {agent.icon}
                                    </div>
                                    {step.status === 'completed' && (
                                        <CheckCircle size={12} className="absolute -bottom-0.5 -right-0.5 text-emerald-400" />
                                    )}
                                    {step.status === 'running' && (
                                        <Loader2 size={12} className="absolute -bottom-0.5 -right-0.5 text-blue-400 animate-spin" />
                                    )}
                                    {step.status === 'failed' && (
                                        <XCircle size={12} className="absolute -bottom-0.5 -right-0.5 text-red-400" />
                                    )}
                                </div>

                                {/* Step info */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className={`font-medium text-sm ${agent.color}`}>
                                            {agent.name}
                                        </span>
                                        {step.durationMs && (
                                            <span className="text-xs text-slate-500">
                                                {formatDuration(step.durationMs)}
                                            </span>
                                        )}
                                        {hasData && (
                                            <span className="ml-auto">
                                                {isExpanded ? (
                                                    <ChevronDown size={14} className="text-slate-500" />
                                                ) : (
                                                    <ChevronRight size={14} className="text-slate-500" />
                                                )}
                                            </span>
                                        )}
                                    </div>
                                    {step.startedAt && (
                                        <div className="text-xs text-slate-500 mt-0.5">
                                            {new Date(step.startedAt).toLocaleTimeString()}
                                        </div>
                                    )}
                                    {step.error && (
                                        <div className="text-xs text-red-400 mt-1">
                                            Error: {step.error}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Expanded data */}
                            {isExpanded && hasData && (
                                <div className="ml-11 mr-3 mb-3 p-3 rounded-lg bg-slate-800/50 border border-slate-700 text-xs font-mono">
                                    {step.input && (
                                        <div className="mb-2">
                                            <div className="text-slate-500 mb-1">Input:</div>
                                            <pre className="text-slate-300 overflow-x-auto">
                                                {JSON.stringify(step.input, null, 2)}
                                            </pre>
                                        </div>
                                    )}
                                    {step.output && (
                                        <div>
                                            <div className="text-slate-500 mb-1">Output:</div>
                                            <pre className="text-slate-300 overflow-x-auto">
                                                {JSON.stringify(step.output, null, 2)}
                                            </pre>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Handoff indicator */}
            {isComplete && nextStage && (
                <div className="flex items-center gap-2 mt-4 p-3 rounded-lg bg-purple-500/10 border border-purple-500/30">
                    <ArrowRight size={16} className="text-purple-400" />
                    <span className="text-sm text-purple-300">
                        Handed off to {nextStage === 'plan' ? 'Planning' : nextStage === 'implement' ? 'Implementation' : nextStage}
                    </span>
                </div>
            )}
        </div>
    );
}

export default StageTimeline;
