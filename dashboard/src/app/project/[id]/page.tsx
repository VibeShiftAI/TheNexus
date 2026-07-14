"use client"

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { getProject, getProjectCommits, getTasks, getProjectReadme, getProjectBrief, Project, ProjectBrief, Commit, Task, getDashboardStats, ReviewItem, unarchiveProject } from "@/lib/nexus";
import { ArrowLeft, GitBranch, Zap, Bot, Activity, Brain, FolderOpen as Folders, FileText, ChevronDown, ChevronUp, Archive, Settings2 } from "lucide-react";
import Link from "next/link";
import { AITerminal } from "@/components/ai-terminal";
import { TaskManager } from "@/components/task-manager";
import { TaskArchive } from "@/components/task-archive";
import { ProjectSettings } from "@/components/project-settings";
import { ProjectContextManager } from "@/components/project-context-manager";
import { ArtifactsList } from "@/components/artifacts-list";
import { ProjectNotes } from "@/components/project-notes";
import { ProjectStakeholders } from "@/components/project-stakeholders";
import { MissionBrief } from "@/components/project-brief/mission-brief";
import { ActivityReport } from "@/components/project-brief/activity-report";
import { HudPanel } from "@/components/bridge/hud";
import { ActivityLed, activityBand, timeAgo } from "@/components/pulse-visuals";

export default function ProjectDetailPage() {
    const params = useParams();
    const projectId = params.id as string;
    const router = useRouter();

    const [project, setProject] = useState<Project | null>(null);
    const [brief, setBrief] = useState<ProjectBrief | null>(null);
    const [commits, setCommits] = useState<Commit[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAITerminal, setShowAITerminal] = useState(false);
    const [readme, setReadme] = useState<{ exists: boolean; content: string | null }>({ exists: false, content: null });
    const [readmeExpanded, setReadmeExpanded] = useState(false);
    const [artifactsInReview, setArtifactsInReview] = useState<{ items: ReviewItem[], project: number, task: number }>({ items: [], project: 0, task: 0 });

    // Opening a task navigates to its own screen (/task/[id]) — the old
    // in-page TaskDetailModal overlay is retired.
    const openTask = useCallback((task: Task) => {
        router.push(`/task/${task.id}`);
    }, [router]);

    const loadTasks = useCallback(async () => {
        if (!projectId) return;
        try {
            const res = await getTasks(projectId);
            setTasks(res.tasks);
        } catch (error) {
            console.error('Failed to load tasks:', error);
        }
    }, [projectId]);

    const [restoring, setRestoring] = useState(false);
    const handleRestore = async () => {
        setRestoring(true);
        try {
            await unarchiveProject(projectId);
            const [proj] = await Promise.all([getProject(projectId), loadTasks()]);
            setProject(proj);
        } catch (error) {
            console.error('Failed to restore project:', error);
            alert(error instanceof Error ? error.message : 'Failed to restore project');
        } finally {
            setRestoring(false);
        }
    };

    useEffect(() => {
        if (!projectId) return;

        Promise.all([
            getProject(projectId),
            getProjectBrief(projectId).catch(() => null),
            getProjectCommits(projectId).catch(() => ({ commits: [], hasGit: false })),
            getTasks(projectId),
            getProjectReadme(projectId).catch(() => ({ exists: false, content: null })),
            getDashboardStats().catch(() => null)
        ])
            .then(([proj, briefRes, commitsRes, tasksRes, readmeRes, statsRes]) => {
                setProject(proj);
                setBrief(briefRes);
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

    // Legacy deep links (?taskId= from chat/mobile/bookmarks) land on the new
    // task screen — the modal they used to open no longer exists.
    const searchParams = useSearchParams();
    useEffect(() => {
        const taskId = searchParams.get('taskId');
        if (taskId) router.replace(`/task/${taskId}`);
    }, [searchParams, router]);

    if (loading) {
        return (
            <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col items-center justify-center gap-3">
                <div className="animate-spin text-cyan-500">
                    <GitBranch size={32} />
                </div>
                <span className="text-[11px] uppercase tracking-widest text-slate-600">compiling project brief…</span>
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

    const band = activityBand(brief?.lastActivityAt);
    const lastSeen = timeAgo(brief?.lastActivityAt);
    const git = brief?.git;

    return (
        <main className="min-h-screen bg-slate-950 hud-backdrop text-slate-200 selection:bg-cyan-500/30">
            {/* Header HUD */}
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <Link
                            href="/"
                            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
                        >
                            <ArrowLeft size={18} />
                            <span className="text-sm">Bridge</span>
                        </Link>
                        <div className="h-6 w-px bg-slate-700" />
                        <div className="flex items-center gap-2.5">
                            <Folders className="text-cyan-500" size={18} />
                            <span className="text-sm font-bold tracking-tight text-white uppercase">{project.name}</span>
                            <span className="flex items-center gap-1.5 rounded border border-slate-800 bg-slate-900/60 px-2 py-0.5">
                                <ActivityLed band={band} />
                                <span className="font-mono text-[10px] text-slate-500">
                                    {lastSeen ? `Δ ${lastSeen}` : "no signal"}
                                </span>
                            </span>
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

            <div className="container mx-auto p-6 space-y-6">

                {project.status === 'archived' && (
                    <div className="flex items-center justify-between gap-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
                        <div className="flex items-center gap-2.5 text-amber-300">
                            <Archive size={18} className="shrink-0" />
                            <div className="text-left">
                                <p className="text-sm font-bold">This project is archived</p>
                                <p className="text-xs text-amber-400/80">
                                    It is hidden from the dashboard and excluded from AI context. Its tasks are archived. Files on disk are unchanged.
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={handleRestore}
                            disabled={restoring}
                            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-slate-950 hover:bg-amber-400 transition-colors text-xs font-bold"
                        >
                            {restoring ? <div className="w-3.5 h-3.5 border-2 border-slate-950/30 border-t-slate-950 rounded-full animate-spin" /> : <Archive size={14} />}
                            Restore Project
                        </button>
                    </div>
                )}

                {/* Mission brief hero */}
                <div className="hud-boot">
                    <MissionBrief project={project} brief={brief} />
                </div>

                {/* Reports row — operations report beside git + artifacts rail */}
                <div className="hud-boot hud-boot-1 grid grid-cols-1 gap-6 lg:grid-cols-3">
                    <div className="lg:col-span-2 min-w-0">
                        <ActivityReport brief={brief} />
                    </div>
                    <div className="flex flex-col gap-4 min-w-0">
                        <HudPanel icon={<GitBranch size={16} />} title="Repository" accent="emerald"
                            headerRight={git?.branch ? (
                                <span className="rounded bg-slate-800/80 px-2 py-0.5 font-mono text-xs font-bold text-white">{git.branch}</span>
                            ) : undefined}
                        >
                            {git?.hasGit ? (
                                <div className="space-y-3">
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="rounded-lg bg-slate-800/50 p-2 text-center">
                                            <div className={`text-lg font-bold tabular-nums ${git.uncommitted > 0 ? "text-orange-400" : "text-emerald-400"}`}>
                                                {git.uncommitted}
                                            </div>
                                            <div className="text-xs uppercase text-slate-500">Changes</div>
                                        </div>
                                        <div className="rounded-lg bg-slate-800/50 p-2 text-center">
                                            <div className="text-lg font-bold tabular-nums text-blue-400">
                                                {git.ahead} / {git.behind}
                                            </div>
                                            <div className="text-xs uppercase text-slate-500">Sync (↑/↓)</div>
                                        </div>
                                    </div>
                                    {commits.length > 0 && (
                                        <div>
                                            <p className="mb-1 text-xs uppercase text-slate-500">Recent Commits</p>
                                            <div className="space-y-1.5">
                                                {commits.slice(0, 4).map((commit, idx) => (
                                                    <div key={commit.hash} className={`border-l-2 pl-2 text-xs ${idx === 0 ? 'border-cyan-500/50' : 'border-slate-700/50'}`}>
                                                        <div className="flex items-baseline gap-2">
                                                            <span className="font-mono text-cyan-400">{commit.hash.substring(0, 7)}</span>
                                                            <span className="font-mono text-[10px] text-slate-600">Δ {timeAgo(commit.date)}</span>
                                                        </div>
                                                        <div className="line-clamp-1 text-slate-300">{commit.message}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {git.remoteUrl && (
                                        <a href={git.remoteUrl} target="_blank" rel="noopener noreferrer"
                                            className="inline-block truncate font-mono text-[11px] text-slate-500 transition-colors hover:text-cyan-400">
                                            {git.remoteUrl.replace('https://github.com/', 'github.com/')}
                                        </a>
                                    )}
                                </div>
                            ) : (
                                <div className="py-3 text-center text-sm text-slate-500">No git repository detected</div>
                            )}
                        </HudPanel>
                        <ArtifactsList
                            items={artifactsInReview.items}
                            projectCount={artifactsInReview.project}
                            taskCount={artifactsInReview.task}
                            projectId={projectId}
                        />
                    </div>
                </div>

                {/* Task operations row */}
                <div className="hud-boot hud-boot-2 grid grid-cols-1 gap-6 lg:grid-cols-3">
                    <div className="lg:col-span-2 min-w-0">
                        <TaskManager
                            projectId={projectId}
                            tasks={tasks}
                            onTasksChange={loadTasks}
                            onTaskSelect={openTask}
                        />
                    </div>
                    <div className="min-w-0 space-y-4">
                        <TaskArchive
                            projectId={projectId}
                            tasks={tasks}
                            onTasksChange={loadTasks}
                            onTaskSelect={openTask}
                        />
                        <ProjectStakeholders projectId={projectId} />
                        <ProjectNotes projectId={projectId} />
                    </div>
                </div>

                {/* Configuration + context — the editable underbelly of the brief */}
                <div className="hud-boot hud-boot-3">
                    <HudPanel icon={<Settings2 size={16} />} title="Project Configuration" accent="purple">
                        <div className="overflow-hidden rounded-lg">
                            <div className="border-b border-slate-800 px-1 pb-3">
                                <ProjectSettings
                                    project={project}
                                    onUpdate={() => {
                                        getProject(projectId).then(setProject);
                                    }}
                                />
                            </div>
                            <ProjectContextManager project={project} />
                        </div>
                    </HudPanel>
                </div>

                {/* README Section */}
                {readme.exists && readme.content && (
                    <div className="hud-boot hud-boot-4 bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden">
                        <button
                            onClick={() => setReadmeExpanded(!readmeExpanded)}
                            className="w-full flex items-center justify-between p-4 hover:bg-slate-800/30 transition-colors"
                        >
                            <div className="flex items-center gap-2">
                                <FileText size={18} className="text-cyan-400" />
                                <h3 className="text-lg font-bold text-white">README.md</h3>
                                <span className="text-[10px] uppercase tracking-widest text-slate-600">technical annex</span>
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
