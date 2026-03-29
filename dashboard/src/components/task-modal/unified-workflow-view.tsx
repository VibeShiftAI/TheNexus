"use client";

import { useEffect, useState } from "react";
import { ActiveGraph } from "./active-graph";
import { StreamingLog } from "./streaming-log";
import { Play, Pause, AlertTriangle, Check, X, FileSearch } from "lucide-react";
import { approveWalkthrough } from "@/lib/nexus";
import { ArtifactPanel, Artifact } from "../artifact-viewer";

interface UnifiedWorkflowViewProps {
    projectId: string;
    taskId: string;
    runId: string;
    initialStatus?: string;
    onWorkflowComplete?: () => void;
}

// Fallback graph definition for Nexus Prime workflows (when no graph_config is available)
const NEXUS_GRAPH_DEF = `
graph TD
    START((Start))
    nexus_prime[Nexus Prime]
    research_fleet[Research Fleet]
    architect_fleet[Architect Fleet]
    builder_fleet[Builder Fleet]
    audit_fleet[Audit Fleet]
    await_research_approval{Research Approval}
    await_plan_approval{Plan Approval}
    human_in_loop{Human Input}
    END((End))
    START --> nexus_prime
    nexus_prime --> research_fleet
    research_fleet --> await_research_approval
    await_research_approval --> nexus_prime
    nexus_prime --> architect_fleet
    architect_fleet --> await_plan_approval
    await_plan_approval --> nexus_prime
    nexus_prime --> builder_fleet
    builder_fleet --> nexus_prime
    nexus_prime --> audit_fleet
    audit_fleet --> nexus_prime
    nexus_prime --> human_in_loop
    human_in_loop --> nexus_prime
    nexus_prime --> END
    classDef default fill:#1e293b,stroke:#475569,stroke-width:1px,color:#94a3b8;
    classDef hub fill:#4f46e5,stroke:#6366f1,color:#fff,stroke-width:2px;
    classDef fleet fill:#0f766e,stroke:#14b8a6,color:#fff;
    classDef gate fill:#c2410c,stroke:#f97316,color:#fff,shape:diamond;
    class nexus_prime hub;
    class research_fleet,architect_fleet,builder_fleet,audit_fleet fleet;
    class await_research_approval,await_plan_approval,human_in_loop gate;
`;

/**
 * Generate a Mermaid graph definition from a workflow's graph_config.
 * Produces a clean flowchart from the nodes and edges arrays.
 */
function generateMermaidFromConfig(graphConfig: any): string {
    const nodes = graphConfig?.nodes || [];
    const edges = graphConfig?.edges || [];

    if (nodes.length === 0) return NEXUS_GRAPH_DEF;

    let mermaid = 'graph LR\n';

    // Add nodes with labels
    for (const node of nodes) {
        const id = node.id;
        const label = node.data?.label || node.id;
        const type = node.type || '';

        // Use different shapes based on node type
        if (type.includes('gate') || type.includes('review') || type.includes('approval')) {
            mermaid += `    ${id}{${label}}\n`;
        } else {
            mermaid += `    ${id}["${label}"]\n`;
        }
    }

    // Add edges
    for (const edge of edges) {
        const label = edge.label ? ` -->|${edge.label}|` : ' -->';
        mermaid += `    ${edge.source}${label} ${edge.target}\n`;
    }

    // Add styling
    mermaid += `    classDef default fill:#1e293b,stroke:#475569,stroke-width:1px,color:#94a3b8;\n`;
    mermaid += `    classDef gate fill:#c2410c,stroke:#f97316,color:#fff;\n`;

    // Apply gate class to review/gate nodes
    const gateNodes = nodes
        .filter((n: any) => (n.type || '').includes('gate') || (n.type || '').includes('review'))
        .map((n: any) => n.id);
    if (gateNodes.length > 0) {
        mermaid += `    class ${gateNodes.join(',')} gate;\n`;
    }

    return mermaid;
}

export function UnifiedWorkflowView({ projectId, taskId, runId, initialStatus, onWorkflowComplete }: UnifiedWorkflowViewProps) {
    const [activeNode, setActiveNode] = useState<string | null>(null);
    const [interruptData, setInterruptData] = useState<any | null>(null);
    const [isResuming, setIsResuming] = useState(false);
    const [feedbackText, setFeedbackText] = useState('');
    const [interruptApproved, setInterruptApproved] = useState(false);
    const [isApprovingWalkthrough, setIsApprovingWalkthrough] = useState(false);

    // Artifact panel state
    const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
    const [currentArtifact, setCurrentArtifact] = useState<Artifact | null>(null);
    const [docChangesState, setDocChangesState] = useState<any | null>(null);

    // Dynamic graph definition (fetched from run's graph_config)
    const [graphDef, setGraphDef] = useState<string>(NEXUS_GRAPH_DEF);

    // Fetch graph_config from run history to generate dynamic topology
    useEffect(() => {
        if (!runId) return;

        const fetchGraphConfig = async () => {
            try {
                const res = await fetch(`/runs/${runId}/history`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.graph_config) {
                        const dynamicDef = generateMermaidFromConfig(data.graph_config);
                        setGraphDef(dynamicDef);
                    }
                }
            } catch (err) {
                console.error('[UnifiedWorkflowView] Failed to fetch graph config:', err);
                // Fall back to default Nexus Prime graph
            }
        };

        fetchGraphConfig();
    }, [runId]);

    // Handler for Approve & Commit button in StreamingLog (fallback)
    const handleApproveCommit = async () => {
        try {
            await approveWalkthrough(projectId, taskId);
            onWorkflowComplete?.();
        } catch (error) {
            console.error('Failed to approve and commit:', error);
            throw error;  // Re-throw so StreamingLog can show the error
        }
    };

    // Handler: workflow completed — surface walkthrough in ArtifactPanel for review
    const handleWorkflowCompleteWithArtifact = (walkthroughContent: string) => {
        const artifact: Artifact = {
            id: `walkthrough-${Date.now()}`,
            key: 'walkthrough',
            name: 'Implementation Walkthrough',
            content: walkthroughContent,
            category: 'walkthrough',
            mime_type: 'text/markdown',
            file_extension: '.md',
            version: 1,
        };
        setCurrentArtifact(artifact);
        setArtifactPanelOpen(true);
        // Immediately notify parent to refresh task status (backend already set it to 'complete')
        onWorkflowComplete?.();
    };

    const handleInterrupt = (payload: any) => {
        console.log("Interrupt received:", payload);
        // Payload: { type: 'interrupt', interrupts: ['await_research_approval'], values: {...} }
        // The artifact is in values.pending_approval.artifact
        setInterruptData(payload);

        // Highlight the gate node
        if (payload.interrupts && payload.interrupts.length > 0) {
            setActiveNode(payload.interrupts[0]);
        }

        // Extract artifact from the state values
        // The artifact is nested in values.pending_approval.artifact (live SSE)
        const pendingApproval = payload.values?.pending_approval;
        let artifact = pendingApproval?.artifact;

        // Fallback: reconstruct artifact from outputs when reconnecting
        // (fetchHistory sends outputs directly, not the structured pending_approval)
        if (!artifact && payload.interrupts?.length > 0) {
            const interruptType = payload.interrupts[0];
            const outputs = payload.values || {};

            if (interruptType === 'await_research_approval' || interruptType.includes('research')) {
                const content = outputs.research_dossier;
                if (content) {
                    // Normalize content if it's a Gemini parts list
                    let normalizedContent = content;
                    if (Array.isArray(content)) {
                        normalizedContent = content
                            .map((p: any) => typeof p === 'string' ? p : (p?.text || ''))
                            .join('\n');
                    }
                    artifact = {
                        id: `restored-research-${Date.now()}`,
                        key: 'research_dossier',
                        name: 'Research Dossier',
                        content: normalizedContent,
                        category: 'research',
                        mime_type: 'text/markdown',
                        file_extension: '.md',
                        version: 1,
                    };
                }
            } else if (interruptType === 'human_in_loop' || interruptType === 'human_help') {
                // Human-in-loop: prefer walkthrough over stale plan
                const wt = outputs.walkthrough || outputs.source_artifacts?.walkthrough;
                if (wt) {
                    let normalizedContent = wt;
                    if (Array.isArray(wt)) {
                        normalizedContent = wt
                            .map((p: any) => typeof p === 'string' ? p : (p?.text || ''))
                            .join('\n');
                    }
                    artifact = {
                        id: `restored-walkthrough-${Date.now()}`,
                        key: 'walkthrough',
                        name: 'Implementation Walkthrough',
                        content: typeof normalizedContent === 'string' ? normalizedContent : JSON.stringify(normalizedContent, null, 2),
                        category: 'walkthrough',
                        mime_type: 'text/markdown',
                        file_extension: '.md',
                        version: 1,
                    };
                }
                // If no walkthrough exists, don't show anything (avoids stale plan display)
            } else if (interruptType === 'await_plan_approval' || interruptType.includes('plan')) {
                const blueprint = outputs.blueprint;
                const content = blueprint?.spec_markdown || outputs.plan;
                if (content) {
                    artifact = {
                        id: `restored-plan-${Date.now()}`,
                        key: 'implementation_plan',
                        name: 'Implementation Plan',
                        content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
                        category: 'plan',
                        mime_type: 'text/markdown',
                        file_extension: '.md',
                        version: 1,
                    };
                }
            } else if (interruptType === 'review_docs' || interruptType.includes('doc_review')) {
                // Doc review interrupt — reconstruct from outputs
                const docChanges = outputs.outputs?.doc_changes || outputs.doc_changes;
                if (docChanges) {
                    artifact = {
                        id: `restored-doc-review-${Date.now()}`,
                        key: 'doc_changes',
                        name: 'Documentation Changes',
                        content: `Review changes across ${docChanges.files?.length || 0} files`,
                        content_json: docChanges,
                        category: 'doc_changes',
                        mime_type: 'application/json',
                        file_extension: '.json',
                        version: 1,
                    };
                }
            }
        }

        if (artifact) {
            console.log("Artifact found in interrupt:", artifact);
            setCurrentArtifact(artifact);
            setArtifactPanelOpen(true);
            // Initialize doc changes state for per-hunk review
            if (artifact.category === 'doc_changes' && artifact.content_json) {
                setDocChangesState(artifact.content_json);
            }
        }
    };

    const handleNodeChange = (node: string) => {
        // If we are just entering a node, highlight it
        setActiveNode(node);
        // Clear interrupt state if we moved
        setInterruptData(null);
        setFeedbackText('');
        // Close artifact panel if workflow moves on
        setArtifactPanelOpen(false);
        setCurrentArtifact(null);
    };

    // Handlers for artifact panel approve/reject
    const handleArtifactApprove = async () => {
        setArtifactPanelOpen(false);
        setInterruptApproved(true);  // Mark that user already reviewed

        // Walkthrough approval: commit & push, then signal completion
        if (currentArtifact?.category === 'walkthrough') {
            setIsApprovingWalkthrough(true);
            try {
                await approveWalkthrough(projectId, taskId);
                onWorkflowComplete?.();
            } catch (error) {
                console.error('Failed to approve walkthrough:', error);
            } finally {
                setIsApprovingWalkthrough(false);
            }
            return;
        }

        // If this is a doc_changes review, pass hunk decisions
        if (currentArtifact?.category === 'doc_changes' && docChangesState) {
            // Auto-approve any hunks still in "pending" status
            const finalChanges = {
                ...docChangesState,
                files: docChangesState.files?.map((file: any) => ({
                    ...file,
                    hunks: file.hunks?.map((hunk: any) => ({
                        ...hunk,
                        status: hunk.status === 'pending' ? 'approved' : hunk.status
                    }))
                })) || []
            };
            handleResume('approve', feedbackText || 'Approved', finalChanges);
        } else {
            handleResume('approve', feedbackText || 'Looks good');
        }
    };

    const handleArtifactReject = (feedback: string) => {
        setArtifactPanelOpen(false);
        handleResume('reject', feedback);
    };

    const handleResume = async (action: 'approve' | 'reject', feedback?: string, docChanges?: any) => {
        if (!interruptData) return;

        setIsResuming(true);
        try {
            const currentInterrupt = interruptData.interrupts[0];
            const feedbackText = feedback || (action === 'approve' ? "Looks good" : "Please revise");

            // Build the request body
            const body: any = { approval_action: action, feedback: feedbackText };

            // For doc_review interrupts, include hunk decisions
            if (currentInterrupt === 'review_docs' && docChanges) {
                body.doc_changes = docChanges;
            }

            await fetch(`/runs/${runId}/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            setInterruptData(null);
            setDocChangesState(null);
        } catch (e) {
            console.error("Failed to resume:", e);
        } finally {
            setIsResuming(false);
        }
    };

    return (
        <div className="flex flex-col h-[600px] gap-4">

            {/* Top Area: Graph (Right) and Main Chat (Left) */}
            <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4 min-h-0">

                {/* Zone A: Chat (2/3 width) */}
                <div className="md:col-span-2 min-h-0">
                    <StreamingLog
                        runId={runId}
                        projectId={projectId}
                        taskId={taskId}
                        onInterrupt={handleInterrupt}
                        onNodeChange={handleNodeChange}
                        onApproveCommit={handleApproveCommit}
                        onWorkflowCompleteWithArtifact={handleWorkflowCompleteWithArtifact}
                    />
                </div>

                {/* Zone B: Graph (1/3 width) */}
                <div className="md:col-span-1 min-h-0 flex flex-col gap-4">
                    <div className="flex-1 min-h-0 relative">
                        <ActiveGraph
                            definition={graphDef}
                            activeNode={activeNode}
                        />

                        {/* Interrupt Overlay for Graph */}
                        {interruptData && (
                            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-10 rounded-lg">
                                <div className="bg-slate-900 border border-amber-500/50 rounded-xl p-4 shadow-2xl max-w-sm w-full animate-in zoom-in-95 duration-200">
                                    <div className="flex items-center gap-3 mb-3 text-amber-400">
                                        <AlertTriangle size={24} />
                                        <h3 className="font-bold text-lg">
                                            {interruptData.interrupts[0] === 'await_research_approval' ? 'Research Approval Required' :
                                                interruptData.interrupts[0] === 'await_plan_approval' ? 'Plan Approval Required' :
                                                    'Input Required'}
                                        </h3>
                                    </div>
                                    <p className="text-slate-300 text-sm mb-3">
                                        {interruptData.interrupts[0] === 'await_research_approval' ? (
                                            <>Review the <strong className="text-cyan-400">Research Dossier</strong> in the chat and provide your decision.</>
                                        ) : interruptData.interrupts[0] === 'await_plan_approval' ? (
                                            <>Review the <strong className="text-purple-400">Implementation Plan</strong> in the chat and provide your decision.</>
                                        ) : (
                                            <>The workflow is paused at <strong>{interruptData.interrupts[0]}</strong>. Please review the artifacts and provide a decision.</>
                                        )}
                                    </p>

                                    {/* Feedback textarea */}
                                    <div className="mb-4">
                                        <label className="block text-xs text-slate-500 mb-1">Comments (optional)</label>
                                        <textarea
                                            value={feedbackText}
                                            onChange={(e) => setFeedbackText(e.target.value)}
                                            placeholder="Add feedback or suggestions..."
                                            className="w-full h-20 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-amber-500/50 resize-none"
                                        />
                                    </div>

                                    <div className="flex flex-col gap-2">
                                        {/* Accept with Comments (if there's feedback) */}
                                        {feedbackText.trim() && (
                                            <button
                                                onClick={() => handleResume('approve', feedbackText)}
                                                disabled={isResuming}
                                                className="w-full py-2 px-3 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors flex items-center justify-center gap-2 text-sm"
                                            >
                                                <Check size={16} /> Accept with Comments
                                            </button>
                                        )}

                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => handleResume('reject', feedbackText || "Please revise")}
                                                disabled={isResuming}
                                                className="flex-1 py-2 px-3 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors flex items-center justify-center gap-2"
                                            >
                                                <X size={16} /> Reject
                                            </button>
                                            <button
                                                onClick={() => handleResume('approve', feedbackText || "Looks good")}
                                                disabled={isResuming}
                                                className="flex-1 py-2 px-3 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors flex items-center justify-center gap-2"
                                            >
                                                <Check size={16} /> Approve
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Zone C: State / Mini-stats */}
                    <div className="h-32 bg-slate-900/50 rounded-lg border border-slate-800 p-3">
                        <div className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Live Context</div>
                        <div className="grid grid-cols-2 gap-2">
                            <div className="bg-slate-950 p-2 rounded border border-slate-800/50">
                                <div className="text-[10px] text-slate-500">Run ID</div>
                                <div className="text-xs font-mono text-slate-300 truncate" title={runId}>{runId.split('-')[0]}...</div>
                            </div>
                            <div className="bg-slate-950 p-2 rounded border border-slate-800/50">
                                <div className="text-[10px] text-slate-500">Active Node</div>
                                <div className="text-xs text-amber-400 truncate">{activeNode || 'Initializing...'}</div>
                            </div>
                        </div>

                        {/* Open Artifact Panel button (when artifact exists but panel closed) */}
                        {currentArtifact && !artifactPanelOpen && (
                            <button
                                onClick={() => setArtifactPanelOpen(true)}
                                className="mt-2 w-full py-1.5 px-2 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 text-xs flex items-center justify-center gap-1.5 hover:bg-purple-500/20 transition-colors"
                            >
                                <FileSearch size={12} />
                                Review {currentArtifact.category} Artifact
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Artifact Review Side Panel */}
            <ArtifactPanel
                artifact={currentArtifact}
                isOpen={artifactPanelOpen}
                onClose={() => setArtifactPanelOpen(false)}
                onApprove={handleArtifactApprove}
                onReject={handleArtifactReject}
                onDocChangesUpdate={setDocChangesState}
            />
        </div>
    );
}
