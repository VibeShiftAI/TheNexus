"use client"

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { getProject, getProjectStatus, getProjectCommits, getTasks, getProjectReadme, Project, GitStatus, Commit, Task, getDashboardStats, ReviewItem } from "@/lib/nexus";
import { ArrowLeft, GitBranch, Zap, Bot, Activity, Brain, FolderOpen as Folders, FileText, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { AITerminal } from "@/components/ai-terminal";
import { TaskManager } from "@/components/task-manager";
import { TaskArchive } from "@/components/task-archive";
import { TaskDetailModal } from "@/components/task-detail-modal";
import { ProjectSettings } from "@/components/project-settings";
import { ProjectContextManager } from "@/components/project-context-manager";
import { ProjectWorkflows } from "@/components/project-workflows";
import { ArtifactsList } from "@/components/artifacts-list";
import { TaskStatusTiles } from "@/components/task-status-tiles";

export default function ProjectDetailPage() {
    const params = useParams();
    const projectId = params.id as string;

    const [project, setProject] = useState<Project | null>(null);
    const [status, setStatus] = useState<GitStatus | null>(null);
    const [commits, setCommits] = useState<Commit[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAITerminal, setShowAITerminal] = useState(false);
    const [selectedTask, setSelectedTask] = useState<Task | null>(null);
    const [initialTab, setInitialTab] = useState<'overview' | 'spec' | 'research' | 'plan' | 'walkthrough' | undefined>(undefined);
    const [readme, setReadme] = useState<{ exists: boolean; content: string | null }>({ exists: false, content: null });
    const [readmeExpanded, setReadmeExpanded] = useState(true);
    const [artifactsInReview, setArtifactsInReview] = useState<{ items: ReviewItem[], project: number, task: number }>({ items: [], project: 0, task: 0 });

    const selectedTaskRef = useRef<Task | null>(null);
    selectedTaskRef.current = selectedTask;
    const deepLinkHandled = useRef(false);

    const loadTasks = useCallback(async () => {
        if (!projectId) return;
        try {
            const res = await getTasks(projectId);
            setTasks(res.tasks);
            // Update selected task if it exists - use ref to read CURRENT value
            // (avoids stale closure resurrecting a task after onClose sets it to null)
            const currentSelected = selectedTaskRef.current;
            if (currentSelected) {
                const updated = res.tasks.find(t => t.id === currentSelected.id);
                setSelectedTask(updated || null);
            }
        } catch (error) {
            console.error('Failed to load tasks:', error);
        }
    }, [projectId]);

    useEffect(() => {
        if (!projectId) return;

        Promise.all([
            getProject(projectId),
            getProjectStatus(projectId).catch(() => null),
            getProjectCommits(projectId).catch(() => ({ commits: [], hasGit: false })),
            getTasks(projectId),
            getProjectReadme(projectId).catch(() => ({ exists: false, content: null })),
            getDashboardStats().catch(() => null)
        ])
            .then(([proj, stat, commitsRes, tasksRes, readmeRes, statsRes]) => {
                setProject(proj);
                setStatus(stat);
                setCommits(commitsRes.commits);
                setTasks(tasksRes.tasks);
                setReadme(readmeRes);
                if (statsRes) {
                    // Filter for this project
                    const items = statsRes.artifactsInReview.items.filter(i => i.projectId === projectId);
                    setArtifactsInReview({
                        items,
                        project: items.filter(i => i.level === 'Project').length,
                        task: items.filter(i => i.level === 'Task').length
                    });
                }
            })
            .catch(console.error)
            .finally(() => setLoading(false));
    }, [projectId]);

    // Handle deep linking - only on initial page load, not on every close/reopen
    const searchParams = useSearchParams();
    useEffect(() => {
        if (loading || tasks.length === 0) return;
        if (deepLinkHandled.current) return;

        const taskId = searchParams.get('taskId');
        const artifact = searchParams.get('artifact');

        if (taskId) {
            const task = tasks.find(t => t.id === taskId);
            if (task) {
                deepLinkHandled.current = true;
                setSelectedTask(task);
                if (artifact && ['overview', 'spec', 'research', 'plan', 'walkthrough'].includes(artifact)) {
                    setInitialTab(artifact as any);
                }
            }
        }
    }, [loading, tasks, searchParams]);

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    // Calculate task stats for the tiles
    const taskStats = useMemo(() => {
        const stats: Record<string, number> = {
            idea: 0,
            researching: 0,
            researched: 0,  // Added
            planning: 0,
            planned: 0,     // Added
            implementing: 0,
            testing: 0,
            complete: 0
        };
        tasks.forEach(t => {
            if (stats[t.status] !== undefined) {
                stats[t.status]++;
            }
        });
        return stats;
    }, [tasks]);

    if (loading) {
        return (
            <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center">
                <div className="animate-spin text-cyan-500">
                    <GitBranch size={32} />
                </div>
            </div>
        );
    }

    if (!project) {
        return (
            <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col items-center justify-center">
                <h1 className="text-2xl font-bold text-red-400">Project Not Found</h1>
                <Link href="/" className="mt-4 text-cyan-400 hover:text-cyan-300">
                    ← Back to Dashboard
                </Link>
            </div>
        );
    }

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
            {/* Header HUD */}
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <Link
                            href="/"
                            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
                        >
                            <ArrowLeft size={18} />
                            <span className="text-sm">Dashboard</span>
                        </Link>
                        <div className="h-6 w-px bg-slate-700" />
                        <div className="flex items-center gap-2">
                            <Folders className="text-cyan-500" size={20} />
                            <span className="text-sm font-bold tracking-tight text-white uppercase">{project.name}</span>
                        </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm font-medium text-slate-400">
                        <button
                            onClick={() => setShowAITerminal(true)}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-500/20 to-cyan-500/20 border border-purple-500/30 hover:border-purple-500/50 transition-all text-purple-400 hover:text-purple-300"
                        >
                            <Bot size={16} />
                            <span>Praxis Terminal</span>
                        </button>
                        <Link
                            href="/agents"
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gradient-to-r from-emerald-500/20 to-cyan-500/20 border border-emerald-500/30 hover:border-emerald-500/50 transition-all text-emerald-400 hover:text-emerald-300"
                        >
                            <Brain size={16} />
                            <span>Agents</span>
                        </Link>

                        <Link
                            href="/system-monitor"
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-500/30 hover:border-amber-500/50 transition-all text-amber-400 hover:text-amber-300"
                        >
                            <Activity size={16} />
                            <span>Monitor</span>
                        </Link>
                        <div className="flex items-center gap-2">
                            <Zap size={16} className="text-yellow-500" />
                            <span className="uppercase">{project.vibe || 'HIGH VIBE'}</span>
                        </div>
                    </div>
                </div>
            </header>

            <AITerminal
                isOpen={showAITerminal}
                onClose={() => setShowAITerminal(false)}
            />

            {/* Task Detail Modal */}
            {selectedTask && (
                <TaskDetailModal
                    key={selectedTask.id}
                    projectId={projectId}
                    task={selectedTask}
                    onClose={() => {
                        // Update ref IMMEDIATELY so any in-flight loadTasks reads null
                        selectedTaskRef.current = null;
                        setSelectedTask(null);
                        setInitialTab(undefined);
                        // Clear deep link params from URL to prevent re-selection
                        const url = new URL(window.location.href);
                        if (url.searchParams.has('taskId')) {
                            url.searchParams.delete('taskId');
                            url.searchParams.delete('artifact');
                            window.history.replaceState({}, '', url.pathname + url.search);
                        }
                    }}
                    onTaskChange={loadTasks}
                    initialTab={initialTab}
                />
            )}

            <div className="container mx-auto p-6 space-y-6">


                {/* Project Overview Row - right column drives height, left fills to match */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Project Details + Context Manager (unified) */}
                    <div className="lg:col-span-2 relative min-w-0">
                        <div className="lg:absolute lg:inset-0 bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
                            <div className="px-4 py-3 border-b border-slate-800 shrink-0">
                                <ProjectSettings
                                    project={project}
                                    onUpdate={() => {
                                        getProject(projectId).then(setProject);
                                    }}
                                />
                            </div>
                            <div className="overflow-y-auto flex-1 min-h-0">
                                <ProjectContextManager project={project} />
                            </div>
                        </div>
                    </div>

                    {/* Git Status + Project Workflows + Artifacts */}
                    <div className="flex flex-col gap-4">
                        <div className="flex-1 bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                                    <GitBranch size={14} className="text-cyan-400" />
                                    Git Status
                                </h3>
                                {status && (
                                    <span className="text-white font-mono font-bold text-xs bg-slate-800/80 px-2 py-0.5 rounded">{status.current || 'N/A'}</span>
                                )}
                            </div>
                            {status ? (
                                <div className="space-y-2">
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="p-2 bg-slate-800/50 rounded-lg text-center">
                                            <div className={`text-lg font-bold ${status.uncommittedCount > 0 ? "text-orange-400" : "text-emerald-400"}`}>
                                                {status.uncommittedCount}
                                            </div>
                                            <div className="text-xs text-slate-500 uppercase">Changes</div>
                                        </div>
                                        <div className="p-2 bg-slate-800/50 rounded-lg text-center">
                                            <div className="text-lg font-bold text-blue-400">
                                                {status.ahead} / {status.behind}
                                            </div>
                                            <div className="text-xs text-slate-500 uppercase">Sync (↑/↓)</div>
                                        </div>
                                    </div>
                                    {commits.length > 0 && (
                                        <div>
                                            <p className="text-xs text-slate-500 uppercase mb-1">Recent Commits</p>
                                            <div className="space-y-1.5">
                                                {commits.slice(0, 3).map((commit, idx) => (
                                                    <div key={commit.hash} className={`text-xs border-l-2 pl-2 ${idx === 0 ? 'border-cyan-500/50' : 'border-slate-700/50'}`}>
                                                        <div className="font-mono text-cyan-400 text-xs">{commit.hash.substring(0, 7)}</div>
                                                        <div className="text-slate-300 line-clamp-1">{commit.message}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="text-slate-500 text-center py-3 text-sm">No git repository detected</div>
                            )}
                        </div>
                        <div className="flex-1">
                            <ProjectWorkflows projectId={projectId} />
                        </div>
                        <div className="flex-1">
                            <ArtifactsList
                                items={artifactsInReview.items}
                                projectCount={artifactsInReview.project}
                                taskCount={artifactsInReview.task}
                                projectId={projectId}
                            />
                        </div>
                    </div>
                </div>

                {/* Task Status + Task Manager Row */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div className="lg:col-span-2">
                        <TaskManager
                            projectId={projectId}
                            tasks={tasks}
                            onTasksChange={loadTasks}
                            onTaskSelect={setSelectedTask}
                        />
                    </div>
                    <div className="lg:col-span-1 space-y-3">
                        <TaskStatusTiles stats={taskStats} />
                        <TaskArchive
                            projectId={projectId}
                            tasks={tasks}
                            onTasksChange={loadTasks}
                            onTaskSelect={setSelectedTask}
                        />
                    </div>
                </div>

                {/* README Section */}
                {readme.exists && readme.content && (
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden">
                        <button
                            onClick={() => setReadmeExpanded(!readmeExpanded)}
                            className="w-full flex items-center justify-between p-4 hover:bg-slate-800/30 transition-colors"
                        >
                            <div className="flex items-center gap-2">
                                <FileText size={18} className="text-cyan-400" />
                                <h3 className="text-lg font-bold text-white">README.md</h3>
                            </div>
                            {readmeExpanded ? <ChevronUp size={18} className="text-slate-400" /> : <ChevronDown size={18} className="text-slate-400" />}
                        </button>
                        {readmeExpanded && (
                            <div className="p-6 pt-0 border-t border-slate-800/50">
                                <div className="prose prose-invert prose-sm max-w-none
                                    prose-headings:text-white prose-headings:font-bold
                                    prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg
                                    prose-p:text-slate-300
                                    prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline
                                    prose-code:text-cyan-300 prose-code:bg-slate-800/50 prose-code:px-1 prose-code:rounded
                                    prose-pre:bg-slate-800/80 prose-pre:border prose-pre:border-slate-700
                                    prose-ul:text-slate-300 prose-ol:text-slate-300
                                    prose-strong:text-white
                                    prose-blockquote:border-cyan-500/50 prose-blockquote:text-slate-400
                                ">
                                    <div dangerouslySetInnerHTML={{
                                        __html: readme.content
                                            .replace(/^### (.*$)/gim, '<h3>$1</h3>')
                                            .replace(/^## (.*$)/gim, '<h2>$1</h2>')
                                            .replace(/^# (.*$)/gim, '<h1>$1</h1>')
                                            .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
                                            .replace(/\*(.*)\*/gim, '<em>$1</em>')
                                            .replace(/`([^`]+)`/gim, '<code>$1</code>')
                                            .replace(/^- (.*$)/gim, '<li>$1</li>')
                                            .replace(/(<li>[\s\S]*<\/li>)/gm, '<ul>$1</ul>')
                                            .replace(/\n/gim, '<br />')
                                    }} />
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </main>
    );
}
