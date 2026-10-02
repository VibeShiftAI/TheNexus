"use client";

/**
 * The bridge's way into document review: the header's Reviews button with
 * the pending count, and the compact "Ready for your review" section with
 * the newest documents waiting on Robert. Both read one request to the
 * registry (status=needs_review), whose `total` is the server's own count of
 * review-required documents with no decision on their current revision, so
 * the number is the same one the Reviews queue shows. Reference documents
 * never count. Links are relative routes into the app (/documents...), so the
 * Windows and Mac apps stay in their own authenticated session.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, FileCheck2, Loader2 } from "lucide-react";
import { HudPanel } from "@/components/bridge/hud";
import { DeliverableRow } from "@/components/document-review/deliverable-row";
import { listDocumentsPage, type DocumentPage } from "@/lib/document-review";

const POLL_MS = 60_000;
const HOME_ITEMS = 5;

export interface ReviewQueue {
    page: DocumentPage | null;
    error: string | null;
    loading: boolean;
    refresh: () => void;
    /** Pending count when the server could compute it; null while loading, on error, or on a pre-contract API. */
    pending: number | null;
}

export function useReviewQueue(limit = HOME_ITEMS): ReviewQueue {
    const [page, setPage] = useState<DocumentPage | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setPage(await listDocumentsPage({ status: "needs_review", limit }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load reviews");
        } finally {
            setLoading(false);
        }
    }, [limit]);

    useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(), POLL_MS);
        // Coming back from a review (another tab or the reviewer) should show the new count at once.
        const onFocus = () => void load();
        window.addEventListener("focus", onFocus);
        return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
    }, [load]);

    const pending = page && !page.legacy && !error ? page.total : null;
    return { page, error, loading, refresh: () => void load(), pending };
}

/** Header button: always visible on the bridge, including inside the Windows travel shell's single header row. */
export function ReviewsNavButton({ pending }: { pending: number | null }) {
    const label = pending === null ? "Reviews" : `Reviews: ${pending} document${pending === 1 ? "" : "s"} need${pending === 1 ? "s" : ""} your review`;
    return (
        <Link
            href="/documents"
            aria-label={label}
            title={label}
            className="relative flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/50 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:border-cyan-500/50 hover:text-cyan-200"
            data-reviews-nav=""
        >
            <FileCheck2 size={15} className="text-cyan-300" />
            <span className="hidden sm:inline">Reviews</span>
            {typeof pending === "number" && pending > 0 && (
                <span className="min-w-[1.25rem] rounded-full bg-amber-400 px-1.5 text-center text-[10px] font-bold leading-4 text-slate-950 tabular-nums" data-reviews-pending="">
                    {pending > 99 ? "99+" : pending}
                </span>
            )}
        </Link>
    );
}

export function ReadyForReview({ queue, projectNames }: { queue: ReviewQueue; projectNames?: Record<string, string> }) {
    const { page, error, pending, refresh } = queue;
    const documents = page?.documents ?? [];
    const more = page && !page.legacy ? page.total - documents.length : 0;

    return (
        <HudPanel
            icon={<FileCheck2 size={16} />}
            title="Ready for your review"
            accent="amber"
            headerRight={
                <div className="flex items-center gap-2">
                    {typeof pending === "number" && (
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${pending > 0 ? "border-amber-400/50 bg-amber-400/10 text-amber-200" : "border-slate-700 text-slate-400"}`} data-ready-count="">
                            {pending} pending
                        </span>
                    )}
                    <Link href="/documents" className="inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:underline">
                        All reviews <ArrowRight size={11} />
                    </Link>
                </div>
            }
        >
            <div data-ready-for-review="">
                {error && (
                    <div role="alert" className="mb-2 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" /> Could not load reviews: {error}
                        <button type="button" onClick={refresh} className="ml-auto underline">Retry</button>
                    </div>
                )}
                {page === null && !error ? (
                    <div className="flex items-center gap-2 text-xs text-slate-400" data-ready-loading=""><Loader2 size={14} className="animate-spin text-cyan-300" /> Loading reviews…</div>
                ) : page === null ? null : page.legacy ? (
                    <p role="status" className="text-xs text-amber-200">Pending reviews are unavailable until the Nexus API restarts on the new document registry. <Link href="/documents" className="text-cyan-300 hover:underline">Open documents</Link></p>
                ) : documents.length === 0 ? (
                    <p className="text-xs text-slate-500" data-ready-empty="">Nothing is waiting for your review.</p>
                ) : (
                    <>
                        <ul className="space-y-2">
                            {documents.map((entry) => <DeliverableRow key={entry.id} entry={entry} projectNames={projectNames} compact />)}
                        </ul>
                        {more > 0 && (
                            <Link href="/documents" className="mt-2 inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:underline">
                                and {more} more in Reviews <ArrowRight size={11} />
                            </Link>
                        )}
                    </>
                )}
            </div>
        </HudPanel>
    );
}
