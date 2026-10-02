"use client";

/**
 * Deliverables on the task screen, placed under the title: every document the
 * registry holds for this task (its own documents and those handed to it by a
 * receipt), each with its purpose, current version, the document's own review
 * status and a direct Open into the shared reviewer (/documents/<id>). These
 * are the same registry records the Reviews queue and project Deliverables
 * show; nothing is copied. Renders nothing when a task has no registered
 * documents, so it is safe on every task.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, FileCheck2, Loader2 } from "lucide-react";
import { countDocuments, listDocumentsPage, type DocumentPage } from "@/lib/document-review";
import { DeliverableRow } from "@/components/document-review/deliverable-row";

const POLL_MS = 30_000;
const PANEL_LIMIT = 50;

export function ReviewDocumentsPanel({ taskId, projectId }: { taskId: string; projectId?: string | null }) {
    const [page, setPage] = useState<DocumentPage | null>(null);
    const [pending, setPending] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const next = await listDocumentsPage({ task_id: taskId, status: "all", limit: PANEL_LIMIT });
            setPage(next);
            setError(null);
            // The pending number comes from the server's count, not from this
            // page, so it stays true past the first PANEL_LIMIT documents.
            setPending(next.legacy || next.total === 0 ? null : await countDocuments({ task_id: taskId }).then((c) => c.needs_review, () => null));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load documents");
        }
    }, [taskId]);

    useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(), POLL_MS);
        return () => window.clearInterval(timer);
    }, [load]);

    const documents = page?.documents ?? [];
    if (!error && documents.length === 0) return null;

    const queueHref = `/documents?status=all&task_id=${encodeURIComponent(taskId)}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ""}`;

    return (
        <section className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-4" data-review-documents-panel="">
            <div className="mb-1 flex flex-wrap items-center gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-cyan-100">
                    <FileCheck2 size={15} /> Deliverables
                </h3>
                {typeof pending === "number" && pending > 0 && (
                    <span className="rounded-full border border-amber-400/50 bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200" data-deliverables-pending="">
                        {pending} awaiting your review
                    </span>
                )}
                {page && page.total > documents.length && (
                    <Link href={queueHref} className="ml-auto inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:underline">
                        All {page.total} in Reviews <ArrowRight size={11} />
                    </Link>
                )}
            </div>
            <p className="mb-3 text-[11px] text-cyan-100/60">
                Documents this task delivered. The badge is your decision on each document; the task status and QA verdicts on this page are about the work, not the document.
            </p>
            {error && (
                <div role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
                    <button type="button" onClick={() => void load()} className="ml-auto underline">Retry</button>
                </div>
            )}
            {page === null && !error ? (
                <Loader2 size={16} className="animate-spin text-cyan-300" />
            ) : (
                <ul className="space-y-2">
                    {documents.map((entry) => (
                        <DeliverableRow key={entry.id} entry={entry} showTask={false} showProject={false} />
                    ))}
                </ul>
            )}
        </section>
    );
}
