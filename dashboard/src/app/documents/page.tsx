"use client";

/**
 * Documents for review — /documents.
 *
 * The Dashboard's own entry point to every Markdown document the Nexus API
 * has registered (reports, specs, walkthroughs Praxis asks Robert to read),
 * with his review state for each and a link into the shared reviewer at
 * /documents/<id>. Reached from the navigation menu, from the reviewer's
 * "Documents" crumb, and directly by URL; everything here is a same-origin
 * Next route served through the Dashboard's existing session and /api proxy,
 * so no separate sign-in is ever involved (2026-09-10, task 762637e6).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, ArrowRight, FileText, Loader2, RefreshCw } from "lucide-react";
import { documentHref, listDocuments, reviewStateLabel, type DocumentListEntry } from "@/lib/document-review";

const POLL_MS = 30_000;

type Filter = "all" | "open" | "sent";

const FILTERS: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "open", label: "Needs your review" },
    { key: "sent", label: "Sent to Praxis" },
];

function matchesFilter(entry: DocumentListEntry, filter: Filter): boolean {
    if (filter === "all") return true;
    const submitted = entry.review_state?.status === "submitted";
    return filter === "sent" ? submitted : !submitted;
}

function actionLabel(entry: DocumentListEntry): string {
    const state = entry.review_state;
    if (!state) return "Review document";
    if (state.status === "draft") return "Continue review";
    return "Open review";
}

function fileName(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
}

function formatWhen(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export default function DocumentsPage() {
    const [documents, setDocuments] = useState<DocumentListEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [filter, setFilter] = useState<Filter>("all");

    const load = useCallback(async () => {
        setRefreshing(true);
        try {
            const list = await listDocuments();
            setDocuments(list);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load documents");
        } finally {
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(), POLL_MS);
        return () => window.clearInterval(timer);
    }, [load]);

    const visible = useMemo(() => (documents || []).filter((entry) => matchesFilter(entry, filter)), [documents, filter]);
    const openCount = useMemo(() => (documents || []).filter((entry) => matchesFilter(entry, "open")).length, [documents]);

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200" data-documents-index="">
            <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
                <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <Link href="/" className="flex shrink-0 items-center gap-1.5 text-sm text-slate-400 hover:text-white">
                        <ArrowLeft size={16} /> Bridge
                    </Link>
                    <div className="hidden h-5 w-px bg-slate-700 sm:block" />
                    <div className="min-w-0 flex-1">
                        <h1 className="flex items-center gap-2 text-base font-semibold text-white">
                            <FileText size={16} className="text-cyan-300" /> Documents for review
                        </h1>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                            Reports, specs and walkthroughs Praxis has registered for you. Open one to comment on passages and send your feedback into your Praxis conversation.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void load()}
                        disabled={refreshing}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-60"
                        aria-label="Refresh documents"
                    >
                        <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} /> Refresh
                    </button>
                </div>
            </header>

            <div className="mx-auto max-w-[1100px] px-4 py-5">
                <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter documents">
                    {FILTERS.map((option) => (
                        <button
                            key={option.key}
                            type="button"
                            onClick={() => setFilter(option.key)}
                            aria-pressed={filter === option.key}
                            className={`rounded-full border px-3 py-1 text-xs transition-colors ${filter === option.key ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-100" : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200"}`}
                        >
                            {option.label}
                            {option.key === "open" && documents ? ` (${openCount})` : ""}
                        </button>
                    ))}
                </div>

                {error && (
                    <div role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
                        <button type="button" onClick={() => void load()} className="ml-auto underline">Retry</button>
                    </div>
                )}

                {documents === null && !error ? (
                    <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={16} className="animate-spin text-cyan-300" /> Loading documents…</div>
                ) : visible.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500" data-documents-empty="">
                        {documents && documents.length > 0
                            ? "Nothing matches this filter."
                            : "No documents registered yet. When Praxis has a report for you to review, it appears here and in your Praxis conversation."}
                    </div>
                ) : (
                    <ul className="space-y-2">
                        {visible.map((entry) => {
                            const label = reviewStateLabel(entry);
                            const href = documentHref(entry.id);
                            const captured = formatWhen(entry.current_revision?.captured_at);
                            return (
                                <li key={entry.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5" data-document-id={entry.id}>
                                    <div className="min-w-0 flex-1">
                                        <Link href={href} className="block truncate text-sm font-medium text-slate-100 hover:text-cyan-200" title={entry.title}>
                                            {entry.title}
                                        </Link>
                                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                                            <span className="uppercase tracking-wide">{entry.kind}</span>
                                            <span className="truncate font-mono" title={entry.path}>{fileName(entry.path)}</span>
                                            {entry.current_revision && (
                                                <span title={entry.current_revision.content_hash}>
                                                    rev {entry.current_revision.content_hash.slice(0, 8)}{captured ? ` · ${captured}` : ""}
                                                </span>
                                            )}
                                            {entry.task_id && (
                                                <Link href={`/task/${encodeURIComponent(entry.task_id)}`} className="text-cyan-300 hover:underline">from task</Link>
                                            )}
                                            {entry.project_id && (
                                                <Link href={`/project/${encodeURIComponent(entry.project_id)}`} className="text-cyan-300 hover:underline">project</Link>
                                            )}
                                            <span className={`rounded-full border px-2 py-0.5 ${label.tone}`}>{label.text}</span>
                                        </div>
                                    </div>
                                    <Link
                                        href={href}
                                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/20"
                                        data-review-link=""
                                    >
                                        {actionLabel(entry)} <ArrowRight size={13} />
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </main>
    );
}
