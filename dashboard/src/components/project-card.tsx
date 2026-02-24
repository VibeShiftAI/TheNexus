"use client"

import { useEffect, useState } from "react";
import { Project, getProjectStatus, GitStatus, initGitRepo, addGitRemote, pingProject, PingResult, pinProject, unpinProject, commitAndPush, generateCommitMessage } from "@/lib/nexus";
import { Folder, GitBranch, Zap, Layers, Activity, AlertTriangle, XCircle, ExternalLink, Globe, Star, Upload } from "lucide-react";
import Link from "next/link";

interface ProjectCardProps {
    pendingReviews?: number;
    project: Project;
    isPinned?: boolean;
    onPinChange?: (id: string, pinned: boolean) => void;
}

export function ProjectCard({ project, isPinned = false, onPinChange, pendingReviews = 0 }: ProjectCardProps) {
    const [status, setStatus] = useState<GitStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(false);
    const [deployStatus, setDeployStatus] = useState<PingResult | null>(null);
    const [pinLoading, setPinLoading] = useState(false);

    const loadStatus = async () => {
        try {
            const data = await getProjectStatus(project.id);
            setStatus(data);
        } catch (e) {
            console.error("Failed to load status for", project.name, e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        let mounted = true;
        async function load() {
            try {
                const data = await getProjectStatus(project.id);
                if (mounted) setStatus(data);
            } catch (e) {
                console.error("Failed to load status for", project.name, e);
            } finally {
                if (mounted) setLoading(false);
            }
        }
        load();
        return () => { mounted = false; };
    }, [project.id, project.name]);

    // Fetch deploy status if project has production URL
    useEffect(() => {
        if (project.urls?.production) {
            pingProject(project.id)
                .then(setDeployStatus)
                .catch(console.error);
        }
    }, [project.id, project.urls?.production]);

    const handleInitGit = async () => {
        setActionLoading(true);
        try {
            await initGitRepo(project.id);
            await loadStatus();
        } catch (e) {
            console.error("Failed to init git:", e);
            alert("Failed to initialize git: " + (e instanceof Error ? e.message : "Unknown error"));
        } finally {
            setActionLoading(false);
        }
    };

    const handleAddRemote = async () => {
        const repoName = project.name.replace(/\s+/g, '-');
        const url = prompt(`Enter GitHub repo URL:`, `git@github.com:Guatapickl/${repoName}.git`);
        if (!url) return;

        setActionLoading(true);
        try {
            await addGitRemote(project.id, url);
            await loadStatus();
        } catch (e) {
            console.error("Failed to add remote:", e);
            alert("Failed to add remote: " + (e instanceof Error ? e.message : "Unknown error"));
        } finally {
            setActionLoading(false);
        }
    };

    const handlePinToggle = async () => {
        setPinLoading(true);
        try {
            if (isPinned) {
                await unpinProject(project.id);
                onPinChange?.(project.id, false);
            } else {
                await pinProject(project.id);
                onPinChange?.(project.id, true);
            }
        } catch (e) {
            console.error("Failed to toggle pin:", e);
        } finally {
            setPinLoading(false);
        }
    };

    const handleCommitAndPush = async () => {
        setActionLoading(true);
        try {
            // Generate a commit message using AI
            const result = await generateCommitMessage(project.id);
            await commitAndPush(project.id, result.message);
            await loadStatus();
        } catch (e) {
            console.error("Failed to commit and push:", e);
            alert("Failed to commit and push: " + (e instanceof Error ? e.message : "Unknown error"));
        } finally {
            setActionLoading(false);
        }
    };

    const getGitStateDisplay = () => {
        if (loading) {
            return (
                <div className="flex items-center gap-2 text-slate-500">
                    <div className="animate-spin h-3 w-3 border border-slate-500 border-t-transparent rounded-full" />
                    <span className="text-xs">Loading...</span>
                </div>
            );
        }

        if (!status || !status.hasGit) {
            return (
                <button
                    onClick={handleInitGit}
                    disabled={actionLoading}
                    className="flex items-center gap-2 px-3 py-1.5 bg-slate-700/50 hover:bg-slate-700 rounded text-xs text-slate-300 hover:text-white transition-colors disabled:opacity-50"
                >
                    <Zap size={12} />
                    Initialize Git
                </button>
            );
        }

        if (!status.hasRemote) {
            return (
                <div className="space-y-2">
                    <div className="flex items-center gap-2 text-amber-500">
                        <AlertTriangle size={12} />
                        <span className="text-xs">No remote configured</span>
                    </div>
                    <button
                        onClick={handleAddRemote}
                        disabled={actionLoading}
                        className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 rounded text-xs text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-50"
                    >
                        <GitBranch size={12} />
                        Add Remote
                    </button>
                </div>
            );
        }

        // Show indicator when git is set up but no commits exist yet
        if (status.hasCommits === false) {
            return (
                <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-amber-500">
                        <GitBranch size={12} />
                        <span className="text-xs">No commits yet</span>
                    </div>
                    {status.remoteUrl && (
                        <a
                            href={status.remoteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-cyan-500 hover:text-cyan-400 transition-colors"
                        >
                            <ExternalLink size={10} />
                            <span className="truncate">{status.remoteUrl.replace('https://github.com/', '')}</span>
                        </a>
                    )}
                </div>
            );
        }

        return (
            <div className="space-y-1.5">
                {/* Status badges row */}
                <div className="flex items-center gap-2">
                    {status.uncommittedCount !== undefined && status.uncommittedCount > 0 && (
                        <button
                            onClick={handleCommitAndPush}
                            disabled={actionLoading}
                            className="flex items-center gap-1 text-xs text-orange-400 hover:text-orange-300 transition-colors group/commit"
                            title="Click to commit and push"
                        >
                            <span className="px-1.5 py-0.5 rounded bg-orange-500/20 font-mono group-hover/commit:bg-orange-500/30">
                                {status.uncommittedCount}
                            </span>
                            <span>uncommitted</span>
                            <Upload size={10} className="opacity-0 group-hover/commit:opacity-100 transition-opacity" />
                        </button>
                    )}

                    {/* Ahead/behind sync status */}
                    {(status.ahead > 0 || status.behind > 0) && (
                        <span className="flex items-center gap-1 text-xs font-mono">
                            {status.ahead > 0 && <span className="text-green-400">↑{status.ahead}</span>}
                            {status.behind > 0 && <span className="text-red-400">↓{status.behind}</span>}
                        </span>
                    )}
                </div>

                {/* Git info row */}
                <div className="flex items-center gap-2 text-emerald-400">
                    <GitBranch size={12} />
                    {status.latest_commit ? (
                        <>
                            <span className="font-mono">{status.latest_commit.hash.substring(0, 7)}</span>
                            <span className="text-slate-500">•</span>
                            <span className="text-slate-400">{status.current}</span>
                        </>
                    ) : (
                        <span className="text-slate-400">{status.current || 'main'}</span>
                    )}
                </div>

                {/* Commit message */}
                {status.latest_commit && (
                    <p className="text-slate-500 truncate text-xs" title={status.latest_commit.message}>
                        {status.latest_commit.message}
                    </p>
                )}

                {/* Remote URL */}
                {status.remoteUrl && (
                    <a
                        href={status.remoteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-cyan-500 hover:text-cyan-400 transition-colors"
                    >
                        <ExternalLink size={10} />
                        <span className="truncate">{status.remoteUrl.replace('https://github.com/', '')}</span>
                    </a>
                )}
            </div>
        );
    };

    return (
        <div className="group relative overflow-hidden rounded-lg border border-slate-800 bg-gradient-to-br from-slate-900/90 to-slate-950/90 p-5 hover:border-slate-700/80 transition-all hover:shadow-lg hover:shadow-indigo-500/5 flex flex-col h-full">
            {/* Pin button */}
            <button
                onClick={handlePinToggle}
                disabled={pinLoading}
                className={`absolute top-3 right-3 p-1.5 rounded-full transition-all ${isPinned
                    ? 'text-yellow-400 bg-yellow-500/20'
                    : 'text-slate-500 hover:text-slate-300 opacity-0 group-hover:opacity-100'
                    } disabled:opacity-50`}
                title={isPinned ? 'Unpin project' : 'Pin project'}
            >
                <Star size={16} fill={isPinned ? 'currentColor' : 'none'} />
            </button>

            {/* Main card content - link to project page */}
            <Link href={`/project/${project.id}`} className="block flex-grow">
                {/* Header */}
                <div className="flex items-start gap-3 mb-3 pr-8">
                    <div className="p-2 rounded-lg bg-gradient-to-br from-indigo-500/20 to-purple-500/20 text-indigo-400 flex-shrink-0">
                        <Folder size={20} />
                    </div>
                    <div className="min-w-0">
                        <h3 className="font-semibold text-white truncate group-hover:text-indigo-300 transition-colors">
                            {project.name}
                        </h3>
                        <span className="text-xs text-slate-500 uppercase tracking-wider">
                            {project.type}
                        </span>
                    </div>
                </div>

                {/* Description */}
                {project.description && (
                    <p className="text-sm text-slate-400 line-clamp-2 mb-3">
                        {project.description}
                    </p>
                )}

                {/* Review status */}
                {pendingReviews > 0 && (
                    <div className="mb-3">
                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-amber-500/10 text-amber-400 text-xs border border-amber-500/20">
                            <Activity size={12} />
                            <span>{pendingReviews} docs needing review</span>
                        </span>
                    </div>
                )}

                {/* Deploy status badge */}
                {deployStatus && (
                    <div className="mb-3">
                        {deployStatus.isUp === true ? (
                            <span
                                onClick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    window.open(project.urls?.production, '_blank');
                                }}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-green-500/10 text-green-400 text-xs hover:bg-green-500/20 transition-colors cursor-pointer"
                            >
                                <Activity size={12} className="animate-pulse" />
                                <span>Live</span>
                            </span>
                        ) : deployStatus.isUp === false ? (
                            <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-red-500/10 text-red-400 text-xs">
                                <XCircle size={12} />
                                <span>Down</span>
                            </div>
                        ) : deployStatus.error ? (
                            <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-amber-500/10 text-amber-400 text-xs">
                                <AlertTriangle size={12} />
                                <span>Error</span>
                            </div>
                        ) : null}
                    </div>
                )}

                {/* URLs */}
                {project.urls && (
                    <div className="flex flex-wrap gap-2 mb-3">
                        {project.urls.production && (
                            <span
                                onClick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    window.open(project.urls?.production, '_blank');
                                }}
                                className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer"
                            >
                                <Globe size={12} />
                                <span>Production</span>
                            </span>
                        )}
                    </div>
                )}
            </Link>

            {/* Non-clickable footer section - outside the Link */}
            <div className="mt-auto" onClick={(e) => e.stopPropagation()}>
                {/* Stack badges */}
                {project.stack && (
                    <div className="flex items-center gap-2 text-xs text-slate-400 mt-1">
                        <Layers size={14} className="text-slate-500" />
                        <span>
                            {Object.values(project.stack).join(" • ")}
                        </span>
                    </div>
                )}

                <div className="mt-auto pt-4 border-t border-slate-800">
                    <div className="min-h-[4rem] text-xs">
                        {getGitStateDisplay()}
                    </div>
                </div>
            </div>
        </div>
    );
}
