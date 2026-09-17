"use client";

/**
 * Shared document reviewer (desktop: document + comment sidebar; phone:
 * responsive drawers with explicit tap-to-comment block controls).
 *
 * Every piece of review state lives on the server: comments and the summary
 * save as they are entered (with a visible saving / saved / failed state and
 * retry), so a draft survives refresh and other devices. "Finish review"
 * creates one durable submission and shows its delivery state truthfully
 * (queued → delivered with a receipt, or failed with a retry). The document
 * itself is never changed here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
    AlertTriangle,
    ArrowLeft,
    Check,
    CheckCircle2,
    Clock,
    Download,
    FileCode,
    FileText,
    ListTree,
    Loader2,
    MessageSquare,
    MessageSquarePlus,
    Pencil,
    RefreshCw,
    Send,
    Trash2,
    X,
    XCircle,
} from "lucide-react";
import {
    addComment,
    deleteComment,
    finishReview,
    getDocument,
    getReview,
    getSubmission,
    newClientId,
    openReview,
    rawDocumentUrl,
    retryDelivery,
    saveSummary,
    updateComment,
    DocumentApiError,
    type DocumentResponse,
    type ReviewComment,
    type ReviewView,
    type SubmissionView,
} from "@/lib/document-review";
import { blockElementId, excerpt, extractOutline, quoteLines } from "@/lib/document-outline";
import { DocumentMarkdown, type BlockRef } from "./document-markdown";

const SUBMISSION_POLL_MS = 3000;
const SUMMARY_DEBOUNCE_MS = 700;

type SaveStatus = { state: "idle" | "saving" | "saved" | "error"; message?: string; retry?: () => void };

interface Composer {
    clientId: string;
    kind: "passage" | "document";
    block?: BlockRef;
    quote?: string;
    selection?: string;
    text: string;
    error?: string;
    saving: boolean;
}

function formatWhen(iso: string | null | undefined): string {
    if (!iso) return "";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function messageOf(err: unknown): string {
    if (err instanceof DocumentApiError) return err.message;
    return err instanceof Error ? err.message : "Request failed";
}

function commentLabel(comment: ReviewComment): string {
    if (comment.kind !== "passage" || !comment.start_line) return "Whole document";
    return comment.start_line === comment.end_line ? `Line ${comment.start_line}` : `Lines ${comment.start_line}–${comment.end_line}`;
}

function AnchorChip({ comment, changed }: { comment: ReviewComment; changed: boolean }) {
    if (!changed || comment.kind !== "passage") return null;
    const state = comment.anchor?.state;
    if (state === "orphaned") {
        return <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-200">passage no longer in current revision</span>;
    }
    if (state === "moved") {
        return <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">now at line {comment.anchor?.current_start_line}</span>;
    }
    return null;
}

/** The delivery outcome is still open: queued, relaying, or failed with an automatic retry scheduled. */
function deliveryPending(submission: SubmissionView): boolean {
    const status = submission.delivery_status;
    return status === "queued" || status === "relaying" || (status === "failed" && Boolean(submission.next_attempt_at));
}

function DeliveryBadge({ submission }: { submission: SubmissionView }) {
    const status = submission.delivery_status;
    if (status === "delivered") {
        return (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-200">
                <CheckCircle2 size={12} /> Delivered to Praxis
            </span>
        );
    }
    if (status === "failed") {
        if (submission.next_attempt_at) {
            return (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
                    <RefreshCw size={12} /> Delivery failed · retry scheduled
                </span>
            );
        }
        return (
            <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-200">
                <XCircle size={12} /> Delivery failed
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-200">
            <Clock size={12} /> {status === "relaying" ? "Delivering to Praxis…" : "Queued for delivery"}
        </span>
    );
}

export interface DocumentReviewPageProps {
    documentId: string;
    /** Test hook: shorten the delivery poll and summary autosave timers. */
    timings?: { pollMs?: number; summaryDebounceMs?: number };
}

export function DocumentReviewPage({ documentId, timings }: DocumentReviewPageProps) {
    const pollMs = timings?.pollMs ?? SUBMISSION_POLL_MS;
    const summaryDebounceMs = timings?.summaryDebounceMs ?? SUMMARY_DEBOUNCE_MS;
    const [data, setData] = useState<DocumentResponse | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [review, setReview] = useState<ReviewView | null>(null);
    const [submission, setSubmission] = useState<SubmissionView | null>(null);
    const [viewRevision, setViewRevision] = useState<"current" | "pinned">("current");
    const [showSource, setShowSource] = useState(false);
    const [composer, setComposer] = useState<Composer | null>(null);
    const [summary, setSummary] = useState("");
    const [summaryStatus, setSummaryStatus] = useState<SaveStatus>({ state: "idle" });
    const [commentStatus, setCommentStatus] = useState<SaveStatus>({ state: "idle" });
    const [editing, setEditing] = useState<{ id: string; text: string; saving: boolean; error?: string } | null>(null);
    const [finishOpen, setFinishOpen] = useState(false);
    const [finishing, setFinishing] = useState(false);
    const [finishError, setFinishError] = useState<string | null>(null);
    const [retrying, setRetrying] = useState(false);
    const [outlineOpen, setOutlineOpen] = useState(false);
    const [reviewOpen, setReviewOpen] = useState(false);
    const [selected, setSelected] = useState<BlockRef | null>(null);
    const [linkCopied, setLinkCopied] = useState(false);
    const summaryTimer = useRef<number | null>(null);
    const summaryDirty = useRef(false);
    /** Phone: the review drawer was closed to make room for the composer; reopen it when the composer closes. */
    const reopenDrawer = useRef(false);
    const reviewRef = useRef<ReviewView | null>(null);
    reviewRef.current = review;

    const load = useCallback(async () => {
        try {
            const response = await getDocument(documentId);
            setData(response);
            setLoadError(null);
            const current = reviewRef.current;
            if (response.review && (!current || current.id === response.review.id || current.status === "submitted")) {
                setReview(response.review);
                setSubmission(response.review.submission);
                if (!summaryDirty.current) setSummary(response.review.summary || "");
                if (response.review.document_changed) setViewRevision("pinned");
            }
        } catch (err) {
            setLoadError(messageOf(err));
        }
    }, [documentId]);

    useEffect(() => {
        void load();
    }, [load]);

    // Delivery state polling while the outcome is still open, including a
    // failure whose automatic retry is scheduled: the page keeps observing
    // until the retry has delivered or failed for good.
    useEffect(() => {
        if (!review || review.status !== "submitted" || !submission) return;
        if (!deliveryPending(submission)) return;
        const timer = window.setInterval(async () => {
            try {
                const next = await getSubmission(review.id);
                setSubmission(next);
            } catch {
                /* keep the last known state; the next tick retries */
            }
        }, pollMs);
        return () => window.clearInterval(timer);
    }, [review, submission, pollMs]);

    const doc = data?.document ?? null;
    const currentContent = data?.content ?? "";
    const documentChanged = Boolean(review?.document_changed);
    const showingPinned = documentChanged && viewRevision === "pinned" && typeof review?.pinned_content === "string";
    const shownContent = showingPinned ? (review?.pinned_content as string) : currentContent;
    const shownRevision = showingPinned ? review?.pinned_revision ?? null : data?.revision ?? null;
    const isDraft = !review || review.status === "draft";
    const canAnnotate = isDraft && (!documentChanged || showingPinned) && !showSource;
    const outline = useMemo(() => extractOutline(shownContent), [shownContent]);
    const comments = review?.comments ?? [];
    const passageComments = comments.filter((c) => c.kind === "passage");
    const documentNotes = comments.filter((c) => c.kind !== "passage");
    const commentCounts = useMemo(() => {
        const counts: Record<number, number> = {};
        for (const comment of passageComments) {
            const line = showingPinned || !documentChanged ? comment.start_line : comment.anchor?.current_start_line ?? null;
            if (line) counts[line] = (counts[line] || 0) + 1;
        }
        return counts;
    }, [passageComments, showingPinned, documentChanged]);

    const ensureReview = useCallback(async (): Promise<ReviewView> => {
        const current = reviewRef.current;
        if (current && current.status === "draft") return current;
        const opened = await openReview(documentId);
        reviewRef.current = opened;
        setReview(opened);
        setSubmission(opened.submission);
        if (opened.document_changed) setViewRevision("pinned");
        return opened;
    }, [documentId]);

    const applyComment = (comment: ReviewComment) => {
        setReview((prev) => {
            if (!prev) return prev;
            const exists = prev.comments.some((c) => c.id === comment.id);
            return { ...prev, comments: exists ? prev.comments.map((c) => (c.id === comment.id ? comment : c)) : [...prev.comments, comment] };
        });
    };

    const startPassageComment = useCallback(
        (block: BlockRef, extra?: { selection?: string }) => {
            if (!canAnnotate) return;
            setSelected(block);
            setComposer((prev) => {
                const sameBlock = prev && prev.kind === "passage" && prev.block?.start === block.start;
                return {
                    clientId: sameBlock ? prev.clientId : newClientId(),
                    kind: "passage",
                    block,
                    quote: quoteLines(shownContent, block.start, block.end),
                    selection: extra?.selection ?? (sameBlock ? prev.selection : undefined),
                    text: sameBlock ? prev.text : "",
                    saving: false,
                };
            });
            setReviewOpen(false);
        },
        [canAnnotate, shownContent],
    );

    const startDocumentNote = () => {
        setSelected(null);
        setComposer({ clientId: newClientId(), kind: "document", text: "", saving: false });
        // On the phone the note control lives inside the review drawer, which
        // stacks above the composer sheet; close it so the composer is the
        // thing under the reviewer's finger, and return to it afterwards.
        if (reviewOpen) {
            reopenDrawer.current = true;
            setReviewOpen(false);
        }
    };

    const closeComposer = () => {
        setComposer(null);
        setSelected(null);
        if (reopenDrawer.current) {
            reopenDrawer.current = false;
            setReviewOpen(true);
        }
    };

    const submitComposer = async () => {
        if (!composer || !composer.text.trim()) return;
        setComposer({ ...composer, saving: true, error: undefined });
        setCommentStatus({ state: "saving" });
        try {
            const draft = await ensureReview();
            const created = await addComment(draft.id, {
                client_id: composer.clientId,
                kind: composer.kind,
                body: composer.text.trim(),
                ...(composer.kind === "passage" && composer.block
                    ? { start_line: composer.block.start, end_line: composer.block.end, quote: composer.quote, selection: composer.selection ?? null }
                    : {}),
            });
            applyComment(created);
            setCommentStatus({ state: "saved" });
            closeComposer();
        } catch (err) {
            const message = messageOf(err);
            setComposer((prev) => (prev ? { ...prev, saving: false, error: message } : prev));
            setCommentStatus({ state: "error", message, retry: () => void submitComposer() });
        }
    };

    const saveEdit = async () => {
        if (!editing || !review || !editing.text.trim()) return;
        setEditing({ ...editing, saving: true, error: undefined });
        setCommentStatus({ state: "saving" });
        try {
            const updated = await updateComment(review.id, editing.id, editing.text.trim());
            applyComment({ ...updated, anchor: review.comments.find((c) => c.id === updated.id)?.anchor });
            setCommentStatus({ state: "saved" });
            setEditing(null);
        } catch (err) {
            const message = messageOf(err);
            setEditing((prev) => (prev ? { ...prev, saving: false, error: message } : prev));
            setCommentStatus({ state: "error", message, retry: () => void saveEdit() });
        }
    };

    const removeComment = async (comment: ReviewComment) => {
        if (!review) return;
        setCommentStatus({ state: "saving" });
        try {
            await deleteComment(review.id, comment.id);
            setReview((prev) => (prev ? { ...prev, comments: prev.comments.filter((c) => c.id !== comment.id) } : prev));
            setCommentStatus({ state: "saved" });
        } catch (err) {
            const message = messageOf(err);
            setCommentStatus({ state: "error", message, retry: () => void removeComment(comment) });
        }
    };

    const persistSummary = useCallback(
        async (value: string) => {
            setSummaryStatus({ state: "saving" });
            try {
                const draft = await ensureReview();
                const updated = await saveSummary(draft.id, value);
                summaryDirty.current = false;
                setReview((prev) => (prev ? { ...prev, summary: updated.summary, updated_at: updated.updated_at } : updated));
                setSummaryStatus({ state: "saved" });
            } catch (err) {
                const message = messageOf(err);
                setSummaryStatus({ state: "error", message, retry: () => void persistSummary(value) });
            }
        },
        [ensureReview],
    );

    const onSummaryChange = (value: string) => {
        setSummary(value);
        summaryDirty.current = true;
        if (summaryTimer.current) window.clearTimeout(summaryTimer.current);
        summaryTimer.current = window.setTimeout(() => void persistSummary(value), summaryDebounceMs);
    };

    useEffect(() => () => { if (summaryTimer.current) window.clearTimeout(summaryTimer.current); }, []);

    const adoptFinished = (finished: ReviewView, sub: SubmissionView | null) => {
        summaryDirty.current = false;
        reviewRef.current = finished;
        setReview(finished);
        setSubmission(sub ?? finished.submission);
        setFinishOpen(false);
        setComposer(null);
        setSelected(null);
    };

    const finish = async () => {
        setFinishing(true);
        setFinishError(null);
        if (summaryTimer.current) { window.clearTimeout(summaryTimer.current); summaryTimer.current = null; }
        let draftId: string | null = null;
        try {
            const draft = await ensureReview();
            draftId = draft.id;
            const result = await finishReview(draft.id, summary);
            adoptFinished(result.review, result.submission);
        } catch (err) {
            const message = messageOf(err);
            if (!draftId) {
                setFinishError(`${message} — nothing was sent; your draft is intact.`);
                return;
            }
            // The request failed after it left: the server may have finished
            // the review and queued delivery even though the response was
            // lost. Ask it before telling the reviewer anything.
            try {
                const current = await getReview(draftId);
                if (current.status === "submitted") {
                    adoptFinished(current, current.submission);
                    return;
                }
                setFinishError(`${message} — nothing was sent; your draft is intact.`);
            } catch {
                setFinishError(`${message} — could not confirm whether the review was sent; reload this page before sending again.`);
            }
        } finally {
            setFinishing(false);
        }
    };

    const retry = async () => {
        if (!review) return;
        setRetrying(true);
        try {
            setSubmission(await retryDelivery(review.id));
        } catch (err) {
            setSubmission((prev) => (prev ? { ...prev, last_error: messageOf(err) } : prev));
        } finally {
            setRetrying(false);
        }
    };

    const startNewReview = async () => {
        try {
            const opened = await openReview(documentId);
            reviewRef.current = opened;
            setReview(opened);
            setSubmission(opened.submission);
            setSummary(opened.summary || "");
            setViewRevision(opened.document_changed ? "pinned" : "current");
        } catch (err) {
            setLoadError(messageOf(err));
        }
    };

    const jumpTo = (line: number | null | undefined) => {
        if (!line) return;
        const target = window.document.getElementById(blockElementId(line));
        if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            const end = Number(target.dataset.blockEnd) || line;
            setSelected({ start: line, end });
        }
        setOutlineOpen(false);
        setReviewOpen(false);
    };

    const copyLink = async () => {
        const url = data?.links.review_url || window.location.href;
        try {
            await navigator.clipboard.writeText(url);
            setLinkCopied(true);
            window.setTimeout(() => setLinkCopied(false), 1500);
        } catch {
            /* clipboard blocked; the URL is in the address bar */
        }
    };

    const backHref = doc?.task_id ? `/task/${doc.task_id}` : doc?.project_id ? `/project/${doc.project_id}` : "/task-board";
    const task = data?.source.task ?? null;
    const project = data?.source.project ?? null;
    const asOf = typeof doc?.metadata?.as_of === "string" ? (doc.metadata.as_of as string) : null;

    const saveIndicator = (() => {
        const states = [summaryStatus, commentStatus];
        if (states.some((s) => s.state === "saving")) return <span className="inline-flex items-center gap-1 text-[11px] text-cyan-200"><Loader2 size={12} className="animate-spin" /> Saving…</span>;
        const failed = states.find((s) => s.state === "error");
        if (failed) {
            return (
                <span role="alert" className="inline-flex flex-wrap items-center gap-1 text-[11px] text-rose-200">
                    <AlertTriangle size={12} /> Save failed: {failed.message}
                    {failed.retry && <button type="button" onClick={failed.retry} className="ml-1 underline">Retry</button>}
                </span>
            );
        }
        if (states.some((s) => s.state === "saved")) return <span className="inline-flex items-center gap-1 text-[11px] text-emerald-200"><Check size={12} /> Saved</span>;
        return <span className="text-[11px] text-slate-500">{review ? "Draft saved on the server" : "Nothing saved yet"}</span>;
    })();

    const composerPanel = composer && (
        <div className="rounded-lg border border-cyan-500/40 bg-slate-950 p-3" data-composer="">
            <div className="mb-2 flex items-center justify-between gap-2 text-xs text-cyan-100">
                <span className="font-semibold">
                    {composer.kind === "passage" && composer.block
                        ? composer.block.start === composer.block.end ? `Comment on line ${composer.block.start}` : `Comment on lines ${composer.block.start}–${composer.block.end}`
                        : "Note about the whole document"}
                </span>
                <button type="button" onClick={closeComposer} aria-label="Cancel comment" className="rounded p-1 text-slate-400 hover:text-white"><X size={14} /></button>
            </div>
            {composer.kind === "passage" && (
                <blockquote className="mb-2 max-h-28 overflow-y-auto whitespace-pre-wrap border-l-2 border-cyan-500/50 pl-2 font-mono text-[11px] text-slate-400">
                    {composer.selection ? composer.selection : excerpt(composer.quote, 400)}
                </blockquote>
            )}
            <textarea
                value={composer.text}
                onChange={(e) => setComposer((prev) => (prev ? { ...prev, text: e.target.value } : prev))}
                placeholder={composer.kind === "passage" ? "What should change here?" : "Your note about the document as a whole"}
                autoFocus
                aria-label="Comment text"
                className="h-24 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500/60"
            />
            {composer.error && (
                <p role="alert" className="mt-1 flex items-start gap-1 text-[11px] text-rose-200"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> {composer.error} — your text is kept; try again.</p>
            )}
            <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={closeComposer} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500">Cancel</button>
                <button
                    type="button"
                    onClick={() => void submitComposer()}
                    disabled={composer.saving || !composer.text.trim()}
                    className="inline-flex items-center gap-1 rounded-md border border-cyan-500/50 bg-cyan-500/20 px-3 py-1.5 text-xs font-semibold text-cyan-100 disabled:opacity-50"
                >
                    {composer.saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save comment
                </button>
            </div>
        </div>
    );

    const commentList = (
        <ul className="space-y-2" data-comment-list="">
            {comments.length === 0 && <li className="text-xs italic text-slate-500">No comments yet. Tap a passage's comment control, select text, or add a note about the whole document.</li>}
            {comments.map((comment) => (
                <li key={comment.id} className="rounded-md border border-slate-800 bg-slate-950/70 p-2.5" data-comment-id={comment.id}>
                    <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                        {comment.kind === "passage" ? (
                            <button type="button" onClick={() => jumpTo(showingPinned || !documentChanged ? comment.start_line : comment.anchor?.current_start_line ?? comment.start_line)} className="font-semibold text-cyan-200 hover:underline">
                                {commentLabel(comment)}
                            </button>
                        ) : (
                            <span className="font-semibold text-slate-200">{commentLabel(comment)}</span>
                        )}
                        <AnchorChip comment={comment} changed={documentChanged} />
                        <span className="ml-auto">{formatWhen(comment.created_at)}</span>
                    </div>
                    {comment.kind === "passage" && (
                        <blockquote className="mb-1.5 whitespace-pre-wrap border-l-2 border-slate-700 pl-2 font-mono text-[11px] text-slate-500">
                            {comment.selection ? comment.selection : excerpt(comment.quote, 200)}
                        </blockquote>
                    )}
                    {editing?.id === comment.id ? (
                        <div>
                            <textarea
                                value={editing.text}
                                onChange={(e) => setEditing((prev) => (prev ? { ...prev, text: e.target.value } : prev))}
                                aria-label="Edit comment"
                                className="h-20 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-500/60"
                            />
                            {editing.error && <p role="alert" className="mt-1 text-[11px] text-rose-200">{editing.error}</p>}
                            <div className="mt-1 flex justify-end gap-2">
                                <button type="button" onClick={() => setEditing(null)} className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300">Cancel</button>
                                <button type="button" onClick={() => void saveEdit()} disabled={editing.saving || !editing.text.trim()} className="rounded border border-cyan-500/50 bg-cyan-500/20 px-2 py-1 text-[11px] text-cyan-100 disabled:opacity-50">Save</button>
                            </div>
                        </div>
                    ) : (
                        <p className="whitespace-pre-wrap text-sm text-slate-200">{comment.body}</p>
                    )}
                    {isDraft && editing?.id !== comment.id && (
                        <div className="mt-1.5 flex justify-end gap-2 text-[11px] text-slate-400">
                            <button type="button" onClick={() => setEditing({ id: comment.id, text: comment.body, saving: false })} className="inline-flex items-center gap-1 hover:text-white"><Pencil size={11} /> Edit</button>
                            <button type="button" onClick={() => void removeComment(comment)} className="inline-flex items-center gap-1 hover:text-rose-200"><Trash2 size={11} /> Delete</button>
                        </div>
                    )}
                </li>
            ))}
        </ul>
    );

    const submissionCard = submission && (
        <div className="rounded-lg border border-slate-700 bg-slate-950/80 p-3" data-submission-card="">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <DeliveryBadge submission={submission} />
                <span className="text-[11px] text-slate-500">Finished {formatWhen(review?.submitted_at)}</span>
            </div>
            {submission.delivery_status === "delivered" && submission.receipt && (
                <p className="mt-2 text-[11px] text-slate-400">
                    Receipt: delivered {formatWhen(submission.receipt.delivered_at)} into the Praxis conversation ({submission.receipt.conversation_id.slice(0, 8)}…). Praxis&apos;s reply is in{" "}
                    <Link href="/" className="text-cyan-300 hover:underline">the bridge chat</Link>.
                </p>
            )}
            {submission.delivery_status === "failed" && (
                <div className="mt-2 text-[11px] text-rose-200" role="alert">
                    <p>{submission.last_error || "Delivery failed."}</p>
                    <p className="mt-1 text-slate-400">Attempts: {submission.delivery_attempts}. {submission.next_attempt_at ? `Automatic retry at ${formatWhen(submission.next_attempt_at)}; this page keeps watching until it lands.` : "No automatic retry; retry when Praxis is reachable."}</p>
                </div>
            )}
            {(submission.delivery_status === "queued" || submission.delivery_status === "relaying") && (
                <p className="mt-2 text-[11px] text-slate-400">Your feedback is stored. It will show as delivered once Praxis confirms the turn (attempt {submission.delivery_attempts}).</p>
            )}
            {submission.delivery_status !== "delivered" && (
                <button type="button" onClick={() => void retry()} disabled={retrying} className="mt-2 inline-flex items-center gap-1 rounded-md border border-slate-600 px-2.5 py-1 text-[11px] text-slate-200 hover:border-cyan-500/60 disabled:opacity-50">
                    <RefreshCw size={11} className={retrying ? "animate-spin" : ""} /> Retry delivery
                </button>
            )}
        </div>
    );

    const finishPanel = finishOpen && isDraft && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3" data-finish-panel="">
            <p className="text-xs text-emerald-100">
                Finishing sends every comment verbatim, with its quoted passage and this document&apos;s revision, into your Praxis chat. Finishing with no comments is fine.
            </p>
            <label className="mt-2 block text-[11px] font-semibold text-slate-300" htmlFor="review-summary-final">Summary (optional)</label>
            <textarea
                id="review-summary-final"
                value={summary}
                onChange={(e) => onSummaryChange(e.target.value)}
                className="mt-1 h-20 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-emerald-500/60"
            />
            {finishError && <p role="alert" className="mt-1 text-[11px] text-rose-200">{finishError}</p>}
            <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setFinishOpen(false)} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300">Keep reviewing</button>
                <button type="button" onClick={() => void finish()} disabled={finishing} className="inline-flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-100 disabled:opacity-50">
                    {finishing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send to Praxis
                </button>
            </div>
        </div>
    );

    const reviewPanel = (
        <div className="space-y-3" data-review-panel="">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100"><MessageSquare size={15} className="text-cyan-300" /> Your review</h2>
                <span className={`rounded-full border px-2 py-0.5 text-[11px] ${isDraft ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"}`}>
                    {isDraft ? "Draft" : "Finished"}
                </span>
            </div>
            <div>{saveIndicator}</div>
            {submissionCard}
            {!isDraft && (
                <button type="button" onClick={() => void startNewReview()} className="text-[11px] text-cyan-300 hover:underline">Start a new review of this document</button>
            )}
            {isDraft && !documentChanged && !showSource && (
                <button type="button" onClick={startDocumentNote} className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 hover:border-cyan-500/50">
                    <MessageSquarePlus size={13} /> Add a note about the whole document
                </button>
            )}
            {isDraft && documentChanged && showingPinned && !showSource && (
                <button type="button" onClick={startDocumentNote} className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 hover:border-cyan-500/50">
                    <MessageSquarePlus size={13} /> Add a note about the whole document
                </button>
            )}
            <div className="hidden lg:block">{composerPanel}</div>
            {isDraft && (
                <div>
                    <label className="block text-[11px] font-semibold text-slate-300" htmlFor="review-summary">Summary (optional, saved as you type)</label>
                    <textarea
                        id="review-summary"
                        value={summary}
                        onChange={(e) => onSummaryChange(e.target.value)}
                        placeholder="Overall impression, decisions, what to do next…"
                        className="mt-1 h-20 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-500/60"
                    />
                </div>
            )}
            {!isDraft && review?.summary && (
                <div>
                    <div className="text-[11px] font-semibold text-slate-300">Summary</div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-200">{review.summary}</p>
                </div>
            )}
            <div>
                <div className="mb-1.5 text-[11px] font-semibold text-slate-300">
                    Comments ({comments.length}){passageComments.length > 0 && documentNotes.length > 0 ? ` · ${passageComments.length} passage, ${documentNotes.length} whole-document` : ""}
                </div>
                {commentList}
            </div>
            {isDraft && !finishOpen && (
                <button type="button" onClick={() => setFinishOpen(true)} className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/25" data-finish-button="">
                    <Send size={14} /> Finish review
                </button>
            )}
            {finishPanel}
        </div>
    );

    const outlinePanel = (
        <nav aria-label="Document outline" className="text-xs" data-outline="">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500"><ListTree size={12} /> Contents</div>
            {outline.length === 0 ? (
                <p className="text-slate-500">No headings.</p>
            ) : (
                <ul className="space-y-1">
                    {outline.map((entry) => (
                        <li key={entry.id} style={{ paddingLeft: `${Math.max(0, entry.level - 1) * 10}px` }}>
                            <button type="button" onClick={() => jumpTo(entry.line)} className="w-full truncate text-left text-slate-300 hover:text-cyan-200" title={entry.text}>
                                {entry.text}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </nav>
    );

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30" data-document-review-page="">
            <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
                {/* Phone: back link + actions on the first row, the title block on its own full-width row below. */}
                <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <Link href={backHref} className="flex shrink-0 items-center gap-1.5 text-sm text-slate-400 hover:text-white">
                        <ArrowLeft size={16} /> {doc?.task_id ? "Task" : "Back"}
                    </Link>
                    {/* The Dashboard's own list of everything registered for review — the way in when the link came from chat rather than a task. */}
                    <Link href="/documents" className="flex shrink-0 items-center gap-1 text-sm text-slate-400 hover:text-white" data-all-documents-link="">
                        <FileText size={14} /> Documents
                    </Link>
                    <div className="hidden h-5 w-px bg-slate-700 sm:block" />
                    <div className="order-last min-w-0 basis-full sm:order-none sm:flex-1 sm:basis-0">
                        <h1 className="text-base font-semibold leading-snug text-white sm:truncate" title={doc?.title}>{doc?.title || "Document"}</h1>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                            {doc?.kind && <span className="uppercase tracking-wide">{doc.kind}</span>}
                            {asOf && <span>as of {asOf}</span>}
                            {shownRevision && <span title={shownRevision.content_hash}>rev {shownRevision.content_hash.slice(0, 8)} · captured {formatWhen(shownRevision.captured_at)}</span>}
                            {task && (
                                <span>
                                    from <Link href={`/task/${task.id}`} className="text-cyan-300 hover:underline">{task.title || task.id}</Link>
                                    {task.status ? ` · ${task.status}` : ""}{task.status_message ? ` · ${task.status_message}` : ""}
                                </span>
                            )}
                            {project && (
                                <span>
                                    in <Link href={`/project/${project.id}`} className="text-cyan-300 hover:underline">{project.name || project.id}</Link>
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2 text-xs">
                        <button type="button" onClick={() => setShowSource((v) => !v)} className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 ${showSource ? "border-cyan-500/60 text-cyan-200" : "border-slate-700 text-slate-300 hover:border-slate-500"}`} aria-pressed={showSource}>
                            {showSource ? <FileText size={13} /> : <FileCode size={13} />} {showSource ? "Rendered" : "Source"}
                        </button>
                        {doc && (
                            <a href={rawDocumentUrl(doc.id, { revision: showingPinned ? review?.revision_id : null, download: true })} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-300 hover:border-slate-500">
                                <Download size={13} /> Download
                            </a>
                        )}
                        <button type="button" onClick={() => void copyLink()} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-300 hover:border-slate-500">
                            {linkCopied ? <Check size={13} className="text-emerald-300" /> : null} {linkCopied ? "Link copied" : "Copy link"}
                        </button>
                    </div>
                </div>
                {/* Phone controls: explicit buttons, no hover required. */}
                <div className="flex gap-2 border-t border-slate-800/80 px-4 py-2 lg:hidden">
                    <button type="button" onClick={() => setOutlineOpen(true)} className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-slate-700 bg-slate-900 py-2 text-xs text-slate-200">
                        <ListTree size={13} /> Contents
                    </button>
                    <button type="button" onClick={() => setReviewOpen(true)} className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 py-2 text-xs text-cyan-100" data-open-review="">
                        <MessageSquare size={13} /> Review ({comments.length})
                    </button>
                </div>
            </header>

            <div className="mx-auto max-w-[1400px] px-4 py-5 lg:grid lg:grid-cols-[210px_minmax(0,1fr)_360px] lg:gap-6">
                <aside className="hidden lg:block">
                    <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2">{outlinePanel}</div>
                </aside>

                <article className="min-w-0">
                    {loadError && (
                        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
                            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {loadError}
                            <button type="button" onClick={() => void load()} className="ml-auto underline">Retry</button>
                        </div>
                    )}
                    {!data && !loadError && (
                        <div className="flex min-h-[320px] items-center justify-center text-cyan-300"><Loader2 className="animate-spin" size={28} /></div>
                    )}
                    {data && data.file_state !== "ok" && (
                        <div role="status" className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100">
                            The file on disk is currently unavailable ({data.file_error || data.file_state}). Showing the last captured revision.
                        </div>
                    )}
                    {data && documentChanged && (
                        <div role="status" className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100" data-changed-banner="">
                            <AlertTriangle size={14} className="shrink-0" />
                            <span className="min-w-0 flex-1">
                                This document changed after your review started. {showingPinned ? "You are viewing the revision you reviewed; comments stay anchored to it." : "You are viewing the current file; passage comments stay pinned to the reviewed revision and are not moved."}
                            </span>
                            <button type="button" onClick={() => setViewRevision(showingPinned ? "current" : "pinned")} className="rounded-md border border-amber-400/50 px-2 py-1 text-amber-100 hover:bg-amber-500/20">
                                {showingPinned ? "View current file" : "View reviewed revision"}
                            </button>
                        </div>
                    )}
                    {data && showSource && (
                        <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-300" data-source-view="">{shownContent}</pre>
                    )}
                    {data && !showSource && (
                        <DocumentMarkdown content={shownContent} selected={selected} commentCounts={commentCounts} interactive={canAnnotate} onBlockSelect={startPassageComment} />
                    )}
                </article>

                <aside className="hidden lg:block">
                    <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/40 p-3">{reviewPanel}</div>
                </aside>
            </div>

            {/* Phone: composer sheet */}
            {composer && (
                <div className="fixed inset-x-0 bottom-0 z-[70] max-h-[70vh] overflow-y-auto border-t border-cyan-500/40 bg-slate-950 p-3 pb-6 shadow-2xl lg:hidden" data-composer-sheet="">
                    {composerPanel}
                </div>
            )}

            {/* Phone: outline drawer */}
            {outlineOpen && (
                <div className="fixed inset-0 z-[80] lg:hidden" role="dialog" aria-label="Contents">
                    <button type="button" aria-label="Close contents" onClick={() => setOutlineOpen(false)} className="absolute inset-0 bg-black/60" />
                    <div className="absolute inset-x-0 bottom-0 max-h-[75vh] overflow-y-auto rounded-t-2xl border-t border-slate-700 bg-slate-950 p-4 pb-8">
                        <div className="mb-2 flex justify-end"><button type="button" onClick={() => setOutlineOpen(false)} aria-label="Close" className="rounded p-1 text-slate-400"><X size={16} /></button></div>
                        {outlinePanel}
                    </div>
                </div>
            )}

            {/* Phone: review drawer */}
            {reviewOpen && (
                <div className="fixed inset-0 z-[80] lg:hidden" role="dialog" aria-label="Your review">
                    <button type="button" aria-label="Close review" onClick={() => setReviewOpen(false)} className="absolute inset-0 bg-black/60" />
                    <div className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-slate-700 bg-slate-950 p-4 pb-8" data-review-drawer="">
                        <div className="mb-2 flex justify-end"><button type="button" onClick={() => setReviewOpen(false)} aria-label="Close" className="rounded p-1 text-slate-400"><X size={16} /></button></div>
                        {reviewPanel}
                    </div>
                </div>
            )}
        </main>
    );
}
