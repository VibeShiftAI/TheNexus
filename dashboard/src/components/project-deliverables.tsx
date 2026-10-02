"use client";

/**
 * Deliverables on the project screen: every document the registry holds for
 * this project (its own documents and those linked to it by a registration
 * receipt), filtered by review status with the server's counts and paged by
 * the server. The rows are the same registry records the Reviews queue and
 * task Deliverables show, and Open goes to the one shared reviewer, so a
 * project never keeps a parallel copy of a document.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, ChevronLeft, ChevronRight, FileCheck2, Loader2 } from "lucide-react";
import { HudPanel } from "@/components/bridge/hud";
import { DeliverableRow } from "@/components/document-review/deliverable-row";
import { countDocuments, listDocumentsPage, stepBackOffset, type DocumentCounts, type DocumentPage, type DocumentStatusFilter } from "@/lib/document-review";

const POLL_MS = 30_000;
const PAGE_SIZE = 10;

const TABS: { key: DocumentStatusFilter; label: string }[] = [
    { key: "needs_review", label: "Needs your review" },
    { key: "changes_requested", label: "Changes requested" },
    { key: "approved", label: "Approved" },
    { key: "all", label: "All" },
];

export function ProjectDeliverables({ projectId }: { projectId: string }) {
    // Opens on what needs Robert when anything does, otherwise on everything.
    const [status, setStatus] = useState<DocumentStatusFilter | null>(null);
    const [offset, setOffset] = useState(0);
    const [page, setPage] = useState<DocumentPage | null>(null);
    const [counts, setCounts] = useState<DocumentCounts | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const seq = useRef(0);

    const load = useCallback(async () => {
        const mine = ++seq.current;
        setLoading(true);
        try {
            const nextCounts = await countDocuments({ project_id: projectId }).catch(() => null);
            const effective = status ?? (nextCounts && nextCounts.needs_review > 0 ? "needs_review" : "all");
            const nextPage = await listDocumentsPage({ project_id: projectId, status: effective, limit: PAGE_SIZE, offset });
            if (mine !== seq.current) return;
            setCounts(nextPage.legacy ? null : nextCounts);
            setPage(nextPage);
            if (status === null) setStatus(effective);
            setError(null);
        } catch (err) {
            if (mine === seq.current) setError(err instanceof Error ? err.message : "Failed to load deliverables");
        } finally {
            if (mine === seq.current) setLoading(false);
        }
    }, [projectId, status, offset]);

    useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(), POLL_MS);
        return () => window.clearInterval(timer);
    }, [load]);

    // A decision can empty the page being shown (the poll then reloads the
    // old offset): step back to the last page that still has deliverables,
    // as the Reviews queue does, rather than calling the view empty.
    const stepBack = stepBackOffset(page, PAGE_SIZE);
    useEffect(() => {
        if (stepBack === null) return;
        setOffset((prev) => (prev > stepBack ? stepBack : prev));
    }, [stepBack]);

    const documents = page?.documents ?? [];
    const total = page?.total ?? 0;
    const legacy = Boolean(page?.legacy);
    const activeStatus = status ?? "all";
    const queueHref = `/documents?status=${activeStatus}&project_id=${encodeURIComponent(projectId)}`;

    return (
        <HudPanel
            icon={<FileCheck2 size={16} />}
            title="Deliverables"
            accent="cyan"
            headerRight={
                <Link href={queueHref} className="inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:underline">
                    Open in Reviews <ArrowRight size={11} />
                </Link>
            }
        >
            <div data-project-deliverables="">
                {!legacy && (
                    <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Deliverable status">
                        {TABS.map((tab) => {
                            const count = counts ? counts[tab.key] : null;
                            return (
                                <button
                                    key={tab.key}
                                    type="button"
                                    aria-pressed={activeStatus === tab.key}
                                    onClick={() => { setStatus(tab.key); setOffset(0); }}
                                    data-status-tab={tab.key}
                                    className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${activeStatus === tab.key ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-100" : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200"}`}
                                >
                                    {tab.label}
                                    {typeof count === "number" && <span className="ml-1 tabular-nums" data-status-count="">{count}</span>}
                                </button>
                            );
                        })}
                    </div>
                )}
                {legacy && (
                    <p role="status" className="mb-2 text-[11px] text-amber-200">Review status and counts are unavailable until the Nexus API restarts on the new registry.</p>
                )}
                {error && (
                    <div role="alert" className="mb-2 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
                        <button type="button" onClick={() => void load()} className="ml-auto underline">Retry</button>
                    </div>
                )}
                {page === null && !error ? (
                    <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={14} className="animate-spin text-cyan-300" /> Loading deliverables…</div>
                ) : page === null ? null : stepBack !== null ? (
                    error ? null : (
                        <div role="status" className="flex items-center gap-2 text-xs text-slate-400" data-documents-stepping-back="">
                            <Loader2 size={14} className="animate-spin text-cyan-300" /> This page emptied; loading the last page of the {total} remaining…
                        </div>
                    )
                ) : documents.length === 0 ? (
                    <p className="text-xs text-slate-500" data-documents-empty="">
                        {counts && counts.all === 0 ? "No registered deliverables for this project yet." : activeStatus === "needs_review" ? "Nothing in this project is waiting for your review." : "No deliverables in this view."}
                    </p>
                ) : (
                    <>
                        <ul className="space-y-2" aria-busy={loading}>
                            {documents.map((entry) => <DeliverableRow key={entry.id} entry={entry} showProject={false} />)}
                        </ul>
                        {!legacy && total > PAGE_SIZE && (
                            <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-slate-500" data-documents-pager="">
                                <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))} className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-slate-300 disabled:opacity-40">
                                    <ChevronLeft size={12} /> Previous
                                </button>
                                <span>{page.offset + 1}–{page.offset + documents.length} of {total}</span>
                                <button type="button" disabled={!page.has_more || loading} onClick={() => setOffset((o) => o + PAGE_SIZE)} className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-slate-300 disabled:opacity-40">
                                    Next <ChevronRight size={12} />
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>
        </HudPanel>
    );
}
