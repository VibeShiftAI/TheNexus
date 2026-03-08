"use client"

import { useState, useEffect, useCallback, useRef } from "react";
import { Task, TaskStatus, Feedback, deleteTask, addPlanFeedback, addWalkthroughFeedback, addResearchFeedback, updateTaskDetails, researchTasks, getWorkflowTemplates, runTaskWithLangGraph, getTaskLangGraphStatus, WorkflowTemplate, updateTask, approveResearch, rejectResearch, approveWalkthrough, rejectWalkthrough, cancelWalkthrough, cancelWorkflowRun } from "@/lib/nexus";
import { getTabForTaskStatus } from "@/lib/taskTabMapping";
import { X, Lightbulb, FileText, BookOpen, Check, XCircle, Loader2, Trash2, GitCommit, Rocket, Search, MessageSquare, Send, Undo2, RefreshCw, Pencil, Zap, ChevronDown, Archive, RotateCw } from "lucide-react";
import { AnnotatedMarkdown } from './annotated-markdown';
import { StageTimeline } from './stage-timeline';
import { FeedbackHistory } from './feedback-history';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { normalizeMarkdown } from '@/lib/normalizeMarkdown';

import { UnifiedWorkflowView } from './task-modal/unified-workflow-view';

interface TaskDetailModalProps {
    projectId: string;
    task: Task | null;
    onClose: () => void;
    onTaskChange: () => void;
    initialTab?: Tab;
}

type Tab = 'overview' | 'spec' | 'research' | 'plan' | 'walkthrough' | 'workflow';

const statusActions: Record<TaskStatus, { action: string; nextStatus: string }[]> = {
    idea: [], // Legacy 'Research & Plan' removed
    researching: [],
    researched: [
        { action: 'Approve & Plan', nextStatus: 'planning' },
        { action: 'Reject Research', nextStatus: 'idea' }
    ],
    planning: [],
    planned: [], // 'Approve & Implement' removed - now handled by Live Workflow overlay
    awaiting_approval: [], // 'Approve & Implement' removed - now handled by Live Workflow overlay
    implementing: [],
    testing: [
        { action: 'Approve & Commit', nextStatus: 'complete' },
        { action: 'Revise & Advise', nextStatus: 'implementing' },
        { action: 'Cancel & Undo', nextStatus: 'cancelled' }
    ],
    complete: [],
    rejected: [],
    cancelled: []
};



// Simplified StatusBadge component for internal use
function StatusBadge({ status }: { status: TaskStatus }) {
    const statusConfig: Record<TaskStatus, { label: string; color: string; bgColor: string }> = {
        idea: { label: 'Idea', color: 'text-yellow-400', bgColor: 'bg-yellow-400/10' },
        researching: { label: 'Researching', color: 'text-cyan-400', bgColor: 'bg-cyan-400/10' },
        researched: { label: 'Researched', color: 'text-cyan-400', bgColor: 'bg-cyan-400/10' },
        planning: { label: 'Planning', color: 'text-purple-400', bgColor: 'bg-purple-400/10' },
        planned: { label: 'Planned', color: 'text-purple-400', bgColor: 'bg-purple-400/10' },
        awaiting_approval: { label: 'Awaiting Approval', color: 'text-amber-400', bgColor: 'bg-amber-400/10' },
        implementing: { label: 'Implementing', color: 'text-emerald-400', bgColor: 'bg-emerald-400/10' },
        testing: { label: 'Testing', color: 'text-emerald-400', bgColor: 'bg-emerald-400/10' },
        complete: { label: 'Complete', color: 'text-slate-400', bgColor: 'bg-slate-400/10' },
        rejected: { label: 'Rejected', color: 'text-red-400', bgColor: 'bg-red-400/10' },
        cancelled: { label: 'Cancelled', color: 'text-slate-500', bgColor: 'bg-slate-500/10' }
    };
    const config = statusConfig[status] || statusConfig.idea;

    return (
        <span className={`px-2 py-0.5 rounded text-xs font-medium border border-transparent ${config.color} ${config.bgColor}`}>
            {config.label}
        </span>
    );
}

export function TaskDetailModal({ projectId, task, onClose, onTaskChange, initialTab }: TaskDetailModalProps) {
    // Track the task ID to detect when we're viewing a different task
    const previousTaskId = useRef<string | null>(null);

    // Helper to clean potential JSON content from LLMs
    const cleanContent = (content: string): string => {
        if (!content) return '';
        try {
            const trimmed = content.trim();
            // Only attempt parse if it looks like a JSON array or object
            if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
                let parsed;
                try {
                    parsed = JSON.parse(trimmed);
                } catch {
                    // Try Python repr format (single quotes → double quotes)
                    try {
                        const fixed = trimmed.replace(/'/g, '"');
                        parsed = JSON.parse(fixed);
                    } catch {
                        return content;
                    }
                }

                // Handle array of content blocks
                if (Array.isArray(parsed)) {
                    return parsed
                        .map((item: any) => item.text || item.content || (typeof item === 'string' ? item : ''))
                        .join('\n');
                }

                // Handle single object
                if (typeof parsed === 'object' && parsed !== null) {
                    return parsed.text || parsed.content || content;
                }

                // Handle quoted string
                if (typeof parsed === 'string') return parsed;
            }
            return content;
        } catch (e) {
            return content;
        }
    };

    // Initialize to the tab based on initialTab prop or task status
    const [activeTab, setActiveTab] = useState<Tab>(() => {
        if (initialTab) return initialTab;
        if (task) {
            return getTabForTaskStatus(task.status);
        }
        return 'overview';
    });

    // When the task changes (different task opened), update the tab based on new task's status
    // When the task changes (different task opened), reset ALL local state
    useEffect(() => {
        if (task && task.id !== previousTaskId.current) {
            // New task opened - set tab based on its status
            setActiveTab(getTabForTaskStatus(task.status));
            previousTaskId.current = task.id;

            // RESET ALL LOCAL STATE to prevent "zombie" state from previous task
            setError(null);
            setShowDeleteConfirm(false);
            setShowCompleteConfirm(false);
            setShowCancelConfirm(false);
            setCancelWarning(null);
            setFeedbackText('');
            setIsSendingFeedback(false);
            setImplementationProgress(null);
            setExecutionLog([]);
            setIsEditing(false);
            setEditError(null);

            // LangGraph state reset
            // Check for nested langGraph object first, then fallback to direct DB field names
            const runId = task.langGraph?.runId || (task as any).langgraph_run_id;
            const lgStatus = task.langGraph?.status || (task as any).langgraph_status;

            if (runId) {
                console.log("[TaskModal] Restoring runId from task:", runId);
                setLangGraphRunId(runId);
                setIsRunningLangGraph(true);
                if (lgStatus) setLangGraphStatus(lgStatus);
            } else {
                setIsRunningLangGraph(false);
                setLangGraphRunId(null);
                setLangGraphStatus(null);
                setLangGraphNode(null);
            }

            // Clear any active intervals immediately
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            if (langGraphPollRef.current) clearInterval(langGraphPollRef.current);
            pollIntervalRef.current = null;
            langGraphPollRef.current = null;
        }
    }, [task]);



    const [isLoading, setIsLoading] = useState(false);

    const [error, setError] = useState<string | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const [cancelWarning, setCancelWarning] = useState<string | null>(null);
    const [feedbackText, setFeedbackText] = useState('');
    const [isSendingFeedback, setIsSendingFeedback] = useState(false);
    const [implementationProgress, setImplementationProgress] = useState<string | null>(null);
    const [executionLog, setExecutionLog] = useState<Array<{ phase: string; message: string; timestamp: string }>>([]);
    const logContainerRef = useRef<HTMLDivElement>(null);
    const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

    // Edit mode state
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [isEditSaving, setIsEditSaving] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);

    // LangGraph workflow state
    const [langGraphTemplates, setLangGraphTemplates] = useState<WorkflowTemplate[]>([]);
    const [showLangGraphMenu, setShowLangGraphMenu] = useState(false);
    const [isRunningLangGraph, setIsRunningLangGraph] = useState(false);
    const [langGraphRunId, setLangGraphRunId] = useState<string | null>(null);
    const [langGraphStatus, setLangGraphStatus] = useState<string | null>(null);
    const [langGraphNode, setLangGraphNode] = useState<string | null>(null);
    const langGraphPollRef = useRef<NodeJS.Timeout | null>(null);

    // Switch to workflow tab if a run is active
    useEffect(() => {
        if (langGraphRunId) {
            setActiveTab('workflow');
        }
    }, [langGraphRunId]);

    // Sync LangGraph state when task's langgraph_run_id changes (e.g., after restart clears it)
    const currentTaskRunId = task?.langGraph?.runId || (task as any)?.langgraph_run_id;
    useEffect(() => {
        // If task has no run ID but local state thinks we're running, clear it
        if (!currentTaskRunId && isRunningLangGraph) {
            console.log('[TaskModal] Task langgraph_run_id is null but local state thinks running. Clearing...');
            setIsRunningLangGraph(false);
            setLangGraphRunId(null);
            setLangGraphStatus(null);
            setLangGraphNode(null);
        }
    }, [currentTaskRunId, isRunningLangGraph]);

    // Check if editing is allowed (only for idea or planning status)
    const canEdit = task?.status === 'idea' || task?.status === 'planning';

    // Check if LangGraph can be used (for idea, researched, or planned tasks, OR if already running)
    const canUseLangGraph = task?.status === 'idea' || task?.status === 'researched' || task?.status === 'planned' ||
        task?.status === 'researching' || task?.status === 'planning' || task?.status === 'implementing' || task?.status === 'testing';

    // Load LangGraph available workflows (templates)
    useEffect(() => {
        const loadTemplates = async () => {
            try {
                // Single source of truth - Python backend with level filter
                const templates = await getWorkflowTemplates('task');
                setLangGraphTemplates(templates || []);
            } catch (err) {
                console.error('Failed to load LangGraph templates:', err);
                setError('Failed to load workflow templates');
            }
        };
        loadTemplates();
    }, []);

    // Start polling if we have a run ID (restored or new) and it's active
    useEffect(() => {
        if (langGraphRunId && !langGraphPollRef.current) {
            // Only poll if not completed/failed/cancelled? 
            // Or always poll once to get latest state?
            // polling function checks for terminal states.
            pollLangGraphStatus(langGraphRunId);
        }
    }, [langGraphRunId]);

    const pollLangGraphStatus = useCallback((runId: string) => {
        if (!task) return;

        if (langGraphPollRef.current) clearInterval(langGraphPollRef.current);

        // Initial check
        getTaskLangGraphStatus(projectId, task.id, runId).then(status => {
            if (status) {
                setLangGraphStatus(status.status);
                setLangGraphNode(status.current_node || null);
            }
        });

        // Poll every 5 seconds to reduce log noise
        langGraphPollRef.current = setInterval(async () => {
            try {
                const status = await getTaskLangGraphStatus(projectId, task.id, runId);
                if (status) {
                    setLangGraphStatus(status.status);
                    setLangGraphNode(status.current_node || null);

                    if (['completed', 'failed', 'cancelled'].includes(status.status)) {
                        if (langGraphPollRef.current) clearInterval(langGraphPollRef.current);
                        langGraphPollRef.current = null;
                        // Workflow finished — refresh the task to get updated status
                        onTaskChange();
                        setIsRunningLangGraph(false);
                        // Don't auto-switch tabs — onWorkflowComplete handles post-completion
                    }
                }
            } catch (err) {
                console.error('Error polling status:', err);
            }
        }, 2000);
    }, [projectId, task]);

    if (!task) return null;



    const handleAction = async (action: string) => {
        setIsLoading(true);
        setError(null);

        const feedback = feedbackText.trim() || undefined;

        try {
            switch (action) {
                // 'Research & Plan' case removed
                case 'Approve & Plan':
                    await approveResearch(projectId, task.id, feedback);
                    setActiveTab('plan');
                    break;
                case 'Reject Research':
                    await rejectResearch(projectId, task.id, feedback);
                    setActiveTab('overview');
                    break;
                // Note: 'Approve & Implement' and 'Reject Plan' removed - now handled by Live Workflow overlay
                case 'Approve & Commit':
                    await approveWalkthrough(projectId, task.id, feedback);
                    break;
                case 'Revise & Advise':
                    await rejectWalkthrough(projectId, task.id, feedback);
                    setFeedbackText('');
                    setActiveTab('walkthrough');
                    break;
                case 'Cancel & Undo':
                    const result = await cancelWalkthrough(projectId, task.id, feedback);
                    if (result.warning) {
                        setCancelWarning(result.warning);
                    }
                    setFeedbackText('');
                    break;
            }

            // If a LangGraph workflow is paused, also resume it with the approval/rejection
            if (langGraphRunId) {
                const isApproval = action.toLowerCase().includes('approve');
                const feedbackMsg = feedback || (isApproval ? 'Looks good' : 'Please revise');
                try {
                    await fetch(`http://localhost:8000/graph/nexus/${langGraphRunId}/resume`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            approval_action: isApproval ? 'approve' : 'reject',
                            feedback: feedbackMsg
                        })
                    });
                    // Switch to workflow tab to watch progress
                    setActiveTab('workflow');
                } catch (e) {
                    console.error('[TaskModal] Failed to resume LangGraph workflow:', e);
                }
            }
            setFeedbackText('');
            onTaskChange();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Action failed');
        } finally {
            setIsLoading(false);
        }
    };

    const handleSendFeedback = async () => {
        if (!feedbackText.trim()) return;

        setIsSendingFeedback(true);
        try {
            if (activeTab === 'research' && task.researchReport) {
                await addResearchFeedback(projectId, task.id, feedbackText.trim());
            } else if (activeTab === 'plan' && task.implementationPlan) {
                await addPlanFeedback(projectId, task.id, feedbackText.trim());
            } else if (activeTab === 'walkthrough' && task.walkthrough) {
                await addWalkthroughFeedback(projectId, task.id, feedbackText.trim());
            }
            setFeedbackText('');
            onTaskChange();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to send feedback');
        } finally {
            setIsSendingFeedback(false);
        }
    };

    const handleCancelTask = async () => {
        try {
            // Stop backend workflow FIRST to prevent orphaned runs
            const runId = langGraphRunId || (task as any).langgraph_run_id;
            if (runId) {
                try {
                    await cancelWorkflowRun(runId);
                } catch (e) {
                    console.warn('Failed to cancel LangGraph run:', e);
                }
            }

            // Update both task status and langgraph_status
            await updateTask(projectId, task.id, {
                status: 'cancelled',
                langgraph_status: 'cancelled',
            });

            // Stop any active polling BEFORE triggering re-renders
            if (langGraphPollRef.current) {
                clearInterval(langGraphPollRef.current);
                langGraphPollRef.current = null;
            }
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
            }

            // Reset UI state to prevent stale confirm dialog on re-render
            setShowDeleteConfirm(false);

            // Close the modal BEFORE notifying parent to avoid re-render race
            onClose();

            // Notify parent to refresh list (modal is already closed)
            onTaskChange();
        } catch (error) {
            console.error('Failed to cancel task:', error);
            // On failure, reset the confirm dialog so user can try again
            setShowDeleteConfirm(false);
        }
    };

    const handleCompleteTask = async () => {
        try {
            await updateTask(projectId, task.id, { status: 'complete' });

            // Stop any active polling
            if (langGraphPollRef.current) {
                clearInterval(langGraphPollRef.current);
                langGraphPollRef.current = null;
            }
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
            }

            setShowCompleteConfirm(false);
            onClose();
            onTaskChange();
        } catch (error) {
            console.error('Failed to complete task:', error);
            setShowCompleteConfirm(false);
        }
    };

    const handleRestartTask = async () => {
        if (!confirm('Are you sure you want to restart this task? This will clear all research, plans, and artifacts.')) return;

        try {
            // Reset to idea status AND clear all langgraph workflow fields
            await updateTask(projectId, task.id, {
                status: 'idea',
                langgraph_run_id: null,
                langgraph_status: null,
                langgraph_template: null,
                langgraph_started_at: null,
                research_output: null,
                plan_output: null,
                walkthrough: null
            });

            // Clear local LangGraph state
            setLangGraphRunId(null);
            setLangGraphStatus(null);
            setIsRunningLangGraph(false);
            setLangGraphNode(null);

            // Notify parent to refresh list
            onTaskChange();

            // Update local view to show the reset state - stick to overview tab
            setActiveTab('overview');
        } catch (error) {
            console.error('Failed to restart task:', error);
        }
    };


    const actions = statusActions[task.status] || [];
    const isPending = !langGraphRunId && (task.status === 'researching' || task.status === 'planning' || task.status === 'implementing');

    // Show feedback for any approval/rejection stage
    const showFeedbackInput =
        (activeTab === 'research' && task.status === 'researched') ||
        (activeTab === 'plan' && (task.status === 'planned' || task.status === 'awaiting_approval')) ||
        (activeTab === 'walkthrough' && task.status === 'testing');

    // Get current feedback based on active tab
    const currentFeedback = activeTab === 'research'
        ? task.researchReport?.feedback
        : activeTab === 'plan'
            ? task.implementationPlan?.feedback
            : activeTab === 'walkthrough'
                ? task.walkthrough?.feedback
                : undefined;

    const tabs: { id: Tab; label: string; icon: React.ReactNode; disabled?: boolean }[] = [
        { id: 'overview', label: 'Overview', icon: <Lightbulb size={16} /> },
        { id: 'spec', label: 'Spec', icon: <FileText size={16} /> }, // Spec is always available for viewing/editing
        { id: 'workflow', label: 'Live Workflow', icon: <Zap size={16} />, disabled: !langGraphRunId },
        { id: 'research', label: 'Research', icon: <Search size={16} />, disabled: !task.researchReport && task.status !== 'researching' },
        { id: 'plan', label: 'Plan', icon: <Rocket size={16} />, disabled: !task.implementationPlan && task.status !== 'planning' },
        { id: 'walkthrough', label: 'Walkthrough', icon: <BookOpen size={16} />, disabled: !task.walkthrough }
    ];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />

            {/* Modal */}
            <div className="relative w-full max-w-4xl max-h-[90vh] bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl overflow-hidden flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-slate-800">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3">
                            <StatusBadge status={task.status} />
                            <h2 className="text-xl font-bold text-white truncate">{task.title}</h2>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 px-6 py-3 border-b border-slate-800 bg-slate-900/50">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => !tab.disabled && setActiveTab(tab.id)}
                            disabled={tab.disabled}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === tab.id
                                ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                                : tab.disabled
                                    ? 'text-slate-600 cursor-not-allowed'
                                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                                }`}
                        >
                            {tab.icon}
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Action Buttons based on Status */}
                <div className="flex items-center gap-3">
                    {/* Add Restart Option for Cancelled/Rejected/Complete tasks */}
                    {(task.status === 'cancelled' || task.status === 'rejected' || task.status === 'complete') && (
                        <button
                            onClick={handleRestartTask}
                            className="px-4 py-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 transition-colors flex items-center gap-2"
                        >
                            <RotateCw size={16} />
                            Restart Task
                        </button>
                    )}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6">
                    {activeTab === 'overview' && (
                        <div className="space-y-4">
                            <div>
                                <h3 className="text-sm font-medium text-slate-400 mb-2">Description</h3>
                                {task.description ? (
                                    <div className="prose prose-invert prose-sm max-w-none
                                        prose-p:text-slate-300 prose-p:leading-relaxed prose-p:my-1
                                        prose-strong:text-white
                                        prose-li:text-slate-300 prose-li:my-0.5
                                        prose-code:text-cyan-300 prose-code:bg-slate-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm
                                        prose-headings:text-slate-100 prose-headings:font-bold
                                        prose-h3:text-base prose-h3:mt-4 prose-h3:mb-1
                                        prose-hr:border-slate-700
                                    ">
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                            {normalizeMarkdown(task.description)}
                                        </ReactMarkdown>
                                    </div>
                                ) : (
                                    <p className="text-slate-500 italic">No description provided.</p>
                                )}
                            </div>
                            <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                    <span className="text-slate-400">Created:</span>
                                    <span className="text-white ml-2">
                                        {new Date(task.createdAt).toLocaleDateString()}
                                    </span>
                                </div>
                                {task.updatedAt && (
                                    <div>
                                        <span className="text-slate-400">Updated:</span>
                                        <span className="text-white ml-2">
                                            {new Date(task.updatedAt).toLocaleDateString()}
                                        </span>
                                    </div>
                                )}
                            </div>
                            {task.walkthrough?.commitHash && (
                                <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                                    <GitCommit size={16} className="text-emerald-400" />
                                    <span className="text-emerald-400 text-sm">Committed:</span>
                                    <code className="text-emerald-300 text-sm">{task.walkthrough.commitHash.substring(0, 7)}</code>
                                </div>
                            )}

                            {/* LangGraph Workflow Button */}
                            {(canUseLangGraph || langGraphRunId) && (langGraphTemplates.length > 0 || langGraphRunId) && (
                                <div className="mt-6 pt-4 border-t border-slate-800">
                                    <div className="flex items-center justify-between mb-3">
                                        <div>
                                            <h4 className="text-sm font-medium text-white flex items-center gap-2">
                                                <Zap size={14} className="text-amber-400" />
                                                Run with LangGraph
                                            </h4>
                                            <p className="text-xs text-slate-500 mt-1">Execute this task through a visual workflow</p>
                                        </div>
                                    </div>

                                    <div className="relative">
                                        <button
                                            onClick={() => setShowLangGraphMenu(!showLangGraphMenu)}
                                            disabled={isRunningLangGraph}
                                            className="w-full flex items-center justify-between px-4 py-3 rounded-lg bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-500/30 text-amber-300 hover:from-amber-500/30 hover:to-orange-500/30 transition-all disabled:opacity-50"
                                        >
                                            <span className="flex items-center gap-2">
                                                {isRunningLangGraph ? (
                                                    <Loader2 size={16} className="animate-spin" />
                                                ) : (
                                                    <Zap size={16} />
                                                )}
                                                {isRunningLangGraph ? 'Running Workflow...' : 'Select Workflow Template'}
                                            </span>
                                            <ChevronDown size={16} className={`transition-transform ${showLangGraphMenu ? 'rotate-180' : ''}`} />
                                        </button>

                                        {showLangGraphMenu && (
                                            <div className="absolute top-full left-0 right-0 mt-2 bg-slate-800 rounded-lg border border-slate-700 overflow-hidden z-10 shadow-xl">
                                                {langGraphTemplates.map(template => (
                                                    <button
                                                        key={template.id}
                                                        onClick={async () => {
                                                            setShowLangGraphMenu(false);
                                                            setIsRunningLangGraph(true);
                                                            setError(null);
                                                            try {
                                                                const result = await runTaskWithLangGraph(
                                                                    projectId,
                                                                    task.id,
                                                                    { templateId: template.id }
                                                                );
                                                                if (result.success && result.run_id) {
                                                                    setLangGraphRunId(result.run_id);
                                                                    // Start polling for status
                                                                    pollLangGraphStatus(result.run_id);
                                                                } else {
                                                                    setError(result.error || 'Failed to start workflow');
                                                                    setIsRunningLangGraph(false);
                                                                }
                                                            } catch (err) {
                                                                setError(err instanceof Error ? err.message : 'Failed to run workflow');
                                                                setIsRunningLangGraph(false);
                                                            }
                                                        }}
                                                        className="w-full px-4 py-3 text-left hover:bg-slate-700 transition-colors border-b border-slate-700 last:border-b-0"
                                                    >
                                                        <div className="font-medium text-white text-sm">{template.name}</div>
                                                        <div className="text-xs text-slate-400 mt-0.5">{template.description}</div>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Log moved to persistent footer */}
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'spec' && (
                        <div className="space-y-6">
                            <div className="prose prose-invert prose-sm max-w-none">
                                <div className="flex items-center gap-2 text-xs text-slate-500 mb-4">
                                    <FileText size={14} />
                                    <span>Task Specification</span>
                                </div>
                                {task.spec_output ? (
                                    <AnnotatedMarkdown
                                        content={normalizeMarkdown(cleanContent(task.spec_output))}
                                        stage="spec"
                                        taskId={task.id}
                                        projectId={projectId}
                                        readOnly={true}
                                    />
                                ) : (
                                    <div className="text-slate-500 italic p-8 text-center border border-slate-800 rounded-lg bg-slate-900/50">
                                        No specification document exists for this task yet.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'research' && task.researchReport && (
                        <div className="space-y-6">
                            <div className="prose prose-invert prose-sm max-w-none">
                                <div className="flex items-center gap-2 mb-4 text-xs text-slate-500">
                                    <span>Generated: {new Date(task.researchReport.generatedAt).toLocaleString()}</span>
                                    {task.researchReport.approvedAt && (
                                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400">
                                            Approved
                                        </span>
                                    )}
                                </div>
                                <AnnotatedMarkdown
                                    content={normalizeMarkdown(cleanContent(task.researchReport.content))}
                                    stage="research"
                                    taskId={task.id}
                                    projectId={projectId}
                                    readOnly={task.status !== 'researched'}
                                />
                            </div>

                            {/* Feedback History */}
                            {currentFeedback && currentFeedback.length > 0 && (
                                <FeedbackHistory feedback={currentFeedback} />
                            )}

                            {/* Execution Timeline */}
                            <StageTimeline
                                projectId={projectId}
                                taskId={task.id}
                                stage="research"
                                nextStage="plan"
                                isComplete={!!task.researchReport.approvedAt}
                            />
                        </div>
                    )}

                    {activeTab === 'plan' && task.implementationPlan && (
                        <div className="space-y-6">
                            <div className="prose prose-invert prose-sm max-w-none">
                                <div className="flex items-center gap-2 mb-4 text-xs text-slate-500">
                                    <span>Generated: {new Date(task.implementationPlan.generatedAt).toLocaleString()}</span>
                                    {task.implementationPlan.approvedAt && (
                                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400">
                                            Approved
                                        </span>
                                    )}
                                </div>
                                <AnnotatedMarkdown
                                    content={normalizeMarkdown(cleanContent(task.implementationPlan.content))}
                                    stage="plan"
                                    taskId={task.id}
                                    projectId={projectId}
                                    readOnly={task.status !== 'planned'}
                                />
                            </div>

                            {/* Feedback History */}
                            {currentFeedback && currentFeedback.length > 0 && (
                                <FeedbackHistory feedback={currentFeedback} />
                            )}

                            {/* Execution Timeline */}
                            <StageTimeline
                                projectId={projectId}
                                taskId={task.id}
                                stage="plan"
                                nextStage="implement"
                                isComplete={!!task.implementationPlan.approvedAt}
                            />
                        </div>
                    )}

                    {activeTab === 'walkthrough' && task.walkthrough && (
                        <div className="space-y-6">
                            <div className="prose prose-invert prose-sm max-w-none">
                                <div className="flex items-center gap-2 mb-4 text-xs text-slate-500">
                                    <span>Generated: {new Date(task.walkthrough.generatedAt).toLocaleString()}</span>
                                    {task.walkthrough.approvedAt && (
                                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400">
                                            Approved
                                        </span>
                                    )}
                                </div>
                                <AnnotatedMarkdown
                                    content={normalizeMarkdown(cleanContent(task.walkthrough.content))}
                                    stage="walkthrough"
                                    taskId={task.id}
                                    projectId={projectId}
                                    readOnly={task.status !== 'testing'}
                                />
                            </div>

                            {/* Feedback History */}
                            {currentFeedback && currentFeedback.length > 0 && (
                                <FeedbackHistory feedback={currentFeedback} />
                            )}

                            {/* Execution Timeline */}
                            <StageTimeline
                                projectId={projectId}
                                taskId={task.id}
                                stage="implement"
                                isComplete={!!task.walkthrough.approvedAt}
                            />
                        </div>
                    )}

                    {isPending && (
                        <div className="flex flex-col items-center justify-center py-8 text-slate-400">
                            <Loader2 size={32} className="animate-spin mb-4" />
                            <p className="text-lg font-medium text-white">
                                {task.status === 'researching' ? 'AI is researching...' :
                                    task.status === 'planning' ? 'AI is creating implementation plan...' :
                                        'AI is implementing changes...'}
                            </p>
                        </div>
                    )}

                    {activeTab === 'workflow' && langGraphRunId && (
                        <div className="h-full">
                            <UnifiedWorkflowView
                                projectId={projectId}
                                taskId={task.id}
                                runId={langGraphRunId}
                                onWorkflowComplete={async () => {
                                    // Clear LangGraph execution state
                                    setIsRunningLangGraph(false);
                                    setLangGraphStatus(null);
                                    setLangGraphNode(null);
                                    setLangGraphRunId(null);
                                    // Refresh task data so walkthrough tab becomes enabled
                                    onTaskChange();
                                    // Pivot to walkthrough tab to show the completed work
                                    setActiveTab('walkthrough');
                                }}
                            />
                        </div>
                    )}
                </div>

                {/* Feedback Input */}
                {showFeedbackInput && (
                    <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/50">
                        <div className="flex items-center gap-2 mb-2">
                            <MessageSquare size={14} className="text-slate-400" />
                            <span className="text-sm text-slate-400">Add feedback or comments before approval/rejection</span>
                        </div>
                        <div className="flex gap-2">
                            <textarea
                                value={feedbackText}
                                onChange={(e) => setFeedbackText(e.target.value)}
                                className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500/50 resize-none h-20"
                                placeholder="Your feedback..."
                            />
                        </div>
                    </div>
                )}

                {/* Footer */}
                <div className="p-6 border-t border-slate-800 flex items-center justify-between bg-slate-900/50">
                    <div className="flex items-center gap-3">
                        {showDeleteConfirm ? (
                            <div className="flex items-center gap-2 text-sm">
                                <span className="text-slate-400">Cancel this task?</span>
                                <button
                                    onClick={() => handleCancelTask()}
                                    className="font-bold text-red-400 hover:text-red-300 underline transition-colors"
                                >
                                    Yes, Cancel
                                </button>
                                <button
                                    onClick={() => setShowDeleteConfirm(false)}
                                    className="text-slate-500 hover:text-slate-300 transition-colors"
                                >
                                    No
                                </button>
                            </div>
                        ) : showCompleteConfirm ? (
                            <div className="flex items-center gap-2 text-sm">
                                <span className="text-slate-400">Mark as complete?</span>
                                <button
                                    onClick={() => handleCompleteTask()}
                                    className="font-bold text-emerald-400 hover:text-emerald-300 underline transition-colors"
                                >
                                    Yes, Complete
                                </button>
                                <button
                                    onClick={() => setShowCompleteConfirm(false)}
                                    className="text-slate-500 hover:text-slate-300 transition-colors"
                                >
                                    No
                                </button>
                            </div>
                        ) : (
                            <>
                                <button
                                    onClick={() => setShowDeleteConfirm(true)}
                                    className="text-slate-500 hover:text-red-400 text-sm transition-colors flex items-center gap-2"
                                >
                                    <Trash2 size={16} /> Cancel Task
                                </button>
                                {task.status !== 'complete' && task.status !== 'cancelled' && (
                                    <button
                                        onClick={() => setShowCompleteConfirm(true)}
                                        className="text-slate-500 hover:text-emerald-400 text-sm transition-colors flex items-center gap-2"
                                    >
                                        <Check size={16} /> Mark Complete
                                    </button>
                                )}
                            </>
                        )}
                    </div>

                    <div className="flex gap-2">
                        {showFeedbackInput && (
                            <button
                                onClick={handleSendFeedback}
                                disabled={!feedbackText.trim() || isSendingFeedback}
                                className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50 transition-colors flex items-center gap-2"
                            >
                                <Send size={16} />
                                {isSendingFeedback ? 'Sending...' : 'Send Feedback'}
                            </button>
                        )}

                        {/* Action buttons for approval/rejection - always show when task status warrants them */}
                        {actions.map((action, idx) => {
                            const isReject = action.action.toLowerCase().includes('reject') || action.action.toLowerCase().includes('cancel') || action.action.toLowerCase().includes('revise');

                            return (
                                <button
                                    key={idx}
                                    onClick={() => handleAction(action.action)}
                                    disabled={isLoading}
                                    className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${isReject
                                        ? 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700'
                                        : 'bg-gradient-to-r from-purple-600 to-blue-600 text-white hover:from-purple-500 hover:to-blue-500 border border-transparent shadow-lg shadow-purple-900/20'
                                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                                >
                                    {isLoading ? <Loader2 size={16} className="animate-spin" /> : null}
                                    {action.action}
                                </button>
                            );
                        })}


                    </div>
                </div>
            </div>
        </div>
    );
}
