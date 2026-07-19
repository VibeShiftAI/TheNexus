"use client"

import { useEffect, useMemo, useState } from "react";
import {
    Project, ProjectPulse, PulseGit, getProjectStatus, GitStatus, initGitRepo, addGitRemote,
    pingProject, PingResult, pinProject, unpinProject, commitAndPush, generateCommitMessage,
} from "@/lib/nexus";
import { GitBranch, Zap, AlertTriangle, ExternalLink, Star, Upload, Tag, ListTodo, Eye, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { CornerBrackets } from "@/components/bridge/hud";
import { PulseSparkline, ActivityLed, CrewChip, timeAgo, activityBand, BAND_STYLES } from "@/components/pulse-visuals";

interface ProjectCardProps {
    pendingReviews?: number;
    project: Project;
    pulse?: ProjectPulse;
    isPinned?: boolean;
    onPinChange?: (id: string, pinned: boolean) => void;
}

/** Best-effort hostname for a compact link label; falls back to the raw string on parse failure. */
function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return url;
    }
}

/** Map a fresh per-card GitStatus (post git-action refresh) onto the pulse git shape. */
function gitFromStatus(s: GitStatus, prev: PulseGit | null): PulseGit {
    return {
        hasGit: s.hasGit,
        hasRemote: s.hasRemote,
        hasCommits: s.hasCommits ?? Boolean(s.latest_commit),
        remoteUrl: s.remoteUrl,
        branch: s.current,
        uncommitted: s.uncommittedCount ?? 0,
        ahead: s.ahead ?? 0,
        behind: s.behind ?? 0,
        lastCommit: s.latest_commit
            ? { hash: s.latest_commit.hash, message: s.latest_commit.message, date: s.latest_commit.date }
            : null,
        series: prev?.series ?? [],
        total: prev?.total ?? 0,
    };
}

export function ProjectCard({ project, pulse, isPinned = false, onPinChange, pendingReviews = 0 }: ProjectCardProps) {
    const [actionLoading, setActionLoading] = useState(false);
    const [deployStatus, setDeployStatus] = useState<PingResult | null>(null);
    const [pinLoading, setPinLoading] = useState(false);
    // Git actions (init / remote / push) refresh just this card without
    // waiting out the batched pulse cache.
    const [gitOverride, setGitOverride] = useState<PulseGit | null>(null);

    const git = gitOverride ?? pulse?.git ?? null;
    const band = activityBand(pulse?.lastActivityAt);
    const bandStyle = BAND_STYLES[band];
    const lastSeen = timeAgo(pulse?.lastActivityAt);

    useEffect(() => {
        if (project.urls?.production) {
            pingProject(project.id).then(setDeployStatus).catch(console.error);
        }
    }, [project.id, project.urls?.production]);

    const refreshGit = async () => {
        try {
            const status = await getProjectStatus(project.id);
            setGitOverride(prev => gitFromStatus(status, prev ?? pulse?.git ?? null));
        } catch (e) {
            console.error("Failed to refresh git status for", project.name, e);
        }
    };

    const handleInitGit = async () => {
        setActionLoading(true);
        try {
            await initGitRepo(project.id);
            await refreshGit();
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
            await refreshGit();
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
            const result = await generateCommitMessage(project.id);
            await commitAndPush(project.id, result.message);
            await refreshGit();
        } catch (e) {
            console.error("Failed to commit and push:", e);
            alert("Failed to commit and push: " + (e instanceof Error ? e.message : "Unknown error"));
        } finally {
            setActionLoading(false);
        }
    };

    // Ops chips — only render signals that are non-zero so quiet projects stay quiet.
    const opsChips = useMemo(() => {
        if (!pulse) return [];
        const chips: { key: string; icon: React.ReactNode; label: string; cls: string; title: string }[] = [];
        const t = pulse.tasks;
        if (t.active > 0) chips.push({
            key: "active", icon: <Zap size={10} />, label: `${t.active} active`,
            cls: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300", title: t.activeNames.join("\n"),
        });
        if (t.attention > 0) chips.push({
            key: "attention", icon: <AlertTriangle size={10} />, label: `${t.attention} need input`,
            cls: "border-amber-500/40 bg-amber-500/10 text-amber-300", title: "Tasks blocked or awaiting input",
        });
        if (t.review + pendingReviews > 0) chips.push({
            key: "review", icon: <Eye size={10} />, label: `${t.review + pendingReviews} in review`,
            cls: "border-purple-500/40 bg-purple-500/10 text-purple-300", title: "Awaiting review",
        });
        if (t.done7d > 0) chips.push({
            key: "done", icon: <CheckCircle2 size={10} />, label: `${t.done7d} done/7d`,
            cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", title: "Tasks completed in the last 7 days",
        });
        if (chips.length === 0 && t.queued > 0) chips.push({
            key: "queued", icon: <ListTodo size={10} />, label: `${t.queued} queued`,
            cls: "border-slate-700 bg-slate-800/60 text-slate-400", title: "Backlog",
        });
        return chips;
    }, [pulse, pendingReviews]);

    const gitFooter = () => {
        if (!pulse && !gitOverride) {
            return (
                <div className="flex items-center gap-2 text-slate-600">
                    <div className="h-3 w-3 animate-spin rounded-full border border-slate-600 border-t-transparent" />
                    <span className="text-[11px] uppercase tracking-wider">scanning…</span>
                </div>
            );
        }
        if (!git?.hasGit) {
            return (
                <button
                    onClick={handleInitGit}
                    disabled={actionLoading}
                    className="flex items-center gap-2 rounded border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:bg-slate-700 hover:text-white disabled:opacity-50"
                >
                    <Zap size={11} />
                    Initialize Git
                </button>
            );
        }
        if (!git.hasRemote) {
            return (
                <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[11px] text-amber-400">
                        <AlertTriangle size={11} />
                        No remote
                    </span>
                    <button
                        onClick={handleAddRemote}
                        disabled={actionLoading}
                        className="flex items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
                    >
                        <GitBranch size={11} />
                        Add Remote
                    </button>
                </div>
            );
        }
        return (
            <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                <span className="flex min-w-0 items-center gap-1.5 text-slate-400">
                    <GitBranch size={11} className="shrink-0 text-emerald-400" />
                    <span className="truncate" title={git.lastCommit?.message}>
                        {git.branch || "main"}
                        {git.lastCommit && (
                            <span className="text-slate-600"> @{git.lastCommit.hash.substring(0, 7)}</span>
                        )}
                    </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                    {(git.ahead > 0 || git.behind > 0) && (
                        <span>
                            {git.ahead > 0 && <span className="text-emerald-400">↑{git.ahead}</span>}
                            {git.behind > 0 && <span className="text-red-400">↓{git.behind}</span>}
                        </span>
                    )}
                    {git.uncommitted > 0 ? (
                        <button
                            onClick={handleCommitAndPush}
                            disabled={actionLoading}
                            title={`${git.uncommitted} uncommitted file(s) — click to commit & push`}
                            className="group/commit flex items-center gap-1 rounded border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 text-orange-300 transition-colors hover:bg-orange-500/25 disabled:opacity-50"
                        >
                            {actionLoading
                                ? <span className="h-2.5 w-2.5 animate-spin rounded-full border border-orange-300 border-t-transparent" />
                                : <Upload size={10} />}
                            {git.uncommitted}
                        </button>
                    ) : (
                        <span className="text-emerald-500/80" title="Working tree clean">clean</span>
                    )}
                    {git.remoteUrl && (
                        <a
                            href={git.remoteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-500 transition-colors hover:text-cyan-400"
                            title={git.remoteUrl.replace('https://github.com/', '')}
                        >
                            <ExternalLink size={11} />
                        </a>
                    )}
                </span>
            </div>
        );
    };

    const isHot = band === "hot";

    return (
        <div
            className={`hud-scanlines group relative flex h-full flex-col overflow-hidden rounded-lg border bg-gradient-to-br from-slate-900/80 to-slate-950/90 p-4 transition-all
                ${isHot ? "border-cyan-500/25 hover:border-cyan-400/50 hover:shadow-[0_0_24px_rgba(34,211,238,0.12)]" : "border-slate-800 hover:border-slate-600 hover:shadow-lg hover:shadow-cyan-500/5"}
                ${band === "dormant" ? "opacity-75 hover:opacity-100" : ""}`}
        >
            <CornerBrackets accent={isHot ? "cyan" : "teal"} />
            {/* top hairline glow, brighter on hot projects */}
            <span className={`pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent to-transparent ${isHot ? "via-cyan-400/60" : "via-slate-500/30"}`} />

            {/* Pin */}
            <button
                onClick={handlePinToggle}
                disabled={pinLoading}
                className={`absolute right-2.5 top-2.5 z-10 rounded-full p-1.5 transition-all ${isPinned
                    ? "bg-yellow-500/20 text-yellow-400"
                    : "text-slate-500 opacity-0 hover:text-slate-300 group-hover:opacity-100"
                    } disabled:opacity-50`}
                title={isPinned ? "Unpin project" : "Pin project"}
            >
                <Star size={14} fill={isPinned ? "currentColor" : "none"} />
            </button>

            <Link href={`/project/${project.id}`} className="block flex-grow">
                {/* Designation row */}
                <div className="mb-1 flex items-center gap-2 pr-7">
                    <ActivityLed band={band} />
                    <h3 className="truncate text-sm font-bold tracking-tight text-white transition-colors group-hover:text-cyan-300">
                        {project.name}
                    </h3>
                </div>
                <div className="mb-2.5 flex items-center gap-2 pl-4 text-[10px] uppercase tracking-widest">
                    <span className="text-slate-500">{project.type}</span>
                    <span className={`${bandStyle.text} font-semibold`}>{bandStyle.label}</span>
                    {lastSeen && <span className="font-mono normal-case text-slate-600">Δ {lastSeen}</span>}
                    {project.urls?.production && (
                        <span
                            onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                window.open(project.urls?.production, "_blank", "noopener,noreferrer");
                            }}
                            className="flex cursor-pointer items-center gap-1 text-slate-400 hover:text-cyan-300"
                            title={project.urls.production}
                        >
                            {deployStatus?.isUp === true && (
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.9)]" title="Live" />
                            )}
                            {deployStatus?.isUp === false && (
                                <span className="h-1.5 w-1.5 rounded-full bg-red-400" title="Production URL unreachable" />
                            )}
                            <span className="max-w-[110px] truncate normal-case">{hostnameOf(project.urls.production)}</span>
                            <ExternalLink size={10} />
                        </span>
                    )}
                </div>

                {/* Description */}
                {project.description && (
                    <p className="mb-3 line-clamp-2 text-xs leading-relaxed text-slate-400">
                        {project.description}
                    </p>
                )}

                {/* 14-day tempo */}
                <div className="mb-2.5">
                    <div className="mb-0.5 flex items-baseline justify-between">
                        <span className="text-[9px] uppercase tracking-widest text-slate-600">Tempo · 14d</span>
                        <span className="font-mono text-[10px] text-slate-500">
                            {pulse ? `${pulse.git.total} commits` : "—"}
                        </span>
                    </div>
                    {pulse ? (
                        <PulseSparkline series={pulse.git.series} color={bandStyle.bar} height={22} />
                    ) : (
                        <div className="h-[22px] w-full animate-pulse rounded bg-slate-800/50" />
                    )}
                </div>

                {/* Ops + crew */}
                {(opsChips.length > 0 || pulse?.crew.last || (pulse?.crew.running ?? 0) > 0) && (
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        {opsChips.map(c => (
                            <span
                                key={c.key}
                                title={c.title}
                                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${c.cls}`}
                            >
                                {c.icon}
                                {c.label}
                            </span>
                        ))}
                        {pulse && <CrewChip crew={pulse.crew} />}
                    </div>
                )}
            </Link>

            {/* Footer — git console line + knowledge tags */}
            <div className="mt-auto" onClick={(e) => e.stopPropagation()}>
                {/* Knowledge-need tags. Array.isArray, not truthiness: an API
                    server that predates the tags migration serves the raw TEXT
                    column ("[]"), and a non-empty string passes a length check
                    but has no .map (crashed every card on 2026-07-10). */}
                {Array.isArray(project.tags) && project.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                        {project.tags.slice(0, 3).map(tag => (
                            <span key={tag} className="flex items-center gap-1 rounded border border-slate-800 bg-slate-900/80 px-1.5 py-0.5 text-[10px] text-slate-500">
                                <Tag size={9} />
                                {tag}
                            </span>
                        ))}
                        {project.tags.length > 3 && (
                            <span className="px-1 py-0.5 text-[10px] text-slate-600" title={project.tags.slice(3).join(", ")}>
                                +{project.tags.length - 3}
                            </span>
                        )}
                    </div>
                )}

                <div className="mt-3 border-t border-slate-800/80 pt-2.5">
                    {gitFooter()}
                </div>
            </div>
        </div>
    );
}
