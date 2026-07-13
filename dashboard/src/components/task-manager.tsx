import { useState, useEffect } from "react";
import { Task, TaskStatus, addTask, deleteTask, researchTasks, getResearchStatus, updateTask, updateTaskDetails } from "@/lib/nexus";
import { TASK_AUTO_START_STATUSES, normalizeTaskBoardStatus } from "@praxis/contract";
import { Lightbulb, Plus, Search, Rocket, CheckCircle2, Clock, Loader2, ChevronRight, Sparkles, XCircle, Undo2, Pencil, Bug, HelpCircle, AlertTriangle, Fingerprint, Pause, ClipboardCopy, Check } from "lucide-react";
import { copyClaudeDispatch } from "@/lib/claude-dispatch";
import { ModelAssignmentControl } from "@/components/model-assignment-control";
import { ModelAliasManager } from "@/components/model-alias-manager";

interface TaskManagerProps {
    projectId: string;
    tasks: Task[];
    onTasksChange: () => void;
    onTaskSelect: (task: Task) => void;
}

/** Known status display config. Ad-hoc statuses are auto-styled via fallback in the rendering code. */
const statusConfig: Record<string, { label: string; icon: React.ReactNode; color: string; bgColor: string; borderColor: string }> = {
    idea: { label: 'Ideas', icon: <Lightbulb size={18} />, color: 'text-blue-600', bgColor: 'bg-blue-600/10', borderColor: 'border-blue-600/20' },
    todo: { label: 'To Do', icon: <Clock size={18} />, color: 'text-slate-400', bgColor: 'bg-slate-400/10', borderColor: 'border-slate-800' },
    planning: { label: 'Planning', icon: <Rocket size={18} />, color: 'text-purple-400', bgColor: 'bg-purple-400/10', borderColor: 'border-purple-400/20' },
    building: { label: 'Building', icon: <Loader2 size={18} className="animate-spin" />, color: 'text-emerald-400', bgColor: 'bg-emerald-400/10', borderColor: 'border-emerald-400/20' },
    testing: { label: 'Testing', icon: <Search size={18} />, color: 'text-amber-400', bgColor: 'bg-amber-400/10', borderColor: 'border-amber-400/20' },
    ready_for_review: { label: 'Ready for Review', icon: <Sparkles size={18} />, color: 'text-cyan-400', bgColor: 'bg-cyan-400/10', borderColor: 'border-cyan-400/20' },
    complete: { label: 'Complete', icon: <CheckCircle2 size={18} />, color: 'text-slate-500', bgColor: 'bg-slate-500/5', borderColor: 'border-slate-800' },
    rejected: { label: 'Rejected', icon: <XCircle size={18} />, color: 'text-red-400', bgColor: 'bg-red-400/10', borderColor: 'border-red-400/20' },
    cancelled: { label: 'Cancelled', icon: <Undo2 size={18} />, color: 'text-slate-500', bgColor: 'bg-slate-500/10', borderColor: 'border-slate-800' }
};

export function TaskManager({ projectId, tasks, onTasksChange, onTaskSelect }: TaskManagerProps) {
    const [showForm, setShowForm] = useState(false);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [newTaskModelAssignment, setNewTaskModelAssignment] = useState<string>('');
    // Sequencing: predecessors must all complete before the task starts;
    // the (single) successor auto-starts the moment it completes.
    const [newTaskPredecessors, setNewTaskPredecessors] = useState<string[]>([]);
    const [newTaskSuccessor, setNewTaskSuccessor] = useState<string>('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [researchingId, setResearchingId] = useState<string | null>(null);
    const [isAutoResearching, setIsAutoResearching] = useState(false);
    const [researchError, setResearchError] = useState<string | null>(null);
    const [showAliasManager, setShowAliasManager] = useState(false);
    const [copiedDispatchTaskId, setCopiedDispatchTaskId] = useState<string | null>(null);

    // Edit state
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [editTitle, setEditTitle] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [editModelAssignment, setEditModelAssignment] = useState<string>('');
    const [isEditSaving, setIsEditSaving] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);

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
            await addTask(projectId, title.trim(), description.trim() || undefined, newTaskModelAssignment || null, {
                dependencies: newTaskPredecessors,
                successor_id: newTaskSuccessor || null,
            });
            setTitle('');
            setDescription('');
            setNewTaskModelAssignment('');
            setNewTaskPredecessors([]);
            setNewTaskSuccessor('');
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
        setEditModelAssignment(task.model_assignment || '');
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
                description: editDescription.trim(),
                model_assignment: editModelAssignment || null
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
        task.status !== 'completed' &&
        task.status !== 'rejected' &&
        task.status !== 'cancelled'
    );

    // Group active tasks by status
    const groupedTasks = activeTasks.reduce((acc, task) => {
        if (!acc[task.status]) acc[task.status] = [];
        acc[task.status].push(task);
        return acc;
    }, {} as Record<string, Task[]>);




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
                        onClick={() => setShowAliasManager(!showAliasManager)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-all"
                    >
                        Model Aliases
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

            {showAliasManager && (
                <div className="mb-4">
                    <ModelAliasManager projectId={projectId} />
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
                    <div className="mb-3">
                        <label className="block text-xs text-slate-400 mb-1">Model</label>
                        <ModelAssignmentControl
                            value={newTaskModelAssignment}
                            projectId={projectId}
                            role="task"
                            onChange={setNewTaskModelAssignment}
                        />
                    </div>
                    {/* Sequence — predecessors (many) + successor (one) */}
                    <div className="mb-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs text-slate-400 mb-1">Predecessors — must complete first</label>
                            {newTaskPredecessors.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mb-1.5">
                                    {newTaskPredecessors.map((id) => {
                                        const t = tasks.find((x) => x.id === id);
                                        return (
                                            <span key={id} className="inline-flex items-center gap-1 rounded bg-slate-900 border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-300">
                                                <span className="max-w-[140px] truncate">{t?.title || id}</span>
                                                <button
                                                    type="button"
                                                    aria-label={`Remove predecessor ${t?.title || id}`}
                                                    onClick={() => setNewTaskPredecessors((prev) => prev.filter((d) => d !== id))}
                                                    className="text-slate-500 hover:text-rose-300"
                                                >
                                                    ×
                                                </button>
                                            </span>
                                        );
                                    })}
                                </div>
                            )}
                            <select
                                value=""
                                onChange={(e) => {
                                    if (e.target.value) setNewTaskPredecessors((prev) => [...prev, e.target.value]);
                                }}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-purple-500/50"
                                aria-label="Add predecessor"
                            >
                                <option value="">+ Add predecessor…</option>
                                {tasks.filter((t) => !newTaskPredecessors.includes(t.id)).map((t) => (
                                    <option key={t.id} value={t.id}>{t.title} ({t.status})</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs text-slate-400 mb-1">Successor — starts when this completes</label>
                            <select
                                value={newTaskSuccessor}
                                onChange={(e) => setNewTaskSuccessor(e.target.value)}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-purple-500/50"
                                aria-label="Successor task"
                            >
                                <option value="">No successor</option>
                                {tasks
                                    .filter((t) =>
                                        (TASK_AUTO_START_STATUSES as readonly string[]).includes(
                                            normalizeTaskBoardStatus(t.status) ?? "",
                                        ) || t.id === newTaskSuccessor,
                                    )
                                    .map((t) => (
                                        <option key={t.id} value={t.id}>{t.title} ({t.status})</option>
                                    ))}
                            </select>
                        </div>
                    </div>
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
                            onClick={() => { setShowForm(false); setTitle(''); setDescription(''); setNewTaskModelAssignment(''); setNewTaskPredecessors([]); setNewTaskSuccessor(''); }}
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
                    {/* Render known statuses in order first, then ad-hoc statuses alphabetically */}
                    {(() => {
                        const knownOrder = ['idea', 'todo', 'planning', 'building', 'testing', 'ready_for_review'];
                        const adHocStatuses = Object.keys(groupedTasks).filter(s => !knownOrder.includes(s)).sort();
                        const renderOrder = [...knownOrder.filter(s => groupedTasks[s]?.length), ...adHocStatuses];
                        return renderOrder;
                    })().map(status => {
                        const statusTasks = groupedTasks[status];
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
                                                    <button
                                                        onClick={async (e) => {
                                                            e.stopPropagation();
                                                            try {
                                                                await copyClaudeDispatch(task, projectId);
                                                                setCopiedDispatchTaskId(task.id);
                                                                setTimeout(() => setCopiedDispatchTaskId(current => current === task.id ? null : current), 2000);
                                                            } catch (err) {
                                                                console.error('Failed to copy Claude dispatch brief:', err);
                                                            }
                                                        }}
                                                        className={`p-1.5 rounded-lg hover:bg-slate-700 transition-colors ${copiedDispatchTaskId === task.id ? 'text-emerald-400' : 'text-slate-400 hover:text-purple-400'}`}
                                                        title="Copy Claude dispatch brief (paste into any Claude session; includes completion instructions)"
                                                    >
                                                        {copiedDispatchTaskId === task.id ? <Check size={14} /> : <ClipboardCopy size={14} />}
                                                    </button>

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
                                                {task.model_assignment && (
                                                    <span className="px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
                                                        {task.model_assignment.replace(/^model:/, '').replace(/^alias:/, '')}
                                                    </span>
                                                )}
                                                {task.implementationPlan && (
                                                    <span className="px-1.5 py-0.5 rounded bg-slate-800">Has Plan</span>
                                                )}
                                                {task.walkthrough && (
                                                    <span className="px-1.5 py-0.5 rounded bg-slate-800">Has Walkthrough</span>
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
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">Model</label>
                                <ModelAssignmentControl
                                    value={editModelAssignment}
                                    projectId={projectId}
                                    role="task"
                                    onChange={setEditModelAssignment}
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
