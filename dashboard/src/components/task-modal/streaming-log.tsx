"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal, Cpu, Database, Bug, ChevronRight, AlertCircle, CheckCircle2, FileText, ChevronDown, ChevronUp, FileCode2, ScrollText, ClipboardList, GitCommit, Loader2 } from "lucide-react";

interface StreamingLogProps {
    runId: string;
    projectId?: string;
    taskId?: string;
    onInterrupt?: (payload: any) => void;
    onStateUpdate?: (update: any) => void;
    onNodeChange?: (node: string) => void;
    onApproveCommit?: () => Promise<void>;
    onAutoComplete?: () => void;  // Called on workflow_complete without needing button click  // Called when user clicks Approve & Commit
}

interface LogBlock {
    id: string;
    type: 'agent' | 'tool' | 'system' | 'error';
    name: string;
    content: string;
    status?: 'running' | 'completed' | 'failed';
    timestamp: number;
    isStreaming?: boolean;
}

interface TaskContext {
    task_title?: string;
    task_description?: string;
    project_path?: string;
    project_id?: string;
    task_id?: string;
}

// Artifact detection patterns and their styling
const ARTIFACT_PATTERNS = [
    { pattern: /^#*\s*(?:📚|🔬)?\s*(?:RESEARCH\s*DOSSIER|Research\s*Dossier|research_dossier)/im, type: 'research', label: 'Research Dossier', color: 'cyan', icon: ScrollText },
    { pattern: /^#*\s*(?:📋|🏗️)?\s*(?:IMPLEMENTATION\s*PLAN|Implementation\s*Plan|implementation_plan|Blueprint)/im, type: 'plan', label: 'Implementation Plan', color: 'purple', icon: ClipboardList },
    { pattern: /^#*\s*(?:📄)?\s*(?:AUDIT\s*REPORT|Audit\s*Report|audit_report)/im, type: 'audit', label: 'Audit Report', color: 'amber', icon: FileCode2 },
];

function RenderContent({ content }: { content: string }) {
    // Check if this content contains an artifact
    for (const { pattern, type, label, color, icon: Icon } of ARTIFACT_PATTERNS) {
        if (pattern.test(content)) {
            const colorStyles = {
                cyan: 'border-cyan-500/50 bg-gradient-to-r from-cyan-950/30 to-transparent',
                purple: 'border-purple-500/50 bg-gradient-to-r from-purple-950/30 to-transparent',
                amber: 'border-amber-500/50 bg-gradient-to-r from-amber-950/30 to-transparent',
            };
            const iconColors = {
                cyan: 'text-cyan-400',
                purple: 'text-purple-400',
                amber: 'text-amber-400',
            };
            const labelColors = {
                cyan: 'text-cyan-300',
                purple: 'text-purple-300',
                amber: 'text-amber-300',
            };

            return (
                <div className={`mt-2 -mx-2 p-4 rounded-lg border-l-4 ${colorStyles[color as keyof typeof colorStyles]}`}>
                    <div className={`flex items-center gap-2 mb-2 ${iconColors[color as keyof typeof iconColors]}`}>
                        <Icon size={18} />
                        <span className={`text-sm font-bold uppercase tracking-wider ${labelColors[color as keyof typeof labelColors]}`}>
                            {label}
                        </span>
                    </div>
                    <div className="text-slate-300 text-sm leading-relaxed pl-6">
                        {content}
                    </div>
                </div>
            );
        }
    }

    // Default rendering
    return <>{content}</>;
}

export function StreamingLog({ runId, projectId, taskId, onInterrupt, onStateUpdate, onNodeChange, onApproveCommit, onAutoComplete }: StreamingLogProps) {
    const [blocks, setBlocks] = useState<LogBlock[]>([]);
    const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
    const [context, setContext] = useState<TaskContext | null>(null);
    const [contextExpanded, setContextExpanded] = useState(true);
    const [historyLoaded, setHistoryLoaded] = useState(false);
    const [workflowComplete, setWorkflowComplete] = useState(false);
    const [isCommitting, setIsCommitting] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const eventSourceRef = useRef<EventSource | null>(null);

    // Auto-scroll to bottom
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [blocks, connectionStatus]);

    // Fetch history on mount (before connecting to SSE)
    useEffect(() => {
        if (!runId) return;

        const fetchHistory = async () => {
            try {
                const response = await fetch(`http://localhost:8000/runs/${runId}/history`);
                if (response.ok) {
                    const data = await response.json();

                    // Set context
                    if (data.context) {
                        setContext(data.context);
                    }

                    // Convert historical activity_log to blocks
                    if (data.activity_log && data.activity_log.length > 0) {
                        const historicalBlocks: LogBlock[] = data.activity_log.map((entry: any, index: number) => {
                            // Map event types to block types
                            let blockType: 'agent' | 'tool' | 'system' | 'error' = 'system';
                            if (entry.type === 'error') blockType = 'error';
                            else if (entry.type === 'agent') blockType = 'agent';
                            else if (entry.type === 'tool_start' || entry.type === 'tool_end') blockType = 'tool';

                            return {
                                id: `hist-${index}`,
                                type: blockType,
                                name: entry.stage || 'System',
                                content: entry.message,
                                timestamp: new Date(entry.timestamp).getTime(),
                                isStreaming: false
                            };
                        });
                        setBlocks(historicalBlocks);
                    }

                    // Check if workflow is paused at an interrupt point (for restored workflows)
                    // Only fire if the run is actually in interrupted/paused status
                    const pausedAt = data.next || data.paused_at;
                    if (pausedAt && onInterrupt && (data.status === 'interrupted' || data.status === 'paused')) {
                        // Normalize to array format expected by overlay
                        const interruptNodes = Array.isArray(pausedAt) ? pausedAt : [pausedAt];
                        // Only trigger for known interrupt points
                        const interruptPoints = ['nexus_prime', 'human_in_loop', 'await_research_approval', 'await_plan_approval', 'review_docs'];
                        const matchingInterrupt = interruptNodes.find((n: string) =>
                            interruptPoints.includes(n) || n.includes('approval') || n.includes('human')
                        );
                        if (matchingInterrupt) {
                            console.log('[StreamingLog] Restored workflow paused at:', matchingInterrupt);
                            onInterrupt({ type: 'interrupt', interrupts: interruptNodes, values: data.outputs || {} });
                        }
                    }

                    setHistoryLoaded(true);
                }
            } catch (err) {
                console.error("Failed to fetch history:", err);
                setHistoryLoaded(true); // Continue anyway
            }
        };

        fetchHistory();
    }, [runId]);

    // Connect to SSE after history is loaded
    useEffect(() => {
        if (!runId || !historyLoaded) return;

        // Cleanup previous
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }

        const eventSource = new EventSource(`http://localhost:8000/runs/${runId}/stream`);

        setConnectionStatus('connecting');

        eventSource.onopen = () => {
            setConnectionStatus('connected');
        };

        eventSource.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                handleEvent(payload);
            } catch (e) {
                console.error("Failed to parse SSE:", event.data, e);
            }
        };

        eventSource.onerror = (err) => {
            console.error("SSE Error:", err);
            setConnectionStatus('disconnected');
            eventSource.close();
        };

        eventSourceRef.current = eventSource;

        return () => {
            if (eventSourceRef.current) eventSourceRef.current.close();
        };
    }, [runId, historyLoaded]);

    const handleEvent = (event: any) => {
        const { type, kind, name, data, tags } = event;
        const now = Date.now();

        // 1. Handle Interrupts
        if (type === 'interrupt') {
            if (onInterrupt) onInterrupt(event);
            addSystemBlock('Stopped for Human Input', 'warning');
            return;
        }

        // 2. Handle Logs
        if (type === 'log') {
            addSystemBlock(event.message, event.level === 'error' ? 'error' : 'info');
            return;
        }

        // 2b. Handle workflow_complete event from backend
        if (type === 'workflow_complete') {
            setWorkflowComplete(true);
            addSystemBlock('Workflow completed successfully!', 'info');
            // Auto-complete if callback provided (for generic workflows that already had user review)
            if (onAutoComplete) {
                onAutoComplete();
            }
            return;
        }

        // 3. Handle Graph Events
        if (type === 'graph_event') {

            // DEMULTIPLEXING LOGIC

            // A. Chat Stream (Token by Token)
            if (kind === 'on_chat_model_stream') {
                // Content can be a string or an object like {type: "text", text: "..."}
                const rawContent = data?.chunk?.content;
                let chunk = '';

                if (typeof rawContent === 'string') {
                    chunk = rawContent;
                } else if (Array.isArray(rawContent)) {
                    // Handle array of content blocks (e.g., Anthropic format)
                    chunk = rawContent
                        .map(c => typeof c === 'string' ? c : (c?.text || c?.content || ''))
                        .join('');
                } else if (rawContent && typeof rawContent === 'object') {
                    // Handle single content block object
                    chunk = rawContent.text || rawContent.content || JSON.stringify(rawContent);
                }

                if (!chunk) return;

                setBlocks(prev => {
                    const last = prev[prev.length - 1];
                    // If last block is the same agent and is streaming, append
                    if (last && last.type === 'agent' && last.name === name && last.isStreaming) {
                        return [
                            ...prev.slice(0, -1),
                            { ...last, content: last.content + chunk }
                        ];
                    }
                    // Otherwise start new block
                    return [...prev, {
                        id: Math.random().toString(36),
                        type: 'agent',
                        name: name,
                        content: chunk,
                        timestamp: now,
                        isStreaming: true
                    }];
                });
            }

            // B. Chain/Node Start/End
            else if (kind === 'on_chain_start') {
                // Notify parent of any node start (generic — works for all workflow types)
                if (name && name !== '__start__' && name !== '__end__') {
                    if (onNodeChange) onNodeChange(name);
                    addSystemBlock(`Starting ${name}...`, 'info');
                }
            }

            else if (kind === 'on_chain_end') {
                // Mark the block for this node as done (generic — any node)
                if (name && name !== '__start__' && name !== '__end__') {
                    // Update active node (astream only yields after completion)
                    if (onNodeChange) onNodeChange(name);
                    setBlocks(prev => {
                        const last = prev[prev.length - 1];
                        if (last && last.name === name) {
                            return [...prev.slice(0, -1), { ...last, isStreaming: false }];
                        }
                        return prev;
                    });

                    // Also pass state updates up
                    if (onStateUpdate && data?.output) {
                        onStateUpdate(data.output);

                        // Check if workflow completed (supervisor routing to finish)
                        if (data.output?.evaluator_decision === 'finish') {
                            setWorkflowComplete(true);
                            addSystemBlock('Workflow completed successfully!', 'info');
                        }
                    }
                }
            }

            // C. Tool Usage
            else if (kind === 'on_tool_start') {
                setBlocks(prev => [...prev, {
                    id: Math.random().toString(36),
                    type: 'tool',
                    name: name,
                    content: `Input: ${JSON.stringify(data.input).substring(0, 100)}...`,
                    status: 'running',
                    timestamp: now
                }]);
            }
            else if (kind === 'on_tool_end') {
                setBlocks(prev => {
                    // Find the last running tool with this name and mark complete
                    const idx = [...prev].reverse().findIndex(b => b.type === 'tool' && b.name === name && b.status === 'running');
                    if (idx !== -1) {
                        const realIdx = prev.length - 1 - idx;
                        const newBlocks = [...prev];
                        newBlocks[realIdx] = {
                            ...newBlocks[realIdx],
                            status: 'completed',
                            content: newBlocks[realIdx].content + `\nOutput: ${JSON.stringify(data.output).substring(0, 100)}...`
                        };
                        return newBlocks;
                    }
                    return prev;
                });
            }
        }
    };

    const addSystemBlock = (content: string, level: 'info' | 'warning' | 'error' = 'info') => {
        setBlocks(prev => [...prev, {
            id: Math.random().toString(36),
            type: level === 'error' ? 'error' : 'system',
            name: 'System',
            content: content,
            timestamp: Date.now()
        }]);
    };

    return (
        <div className="flex flex-col h-full bg-slate-950/80 rounded-lg border border-slate-800 overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/50 flex justify-between items-center">
                <div className="flex items-center gap-2">
                    <Terminal size={14} className="text-slate-400" />
                    <span className="text-xs font-medium text-slate-300">Live Agent Activity</span>
                </div>
                <div className="flex items-center gap-2">
                    {/* Approve & Commit Button - shown when workflow completes (hidden if auto-completing) */}
                    {workflowComplete && onApproveCommit && !onAutoComplete && (
                        <button
                            onClick={async () => {
                                setIsCommitting(true);
                                try {
                                    await onApproveCommit();
                                    addSystemBlock('Changes committed and pushed!', 'info');
                                } catch (e) {
                                    addSystemBlock(`Commit failed: ${e}`, 'error');
                                } finally {
                                    setIsCommitting(false);
                                }
                            }}
                            disabled={isCommitting}
                            className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isCommitting ? (
                                <Loader2 size={12} className="animate-spin" />
                            ) : (
                                <GitCommit size={12} />
                            )}
                            {isCommitting ? 'Committing...' : 'Approve & Commit'}
                        </button>
                    )}
                    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${connectionStatus === 'connected' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                        connectionStatus === 'connecting' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                            'bg-red-500/10 text-red-400 border-red-500/20'
                        }`}>
                        <div className={`w-1.5 h-1.5 rounded-full ${connectionStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
                            connectionStatus === 'connecting' ? 'bg-amber-500' : 'bg-red-500'
                            }`} />
                        {connectionStatus.toUpperCase()}
                    </div>
                </div>
            </div>

            {/* Task Context Section */}
            {context && (
                <div className="border-b border-slate-800 bg-slate-900/30">
                    <button
                        onClick={() => setContextExpanded(!contextExpanded)}
                        className="w-full px-3 py-2 flex items-center justify-between text-xs text-slate-400 hover:text-slate-300 transition-colors"
                    >
                        <div className="flex items-center gap-2">
                            <FileText size={12} />
                            <span>Task Context</span>
                        </div>
                        {contextExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                    {contextExpanded && (
                        <div className="px-3 pb-3 space-y-2 text-xs">
                            {context.task_title && (
                                <div>
                                    <span className="text-slate-500">Title:</span>
                                    <span className="ml-2 text-slate-300">{context.task_title}</span>
                                </div>
                            )}
                            {context.task_description && (
                                <div>
                                    <span className="text-slate-500">Description:</span>
                                    <p className="mt-1 text-slate-400 bg-slate-950/50 p-2 rounded border border-slate-800 max-h-20 overflow-y-auto">
                                        {context.task_description}
                                    </p>
                                </div>
                            )}
                            {context.project_path && (
                                <div>
                                    <span className="text-slate-500">Path:</span>
                                    <code className="ml-2 text-cyan-400 bg-slate-950/50 px-1 rounded">{context.project_path}</code>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto p-4 space-y-4 font-mono text-sm scroll-smooth"
            >
                {blocks.length === 0 && (
                    <div className="text-center text-slate-600 mt-10 italic">
                        Waiting for streaming events...
                    </div>
                )}

                {blocks.map((block) => (
                    <div key={block.id} className={`flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                        <div className="flex-shrink-0 mt-0.5">
                            {GetIconForBlock(block)}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2 mb-0.5">
                                <span className={`text-xs font-bold uppercase tracking-wider ${GetColorForBlock(block)}`}>
                                    {block.name}
                                </span>
                                <span className="text-[10px] text-slate-600">
                                    {new Date(block.timestamp).toLocaleTimeString()}
                                </span>
                            </div>
                            <div className={`whitespace-pre-wrap break-words leading-relaxed text-slate-300 ${block.type === 'tool' ? 'text-xs bg-slate-900/50 p-2 rounded border border-slate-800' : ''
                                }`}>
                                <RenderContent content={block.content} />
                                {block.isStreaming && <span className="inline-block w-1.5 h-4 ml-1 align-middle bg-emerald-500 animate-pulse" />}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function GetIconForBlock(block: LogBlock) {
    switch (block.type) {
        case 'agent':
            if (block.name.includes('research')) return <Database size={14} className="text-cyan-400" />;
            if (block.name.includes('architect')) return <Cpu size={14} className="text-purple-400" />;
            if (block.name.includes('builder')) return <Terminal size={14} className="text-emerald-400" />;
            if (block.name.includes('audit')) return <Bug size={14} className="text-red-400" />;
            return <Cpu size={14} className="text-blue-400" />;
        case 'tool':
            return <ChevronRight size={14} className="text-amber-400" />;
        case 'error':
            return <AlertCircle size={14} className="text-red-500" />;
        case 'system':
        default:
            return <CheckCircle2 size={14} className="text-slate-500" />;
    }
}

function GetColorForBlock(block: LogBlock) {
    switch (block.type) {
        case 'agent': return 'text-cyan-400';
        case 'tool': return 'text-amber-400';
        case 'error': return 'text-red-500';
        default: return 'text-slate-500';
    }
}
