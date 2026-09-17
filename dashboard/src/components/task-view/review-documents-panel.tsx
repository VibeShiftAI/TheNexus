"use client";

/**
 * "Documents for review" on the task screen: every Markdown document the
 * API has registered against this task, with the reviewer's own state and a
 * link into the shared document reviewer (/documents/<id>). Renders nothing
 * when a task has no registered documents, so it is safe on every task.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, FileText, Loader2 } from "lucide-react";
import { documentHref, listTaskDocuments, reviewStateLabel, type DocumentListEntry } from "@/lib/document-review";

const POLL_MS = 30_000;

export function ReviewDocumentsPanel({ taskId }: { taskId: string }) {
    const [documents, setDocuments] = useState<DocumentListEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const list = await listTaskDocuments(taskId);
            setDocuments(list);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load documents");
        }
    }, [taskId]);

    useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(), POLL_MS);
        return () => window.clearInterval(timer);
    }, [load]);

    if (!error && (!documents || documents.length === 0)) return null;

    return (
        <section className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-4" data-review-documents-panel="">
            <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-cyan-100">
                <FileText size={15} /> Documents for review
            </h3>
            <p className="mb-3 text-[11px] text-cyan-100/60">
                Open the full document, comment on passages, and finish the review to send your feedback to Praxis.
            </p>
            {error && (
                <div role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
                    <button type="button" onClick={() => void load()} className="ml-auto underline">Retry</button>
                </div>
            )}
            {documents === null && !error ? (
                <Loader2 size={16} className="animate-spin text-cyan-300" />
            ) : (
                <ul className="space-y-2">
                    {(documents || []).map((entry) => {
                        const label = reviewStateLabel(entry);
                        return (
                            <li key={entry.id} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2" data-document-id={entry.id}>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium text-slate-100">{entry.title}</div>
                                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                                        <span className="uppercase tracking-wide">{entry.kind}</span>
                                        {entry.current_revision?.captured_at && (
                                            <span>rev {entry.current_revision.content_hash.slice(0, 8)} · {new Date(entry.current_revision.captured_at).toLocaleString()}</span>
                                        )}
                                        <span className={`rounded-full border px-2 py-0.5 ${label.tone}`}>{label.text}</span>
                                    </div>
                                </div>
                                <Link
                                    href={documentHref(entry.id)}
                                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-colors hover:bg-cyan-500/20"
                                >
                                    Review document <ArrowRight size={13} />
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
