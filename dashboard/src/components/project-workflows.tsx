"use client"

import { useState, useEffect, useCallback } from "react";
import {
    ProjectWorkflow,
    ProjectWorkflowStatus,
    ProjectWorkflowType,
    WorkflowTemplate,
    WorkflowStage,
    getProjectWorkflows,
    createProjectWorkflow,
    updateProjectWorkflow,
    deleteProjectWorkflow,
    runProjectWorkflow,
    getWorkflowProgress,
    advanceWorkflow,
    checkWorkflowStage,
    getWorkflowTemplates
} from "@/lib/nexus";
import {
    Workflow,
    Plus,
    Loader2,
    ChevronRight,
    Play,
    Pause,
    CheckCircle2,
    XCircle,
    Lightbulb,
    Palette,
    FileText,
    Rocket,
    MoreVertical,
    Trash2,
    Eye,
    Clock,
    Sparkles
} from "lucide-react";

interface ProjectWorkflowsProps {
    projectId: string;
    onWorkflowSelect?: (workflow: ProjectWorkflow) => void;
}

const statusConfig: Record<ProjectWorkflowStatus, { icon: React.ReactNode; color: string; label: string; bgColor: string }> = {
    idea: {
        icon: <Lightbulb size={14} />,
        color: 'text-purple-400',
        bgColor: 'bg-purple-500/10 border-purple-500/30',
        label: 'Idea'
    },
    planning: {
        icon: <Loader2 size={14} className="animate-spin" />,
        color: 'text-violet-400',
        bgColor: 'bg-violet-500/10 border-violet-500/30',
        label: 'Planning'
    },
    in_progress: {
        icon: <Loader2 size={14} className="animate-spin" />,
        color: 'text-blue-400',
        bgColor: 'bg-blue-500/10 border-blue-500/30',
        label: 'In Progress'
    },
    review: {
        icon: <Eye size={14} />,
        color: 'text-amber-400',
        bgColor: 'bg-amber-500/10 border-amber-500/30',
        label: 'In Review'
    },
    complete: {
        icon: <CheckCircle2 size={14} />,
        color: 'text-emerald-400',
        bgColor: 'bg-emerald-500/10 border-emerald-500/30',
        label: 'Complete'
    },
    cancelled: {
        icon: <XCircle size={14} />,
        color: 'text-slate-400',
        bgColor: 'bg-slate-500/10 border-slate-500/30',
        label: 'Cancelled'
    }
};

const workflowTypeIcons: Record<ProjectWorkflowType, React.ReactNode> = {
    'brand-development': <Palette size={16} className="text-pink-400" />,
    'logo-development': <Sparkles size={16} className="text-amber-400" />,
    'documentation': <FileText size={16} className="text-cyan-400" />,
    'release': <Rocket size={16} className="text-emerald-400" />,
    'custom': <Workflow size={16} className="text-purple-400" />
};

export function ProjectWorkflows({ projectId, onWorkflowSelect }: ProjectWorkflowsProps) {
    const [workflows, setWorkflows] = useState<ProjectWorkflow[]>([]);
    const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Create workflow state
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplate | null>(null);
    const [newWorkflowName, setNewWorkflowName] = useState('');
    const [newWorkflowDescription, setNewWorkflowDescription] = useState('');
    const [isCreating, setIsCreating] = useState(false);

    // Actions menu state
    const [showActionsMenu, setShowActionsMenu] = useState<string | null>(null);
    const [isDeleting, setIsDeleting] = useState<string | null>(null);
    const [isRunning, setIsRunning] = useState<string | null>(null);
    const [isAdvancing, setIsAdvancing] = useState<string | null>(null);

    const fetchWorkflows = useCallback(async () => {
        try {
            const { workflows } = await getProjectWorkflows(projectId);
            setWorkflows(workflows);
        } catch (err) {
            console.error('Failed to fetch workflows:', err);
            setError(err instanceof Error ? err.message : 'Failed to load workflows');
        }
    }, [projectId]);

    const fetchTemplates = useCallback(async () => {
        try {
            // Single source of truth - Python backend with level filter
            const templates = await getWorkflowTemplates('project');
            setTemplates(templates);
        } catch (err) {
            console.error('Failed to fetch templates:', err);
        }
    }, []);

    useEffect(() => {
        const loadData = async () => {
            setIsLoading(true);
            await Promise.all([fetchWorkflows(), fetchTemplates()]);
            setIsLoading(false);
        };
        loadData();
    }, [fetchWorkflows, fetchTemplates]);

    const handleCreateWorkflow = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newWorkflowName.trim() || !selectedTemplate) return;

        setIsCreating(true);
        try {
            await createProjectWorkflow(projectId, {
                name: newWorkflowName.trim(),
                description: newWorkflowDescription.trim() || undefined,
                workflow_type: selectedTemplate.workflow_type as ProjectWorkflowType,
                template_id: selectedTemplate.id
            });

            setShowCreateModal(false);
            setNewWorkflowName('');
            setNewWorkflowDescription('');
            setSelectedTemplate(null);
            await fetchWorkflows();
        } catch (err) {
            console.error('Failed to create workflow:', err);
            setError(err instanceof Error ? err.message : 'Failed to create workflow');
        } finally {
            setIsCreating(false);
        }
    };

    const handleDeleteWorkflow = async (workflowId: string) => {
        setIsDeleting(workflowId);
        try {
            await deleteProjectWorkflow(projectId, workflowId);
            await fetchWorkflows();
        } catch (err) {
            console.error('Failed to delete workflow:', err);
            setError(err instanceof Error ? err.message : 'Failed to delete workflow');
        } finally {
            setIsDeleting(null);
            setShowActionsMenu(null);
        }
    };

    const handleRunWorkflow = async (workflowId: string, context?: string) => {
        setIsRunning(workflowId);
        try {
            const result = await runProjectWorkflow(projectId, workflowId, context);
            if (result.tasksCreated > 0) {
                console.log(`Workflow started: ${result.tasksCreated} tasks created`);
            }
            await fetchWorkflows();
        } catch (err) {
            console.error('Failed to run workflow:', err);
            setError(err instanceof Error ? err.message : 'Failed to run workflow');
        } finally {
            setIsRunning(null);
        }
    };

    const handleAdvanceStage = async (workflowId: string) => {
        setIsAdvancing(workflowId);
        try {
            const result = await advanceWorkflow(projectId, workflowId);
            if (result.workflowComplete) {
                console.log('Workflow completed!');
            } else if (result.tasksCreated > 0) {
                console.log(`Advanced to next stage: ${result.tasksCreated} tasks created`);
            }
            await fetchWorkflows();
        } catch (err) {
            console.error('Failed to advance workflow:', err);
            setError(err instanceof Error ? err.message : 'Failed to advance workflow');
        } finally {
            setIsAdvancing(null);
        }
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };

    const getStageProgress = (workflow: ProjectWorkflow) => {
        if (!workflow.stages || workflow.stages.length === 0) return 0;
        const currentIndex = workflow.stages.findIndex(s => s.id === workflow.current_stage);
        if (currentIndex === -1) return 0;
        return Math.round(((currentIndex + 1) / workflow.stages.length) * 100);
    };

    // Filter active workflows (not completed/cancelled)
    const activeWorkflows = workflows.filter(w => w.status !== 'complete' && w.status !== 'cancelled');
    const completedWorkflows = workflows.filter(w => w.status === 'complete' || w.status === 'cancelled');

    if (isLoading) {
        return (
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="flex items-center justify-center py-4">
                    <Loader2 size={20} className="animate-spin text-slate-400" />
                </div>
            </div>
        );
    }

    return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                    <Workflow size={16} className="text-cyan-400" />
                    Project Workflows
                </h2>
                <button
                    onClick={() => setShowCreateModal(true)}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-gradient-to-r from-cyan-500/20 to-blue-500/20 text-cyan-400 border border-cyan-500/30 hover:border-cyan-500/50 transition-all"
                >
                    <Plus size={14} />
                    <span>New Workflow</span>
                </button>
            </div>

            {/* Error Display */}
            {error && (
                <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                    <p className="text-sm text-red-400">{error}</p>
                    <button
                        onClick={() => setError(null)}
                        className="text-xs text-red-400/70 hover:text-red-400 mt-1"
                    >
                        Dismiss
                    </button>
                </div>
            )}

            {/* Workflows List */}
            {workflows.length === 0 ? (
                <div className="text-center py-6 text-slate-500">
                    <Workflow size={24} className="mx-auto mb-2 opacity-50" />
                    <p className="text-sm font-medium">No project workflows yet</p>
                    <p className="text-xs mt-0.5">Start a branding, documentation, or release workflow</p>
                </div>
            ) : (
                <div className="space-y-4">
                    {/* Active Workflows */}
                    {activeWorkflows.length > 0 && (
                        <div className="space-y-2">
                            {activeWorkflows.map(workflow => {
                                const config = statusConfig[workflow.status];
                                const progress = getStageProgress(workflow);

                                return (
                                    <div
                                        key={workflow.id}
                                        onClick={() => onWorkflowSelect?.(workflow)}
                                        className={`p-4 rounded-lg border cursor-pointer transition-all hover:border-slate-600 ${config.bgColor}`}
                                    >
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3 flex-1 min-w-0">
                                                {workflowTypeIcons[workflow.workflow_type]}
                                                <div className="flex-1 min-w-0">
                                                    <h3 className="text-white font-medium truncate">{workflow.name}</h3>
                                                    {workflow.description && (
                                                        <p className="text-slate-400 text-sm mt-0.5 line-clamp-1">{workflow.description}</p>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3 ml-4">
                                                {/* Status Badge */}
                                                <div className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-lg ${config.bgColor} ${config.color}`}>
                                                    {config.icon}
                                                    <span>{config.label}</span>
                                                </div>

                                                {/* Run Button - for idle workflows */}
                                                {(workflow.status === 'idea' || workflow.status === 'planning') && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            const config = workflow.configuration as Record<string, unknown> | undefined;
                                                            handleRunWorkflow(workflow.id, (config?.goal as string) || workflow.description);
                                                        }}
                                                        disabled={isRunning === workflow.id}
                                                        className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
                                                    >
                                                        {isRunning === workflow.id ? (
                                                            <Loader2 size={12} className="animate-spin" />
                                                        ) : (
                                                            <Play size={12} />
                                                        )}
                                                        <span>Start</span>
                                                    </button>
                                                )}

                                                {/* Advance Button - for in_progress workflows */}
                                                {workflow.status === 'in_progress' && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleAdvanceStage(workflow.id);
                                                        }}
                                                        disabled={isAdvancing === workflow.id}
                                                        className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 transition-colors disabled:opacity-50"
                                                    >
                                                        {isAdvancing === workflow.id ? (
                                                            <Loader2 size={12} className="animate-spin" />
                                                        ) : (
                                                            <ChevronRight size={12} />
                                                        )}
                                                        <span>Advance</span>
                                                    </button>
                                                )}

                                                {/* Actions Menu */}
                                                <div className="relative">
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setShowActionsMenu(showActionsMenu === workflow.id ? null : workflow.id);
                                                        }}
                                                        className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                                                    >
                                                        <MoreVertical size={14} />
                                                    </button>
                                                    {showActionsMenu === workflow.id && (
                                                        <div className="absolute right-0 mt-1 w-32 rounded-lg bg-slate-800 border border-slate-700 shadow-xl z-10">
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleDeleteWorkflow(workflow.id);
                                                                }}
                                                                disabled={isDeleting === workflow.id}
                                                                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-red-400 hover:bg-slate-700 rounded-lg transition-colors"
                                                            >
                                                                {isDeleting === workflow.id ? (
                                                                    <Loader2 size={12} className="animate-spin" />
                                                                ) : (
                                                                    <Trash2 size={12} />
                                                                )}
                                                                <span>Delete</span>
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>

                                                <ChevronRight size={16} className="text-slate-500" />
                                            </div>
                                        </div>

                                        {/* Progress Bar */}
                                        {workflow.stages && workflow.stages.length > 0 && (
                                            <div className="mt-3">
                                                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                                                    <span>
                                                        Stage: {workflow.stages.find(s => s.id === workflow.current_stage)?.name || 'Not started'}
                                                    </span>
                                                    <span>{progress}%</span>
                                                </div>
                                                <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                                                    <div
                                                        className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-300"
                                                        style={{ width: `${progress}%` }}
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        <div className="flex items-center gap-2 mt-2 text-xs text-slate-500">
                                            <Clock size={12} />
                                            <span>Created {formatDate(workflow.created_at)}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* Completed Workflows Summary */}
                    {completedWorkflows.length > 0 && (
                        <div className="pt-4 border-t border-slate-800">
                            <p className="text-xs text-slate-500">
                                {completedWorkflows.length} completed workflow{completedWorkflows.length !== 1 ? 's' : ''}
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* Create Workflow Modal */}
            {showCreateModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-lg mx-4 shadow-2xl">
                        <h3 className="text-xl font-semibold text-white mb-4">Start New Workflow</h3>

                        {/* Template Selection */}
                        {!selectedTemplate ? (
                            <div className="space-y-3">
                                <p className="text-sm text-slate-400 mb-4">Choose a workflow template:</p>
                                <div className="grid gap-3">
                                    {templates.map(template => (
                                        <button
                                            key={template.id}
                                            onClick={() => {
                                                setSelectedTemplate(template);
                                                setNewWorkflowName(template.name);
                                            }}
                                            className="flex items-start gap-3 p-4 rounded-lg border border-slate-700 hover:border-cyan-500/50 bg-slate-800/50 hover:bg-slate-800 transition-all text-left"
                                        >
                                            {workflowTypeIcons[template.workflow_type as ProjectWorkflowType] || <Workflow size={16} className="text-slate-400" />}
                                            <div className="flex-1">
                                                <h4 className="text-white font-medium">{template.name}</h4>
                                                <p className="text-slate-400 text-sm mt-0.5">{template.description}</p>
                                                <div className="flex items-center gap-2 mt-2">
                                                    <span className="text-xs text-slate-500">
                                                        {template.stages?.length || 0} stages
                                                    </span>
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                                <div className="flex justify-end gap-3 mt-6">
                                    <button
                                        onClick={() => setShowCreateModal(false)}
                                        className="px-4 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <form onSubmit={handleCreateWorkflow} className="space-y-4">
                                <div className="flex items-center gap-2 p-3 rounded-lg bg-slate-800 border border-slate-700">
                                    {workflowTypeIcons[selectedTemplate.workflow_type as ProjectWorkflowType]}
                                    <span className="text-white">{selectedTemplate.name} Template</span>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedTemplate(null)}
                                        className="ml-auto text-xs text-slate-400 hover:text-white"
                                    >
                                        Change
                                    </button>
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-slate-300 mb-1">
                                        Workflow Name <span className="text-red-400">*</span>
                                    </label>
                                    <input
                                        type="text"
                                        value={newWorkflowName}
                                        onChange={(e) => setNewWorkflowName(e.target.value)}
                                        className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                                        placeholder="e.g., Brand Development for v2.0"
                                        disabled={isCreating}
                                        autoFocus
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-slate-300 mb-1">Description</label>
                                    <textarea
                                        value={newWorkflowDescription}
                                        onChange={(e) => setNewWorkflowDescription(e.target.value)}
                                        rows={3}
                                        className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
                                        placeholder="Describe the goals of this workflow..."
                                        disabled={isCreating}
                                    />
                                </div>

                                {/* Stages Preview */}
                                {selectedTemplate.stages && selectedTemplate.stages.length > 0 && (
                                    <div>
                                        <label className="block text-sm font-medium text-slate-300 mb-2">Workflow Stages</label>
                                        <div className="flex items-center gap-1 text-xs">
                                            {selectedTemplate.stages.map((stage, i) => (
                                                <div key={stage.id} className="flex items-center gap-1">
                                                    <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">
                                                        {stage.name}
                                                    </span>
                                                    {i < selectedTemplate.stages.length - 1 && (
                                                        <ChevronRight size={12} className="text-slate-600" />
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <div className="flex justify-end gap-3 mt-6">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowCreateModal(false);
                                            setSelectedTemplate(null);
                                            setNewWorkflowName('');
                                            setNewWorkflowDescription('');
                                        }}
                                        disabled={isCreating}
                                        className="px-4 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors disabled:opacity-50"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={isCreating || !newWorkflowName.trim()}
                                        className="px-4 py-2 rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 transition-colors disabled:opacity-50 flex items-center gap-2"
                                    >
                                        {isCreating ? (
                                            <>
                                                <Loader2 size={14} className="animate-spin" />
                                                Creating...
                                            </>
                                        ) : (
                                            'Create Workflow'
                                        )}
                                    </button>
                                </div>
                            </form>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
