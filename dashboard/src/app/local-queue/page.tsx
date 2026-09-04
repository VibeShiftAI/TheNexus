"use client";

import { useMemo, useState, useCallback } from "react";
import { useLiveRefetch } from "@/components/live-board-state";

import Link from "next/link";
import { ArrowLeft, CalendarDays, Clock, ListRestart, RefreshCw } from "lucide-react";
import {
    getLocalLlmQueue,
    type LocalLlmJob,
    type LocalLlmQueueState,
} from "@/lib/nexus";

const STATUS_CLASS: Record<string, string> = {
    queued: "border-sky-500/30 bg-sky-500/10 text-sky-200",
    running: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    succeeded: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    failed: "border-red-500/30 bg-red-500/10 text-red-200",
    cancelled: "border-slate-600 bg-slate-800 text-slate-300",
    paused: "border-violet-500/30 bg-violet-500/10 text-violet-200",
};

const SOURCE_CLASS: Record<string, string> = {
    knowledge_intake_read: "border-cyan-500/30 bg-cyan-500/10 text-cyan-200",
    knowledge_journal: "border-violet-500/30 bg-violet-500/10 text-violet-200",
    nightly_synthesis: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200",
    lars_analysis: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    stock_analysis: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    trade_reflection: "border-orange-500/30 bg-orange-500/10 text-orange-200",
    youtube_story_batch: "border-rose-500/30 bg-rose-500/10 text-rose-200",
    ad_hoc_local_prompt: "border-blue-500/30 bg-blue-500/10 text-blue-200",
};

function formatDate(value?: string): string {
    if (!value) return "not set";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
}

function sortedJobs(jobs: LocalLlmJob[]): LocalLlmJob[] {
    return [...jobs].sort((a, b) => {
        const statusOrder = ["running", "queued", "failed", "cancelled", "succeeded"];
        const statusDelta = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status);
        if (statusDelta !== 0) return statusDelta;
        if (a.priority !== b.priority) return a.priority - b.priority;
        return (a.scheduledFor ?? a.createdAt).localeCompare(b.scheduledFor ?? b.createdAt);
    });
}

export default function LocalQueuePage() {
    const [queue, setQueue] = useState<LocalLlmQueueState | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadQueue = useCallback(async () => {
        try {
            const data = await getLocalLlmQueue();
            setQueue(data);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load queue");
        } finally {
            setLoading(false);
        }
    }, []);

    // D-1: the local-LLM queue is Nexus-side state with no stream frame behind
    // it — poll only, routed through the shared mechanism.
    useLiveRefetch([], loadQueue, { fallbackPollMs: 5_000 });

    const jobs = useMemo(() => sortedJobs(queue?.jobs ?? []), [queue]);
    const activeJobs = jobs.filter((job) => job.status === "running" || job.status === "queued").length;

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200">
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <Link href="/" className="p-2 rounded-full hover:bg-slate-800 text-slate-400 hover:text-white transition-colors">
                            <ArrowLeft size={20} />
                        </Link>
                        <div>
                            <h1 className="text-xl font-bold tracking-tight text-white">LOCAL LLM QUEUE</h1>
                            <p className="text-xs text-slate-500">Praxis-managed queue with calendar-backed history.</p>
                        </div>
                    </div>
                    <button
                        onClick={loadQueue}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 text-slate-300 hover:border-cyan-500 hover:text-cyan-300"
                        title="Refresh"
                    >
                        <RefreshCw size={16} />
                    </button>
                </div>
            </header>

            <div className="container mx-auto space-y-6 p-6">
                <section className="grid gap-4 lg:grid-cols-3">
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                        <div className="mb-2 flex items-center gap-2 text-slate-400">
                            <ListRestart size={16} />
                            <span className="text-xs font-semibold uppercase tracking-wide">Queue</span>
                        </div>
                        <div className="text-2xl font-semibold text-white">{jobs.length}</div>
                        <p className="text-sm text-slate-500">{activeJobs} queued or running</p>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                        <div className="mb-2 flex items-center gap-2 text-slate-400">
                            <Clock size={16} />
                            <span className="text-xs font-semibold uppercase tracking-wide">Worker Flag</span>
                        </div>
                        <span className={`inline-flex rounded border px-2 py-1 text-xs ${queue?.worker.paused ? STATUS_CLASS.paused : STATUS_CLASS.succeeded}`}>
                            {queue?.worker.paused ? "paused" : "ready"}
                        </span>
                        <p className="mt-2 text-sm text-slate-500">{queue?.worker.pauseReason || "Ready for the worker when execution is enabled."}</p>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                        <div className="mb-2 flex items-center gap-2 text-slate-400">
                            <CalendarDays size={16} />
                            <span className="text-xs font-semibold uppercase tracking-wide">Calendar</span>
                        </div>
                        <div className="text-2xl font-semibold text-white">
                            {jobs.filter((job) => job.calendarEventId).length}
                        </div>
                        <p className="text-sm text-slate-500">jobs linked to calendar history</p>
                    </div>
                </section>

                <section className="rounded-lg border border-slate-800 bg-slate-900/40">
                    <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <ListRestart size={18} className="text-cyan-300" />
                            <h2 className="font-semibold text-white">Jobs</h2>
                        </div>
                        <span className="text-sm text-slate-500">{jobs.length} total</span>
                    </div>

                    {error && (
                        <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
                    )}

                    {loading ? (
                        <div className="p-8 text-center text-slate-500">Loading queue...</div>
                    ) : jobs.length === 0 ? (
                        <div className="p-8 text-center text-slate-500">No local jobs queued.</div>
                    ) : (
                        <div className="divide-y divide-slate-800">
                            {jobs.map((job) => (
                                <div key={job.id} className="grid gap-3 px-4 py-4 lg:grid-cols-[1fr_auto]">
                                    <div>
                                        <div className="mb-2 flex flex-wrap items-center gap-2">
                                            <span className={`rounded border px-2 py-1 text-xs ${STATUS_CLASS[job.status] || STATUS_CLASS.cancelled}`}>
                                                {job.status}
                                            </span>
                                            <span className={`rounded border px-2 py-1 text-xs ${SOURCE_CLASS[job.type] || SOURCE_CLASS.ad_hoc_local_prompt}`}>
                                                {job.type}
                                            </span>
                                            <span className="font-mono text-sm text-slate-300">{job.id}</span>
                                        </div>
                                        <div className="grid gap-2 text-xs text-slate-500 sm:grid-cols-4">
                                            <span>Priority: {job.priority}</span>
                                            <span>Attempts: {job.attempts}/{job.maxAttempts}</span>
                                            <span>Scheduled: {formatDate(job.scheduledFor)}</span>
                                            <span>Calendar: {job.calendarEventId ? job.calendarEventId.slice(0, 8) : "not linked"}</span>
                                        </div>
                                        {job.result && <p className="mt-2 text-sm text-emerald-300">{job.result}</p>}
                                        {job.error && <p className="mt-2 text-sm text-red-300">{job.error}</p>}
                                    </div>
                                    <div className="text-right text-xs text-slate-500">
                                        <div>Created</div>
                                        <div>{formatDate(job.createdAt)}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </main>
    );
}
