import { useState, useEffect } from "react";
import { Task, TaskStatus, addTask, deleteTask, researchTasks, getResearchStatus, updateTask, updateTaskDetails, getWorkflowTemplates, WorkflowTemplate, runTaskWithLangGraph } from "@/lib/nexus";
import { Lightbulb, Plus, Search, Rocket, CheckCircle2, Clock, Loader2, ChevronRight, Sparkles, XCircle, Undo2, Pencil, Bug, HelpCircle, AlertTriangle, Fingerprint, Pause, Play, Workflow } from "lucide-react";

interface TaskManagerProps {
    projectId: string;
    tasks: Task[];
    onTasksChange: () => void;
    onTaskSelect: (task: Task) => void;
}

const statusConfig: Record<TaskStatus, { label: string; icon: React.ReactNode; color: string; bgColor: string; borderColor: string }> = {
    idea: { label: 'Ideas', icon: <Lightbulb size={18} />, color: 'text-blue-600', bgColor: 'bg-blue-600/10', borderColor: 'border-blue-600/20' },
    researching: { label: 'Researching', icon: <Search size={18} />, color: 'text-cyan-400', bgColor: 'bg-cyan-400/10', borderColor: 'border-cyan-400/20' },
    researched: { label: 'Researched', icon: <Sparkles size={18} />, color: 'text-cyan-400', bgColor: 'bg-cyan-400/10', borderColor: 'border-cyan-400/20' },
    planning: { label: 'Planning', icon: <Rocket size={18} />, color: 'text-purple-400', bgColor: 'bg-purple-400/10', borderColor: 'border-purple-400/20' },
    planned: { label: 'Planned', icon: <Clock size={18} />, color: 'text-purple-400', bgColor: 'bg-purple-400/10', borderColor: 'border-purple-400/20' },
    awaiting_approval: { label: 'Awaiting Approval', icon: <Pause size={18} />, color: 'text-amber-400', bgColor: 'bg-amber-400/10', borderColor: 'border-amber-400/20' },
    implementing: { label: 'In Progress', icon: <Loader2 size={18} className="animate-spin" />, color: 'text-emerald-400', bgColor: 'bg-emerald-400/10', borderColor: 'border-emerald-400/20' },
    testing: { label: 'Testing', icon: <CheckCircle2 size={18} />, color: 'text-emerald-400', bgColor: 'bg-emerald-400/10', borderColor: 'border-emerald-400/20' },
    complete: { label: 'Complete', icon: <CheckCircle2 size={18} />, color: 'text-slate-400', bgColor: 'bg-slate-400/5', borderColor: 'border-slate-800' },
    rejected: { label: 'Rejected', icon: <XCircle size={18} />, color: 'text-red-400', bgColor: 'bg-red-400/10', borderColor: 'border-red-400/20' },
    cancelled: { label: 'Cancelled', icon: <Undo2 size={18} />, color: 'text-slate-500', bgColor: 'bg-slate-500/10', borderColor: 'border-slate-800' }
};

export function TaskManager({ projectId, tasks, onTasksChange, onTaskSelect }: TaskManagerProps) {
    const [showForm, setShowForm] = useState(false);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [researchingId, setResearchingId] = useState<string | null>(null);
    const [isAutoResearching, setIsAutoResearching] = useState(false);
    const [researchError, setResearchError] = useState<string | null>(null);
    const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
    const [startingWorkflow, setStartingWorkflow] = useState<string | null>(null);

    // Edit state
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [editTitle, setEditTitle] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [isEditSaving, setIsEditSaving] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);

    // Fetch task-level workflow templates
    useEffect(() => {
        getWorkflowTemplates('task').then(setTemplates).catch(() => {});
    }, []);

    // Check research status on mount
    useEffect(() => {
        let pollInterval: NodeJS.Timeout | null = null;

        const checkStatus = async () => {
            try {
                const status = await getResearchStatus(projectId);
                if (status.status === 'researching') {
                    setIsAutoResearching(true);
                    setResearchError(null);
                    return true;
                } else if (status.status === 'error') {
                    setIsAutoResearching(false);
                    setResearchError(status.error);
                } else {
                    setIsAutoResearching(false);
                }
                return false;
            } catch (err) {
                return false;
            }
        };

        checkStatus().then(isResearching => {
            if (isResearching) {
                pollInterval = setInterval(async () => {
                    const stillResearching = await checkStatus();
                    if (!stillResearching) {
                        if (pollInterval) clearInterval(pollInterval);
                        onTasksChange();
                    }
                }, 10000); // Poll every 10 seconds to reduce log noise
            }
        });

        return () => {
            if (pollInterval) clearInterval(pollInterval);
        };
    }, [projectId, onTasksChange]);



    const handleAutoResearch = async () => {
        setIsAutoResearching(true);
        setResearchError(null);

        try {
            await researchTasks(projectId);

            const pollInterval = setInterval(async () => {
                try {
                    const status = await getResearchStatus(projectId);
                    if (status.status !== 'researching') {
                        clearInterval(pollInterval);
                        setIsAutoResearching(false);
                        if (status.status === 'error') {
                            setResearchError(status.error);
                        } else {
                            onTasksChange();
                        }
                    }
                } catch (err) {
                    clearInterval(pollInterval);
                    setIsAutoResearching(false);
                }
            }, 10000); // Poll every 10 seconds to reduce log noise

            setTimeout(() => {
                clearInterval(pollInterval);
                setIsAutoResearching(false);
            }, 300000);

        } catch (err) {
            setIsAutoResearching(false);
            setResearchError(err instanceof Error ? err.message : 'Failed to start research');
        }
    };

    const handleAddTask = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || isSubmitting) return;

        setIsSubmitting(true);
        try {
            await addTask(projectId, title.trim(), description.trim() || undefined, selectedTemplateId || undefined);
            setTitle('');
            setDescription('');
            setSelectedTemplateId('');
            setShowForm(false);
            onTasksChange();
        } catch (error) {
            console.error('Failed to add task:', error);
        } finally {
            setIsSubmitting(false);
        }
    };





    // Edit handlers
    const handleEditClick = (e: React.MouseEvent, task: Task) => {
        e.stopPropagation();
        setEditingTask(task);
        setEditTitle(task.title);
        setEditDescription(task.description || '');
        setEditError(null);
    };

    const handleEditSave = async () => {
        if (!editingTask || !editTitle.trim()) {
            setEditError('Title is required');
            return;
        }
        setIsEditSaving(true);
        setEditError(null);
        try {
            await updateTaskDetails(projectId, editingTask.id, {
                title: editTitle.trim(),
                description: editDescription.trim()
            });
            setEditingTask(null);
            onTasksChange();
        } catch (err) {
            setEditError(err instanceof Error ? err.message : 'Failed to save');
        } finally {
            setIsEditSaving(false);
        }
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };

    // Filter out completed/archived tasks - they appear in the TaskArchive component instead
    const activeTasks = tasks.filter(task =>
        task.status !== 'complete' &&
        task.status !== 'rejected' &&
        task.status !== 'cancelled'
    );

    // Group active tasks by status
    const groupedTasks = activeTasks.reduce((acc, task) => {
        if (!acc[task.status]) acc[task.status] = [];
        acc[task.status].push(task);
        return acc;
    }, {} as Record<TaskStatus, Task[]>);

    const statusOrder: TaskStatus[] = ['idea', 'researching', 'researched', 'planning', 'planned', 'awaiting_approval', 'implementing', 'testing'];


    return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <Rocket size={22} className="text-purple-400" />
                    Task Manager
                </h2>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleAutoResearch}
                        disabled={isAutoResearching}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-all ${isAutoResearching
                            ? 'bg-blue-500/20 text-blue-400 border-blue-500/30 cursor-not-allowed'
                            : 'bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-purple-400 border-purple-500/30 hover:border-purple-500/50'
                            }`}
                        title="Use AI to research and suggest new tasks for this project"
                    >
                        {isAutoResearching ? (
                            <>
                                <Loader2 size={16} className="animate-spin" />
                                <span>Researching...</span>
                            </>
                        ) : (
                            <>
                                <Sparkles size={16} />
                                <span>Auto Research</span>
                            </>
                        )}
                    </button>
                    <button
                        onClick={() => setShowForm(!showForm)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-gradient-to-r from-purple-500/20 to-cyan-500/20 text-purple-400 border border-purple-500/30 hover:border-purple-500/50 transition-all"
                    >
                        <Plus size={16} />
                        <span>New Task</span>
                    </button>
                </div>
            </div>

            {/* Research Error */}
            {researchError && (
                <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                    <p className="text-sm text-red-400">Research failed: {researchError}</p>
                </div>
            )}



            {/* Add Task Form */}
            {showForm && (
                <form onSubmit={handleAddTask} className="mb-6 p-4 rounded-lg bg-slate-800/50 border border-slate-700">
                    <input
                        type="text"
                        placeholder="Task title..."
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50 mb-2"
                        autoFocus
                    />
                    <textarea
                        placeholder="Description (optional)..."
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50 resize-none h-20 mb-2"
                    />
                    {templates.length > 0 && (
                        <div className="mb-3">
                            <label className="block text-xs text-slate-400 mb-1 flex items-center gap-1">
                                <Workflow size={12} />
                                Attach Workflow
                            </label>
                            <select
                                value={selectedTemplateId}
                                onChange={(e) => setSelectedTemplateId(e.target.value)}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500/50"
                            >
                                <option value="">None</option>
                                {templates.map(t => (
                                    <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                            </select>
                        </div>
                    )}
                    <div className="flex gap-2">
                        <button
                            type="submit"
                            disabled={!title.trim() || isSubmitting}
                            className="flex-1 px-3 py-2 text-sm rounded-lg bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                        >
                            {isSubmitting ? 'Adding...' : 'Add Task'}
                        </button>
                        <button
                            type="button"
                            onClick={() => { setShowForm(false); setTitle(''); setDescription(''); setSelectedTemplateId(''); }}
                            className="px-4 py-2 text-sm rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            )}

            {/* Tasks List */}
            {activeTasks.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                    <Sparkles size={32} className="mx-auto mb-3 opacity-50" />
                    {tasks.length === 0 ? (
                        <>
                            <p className="text-lg font-medium">No tasks yet</p>
                            <p className="text-sm mt-1">Add your first task idea to get started</p>
                        </>
                    ) : (
                        <>
                            <p className="text-lg font-medium">All tasks completed!</p>
                            <p className="text-sm mt-1">Check the Task Archive to view completed tasks</p>
                        </>
                    )}
                </div>

            ) : (
                <div className="space-y-6">
                    {/* Render all status groups dynamically - no whitelist needed */}
                    {Object.entries(groupedTasks).map(([status, statusTasks]) => {
                        if (!statusTasks || statusTasks.length === 0) return null;

                        // Get config, fallback to a default for unknown statuses
                        const config = statusConfig[status as TaskStatus] || {
                            label: status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                            icon: <Clock size={18} />,
                            color: 'text-slate-400',
                            bgColor: 'bg-slate-400/10',
                            borderColor: 'border-slate-800'
                        };

                        return (
                            <div key={status}>
                                <div className={`flex items-center gap-2 mb-2 ${config.color}`}>
                                    {config.icon}
                                    <span className="text-sm font-medium">{config.label}</span>
                                    <span className="text-xs bg-slate-800 px-1.5 py-0.5 rounded">{statusTasks.length}</span>
                                </div>
                                <div className="space-y-2">
                                    {statusTasks.map(task => (
                                        <div
                                            key={task.id}
                                            onClick={() => onTaskSelect(task)}
                                            className={`p-4 rounded-lg border cursor-pointer transition-all hover:border-slate-500 ${config.bgColor} ${config.borderColor}`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <h3 className="text-white font-medium truncate">{task.title}</h3>
                                                        {task.initiativeValidation && (
                                                            <div className="flex gap-1">
                                                                {task.initiativeValidation.classification === 'BUG' && (
                                                                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400 border border-red-500/20" title="Classified as potential bug">
                                                                        <Bug size={10} /> Bug
                                                                    </span>
                                                                )}
                                                                {task.initiativeValidation.classification === 'QUESTION' && (
                                                                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20" title="Classified as question">
                                                                        <HelpCircle size={10} /> Question
                                                                    </span>
                                                                )}
                                                                {task.initiativeValidation.classification === 'TASK' && (
                                                                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-violet-500/10 text-violet-400 border border-violet-500/20" title="Classified as standard task">
                                                                        <Fingerprint size={10} /> Task
                                                                    </span>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>

                                                    {task.initiativeValidation?.requiresClarification && (
                                                        <div className="flex gap-2 mb-2 p-2 rounded bg-amber-500/5 border border-amber-500/20">
                                                            <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                                                            <div className="text-xs text-amber-200/80">
                                                                <span className="font-semibold text-amber-400 block mb-0.5">Clarification Needed</span>
                                                                {task.initiativeValidation.reasoning}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {task.description && (
                                                        <p className="text-slate-400 text-sm line-clamp-2">{task.description}</p>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2 ml-4">
                                                    {/* Edit button for idea/planning status */}
                                                    {(status === 'idea' || status === 'planning') && (
                                                        <button
                                                            onClick={(e) => handleEditClick(e, task)}
                                                            className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-blue-400 transition-colors"
                                                            title="Edit task"
                                                        >
                                                            <Pencil size={14} />
                                                        </button>
                                                    )}

                                                    <ChevronRight size={16} className="text-slate-500" />
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 mt-2 text-xs text-slate-500">
                                                <span>{formatDate(task.createdAt)}</span>
                                                {task.langgraph_template && (
                                                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
                                                        <Workflow size={10} />
                                                        {templates.find(t => t.id === task.langgraph_template)?.name || task.langgraph_template}
                                                    </span>
                                                )}
                                                {task.implementationPlan && (
                                                    <span className="px-1.5 py-0.5 rounded bg-slate-800">Has Plan</span>
                                                )}
                                                {task.walkthrough && (
                                                    <span className="px-1.5 py-0.5 rounded bg-slate-800">Has Walkthrough</span>
                                                )}
                                                {task.langgraph_template && task.status === 'idea' && !task.langGraph?.runId && (
                                                    <button
                                                        onClick={async (e) => {
                                                            e.stopPropagation();
                                                            setStartingWorkflow(task.id);
                                                            try {
                                                                await runTaskWithLangGraph(projectId, task.id, { templateId: task.langgraph_template || undefined });
                                                                onTasksChange();
                                                            } catch (err) {
                                                                console.error('Failed to start workflow:', err);
                                                            } finally {
                                                                setStartingWorkflow(null);
                                                            }
                                                        }}
                                                        disabled={startingWorkflow === task.id}
                                                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
                                                        title="Start attached workflow"
                                                    >
                                                        {startingWorkflow === task.id ? (
                                                            <Loader2 size={10} className="animate-spin" />
                                                        ) : (
                                                            <Play size={10} />
                                                        )}
                                                        Start
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Edit Task Modal */}
            {editingTask && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-lg mx-4 shadow-2xl">
                        <h3 className="text-xl font-semibold text-white mb-4">Edit Task</h3>
                        {editError && (
                            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                                {editError}
                            </div>
                        )}
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">
                                    Title <span className="text-red-400">*</span>
                                </label>
                                <input
                                    type="text"
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="Task title"
                                    disabled={isEditSaving}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">Description</label>
                                <textarea
                                    value={editDescription}
                                    onChange={(e) => setEditDescription(e.target.value)}
                                    rows={4}
                                    className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                                    placeholder="Describe the task..."
                                    disabled={isEditSaving}
                                />
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 mt-6">
                            <button
                                onClick={() => setEditingTask(null)}
                                disabled={isEditSaving}
                                className="px-4 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleEditSave}
                                disabled={isEditSaving || !editTitle.trim()}
                                className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50 flex items-center gap-2"
                            >
                                {isEditSaving ? (
                                    <>
                                        <Loader2 size={14} className="animate-spin" />
                                        Saving...
                                    </>
                                ) : (
                                    'Save Changes'
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
