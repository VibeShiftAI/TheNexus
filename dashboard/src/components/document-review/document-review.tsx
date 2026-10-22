"use client";

/**
 * Shared reviewer for every registered deliverable: Markdown and text, code,
 * JSON, HTML prototypes, SVG, images, video, audio, PDF and design packages
 * (contract docs/contracts/review-media-and-design-packages.md).
 *
 * Layout (desktop): a compact header with the document's identity, status,
 * revision and actions; a navigator rail (headings for text, comment markers
 * for media); the stage, which is the viewer for the media type or the editor
 * when editing; and the review rail with the decision, the comment thread and
 * Finish review. On the phone the rails become drawers and the composer a
 * bottom sheet.
 *
 * Every piece of review state lives on the server: comments and the summary
 * save as they are entered (with a visible saving / saved / failed state and
 * retry), so a draft survives refresh and other devices. "Finish review"
 * creates one durable submission and shows its delivery state truthfully.
 * Editing (text media only) writes a new revision through the server; it is
 * the one way this page changes the document, and it never changes a
 * decision: the new revision needs its own.
 *
 * The page always opens on the latest registered revision. The reviewed
 * revision stays one explicit click away and its comments stay attached to it.
 */

import { Breadcrumbs } from "@/components/breadcrumbs";
import { PresentDocumentButton } from "@/components/presentation/presentation-controller";
import { OPEN_DOCUMENT_REFRESH_MS, rememberOpenDocument } from "@/lib/presentation-open-document";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import {
    AlertTriangle,
    Check,
    CheckCircle2,
    Clock,
    CornerDownRight,
    Download,
    FileCheck2,
    FileCode,
    FileText,
    ListTree,
    Loader2,
    MessageSquare,
    MessageSquarePlus,
    Pencil,
    RefreshCw,
    Send,
    ShieldCheck,
    Trash2,
    X,
    XCircle,
} from "lucide-react";
import {
    addComment,
    assetUrl,
    deleteComment,
    finishReview,
    formatSeconds,
    getDocument,
    getReview,
    getSubmission,
    mediaLabel,
    mediaTypeOf,
    newClientId,
    openReview,
    rawDocumentUrl,
    retryDelivery,
    saveEdit,
    saveSummary,
    setCommentResolved,
    updateComment,
    DocumentApiError,
    MEDIA_COMMENT_KINDS,
    type CommentKind,
    type DocumentResponse,
    type MediaAnchor,
    type MediaType,
    type Region,
    type ReviewComment,
    type ReviewView,
    type RevisionAsset,
    type SubmissionView,
} from "@/lib/document-review";
import { readReviewDraft, reconcileReviewDraft, writeReviewDraft, REVIEW_DRAFT_MAX_RECOVERED, type ComposerDraft, type RecoveredDraft, type RecoveredReason, type ReviewDraft } from "@/lib/review-drafts";
import { blockElementId, excerpt, extractOutline, quoteLines } from "@/lib/document-outline";
import { DocumentMarkdown, type BlockRef } from "./document-markdown";
import { DecisionCard } from "./decision-card";
import { OutgoingCard } from "./outgoing-card";
import { DocumentStatusBadge } from "./deliverable-row";
import { HumanBriefBlock } from "@/components/human-brief";
import { briefFromMetadata } from "@/lib/human-brief";
import { EvidenceDrawer, type LoadStates } from "./evidence-drawer";
import { MediaIcon, mediaTone } from "./viewers/media-icon";
import { ImageViewer, type ImagePin } from "./viewers/image-viewer";
import { VideoViewer, type TimeMarker } from "./viewers/video-viewer";
import { PdfViewer, type PageMarker } from "./viewers/pdf-viewer";
import { PrototypeViewer, type PointPin } from "./viewers/prototype-viewer";
import { DesignPackageViewer } from "./viewers/design-package-viewer";
import { TextEditor } from "./viewers/text-editor";

const SUBMISSION_POLL_MS = 3000;
const SUMMARY_DEBOUNCE_MS = 700;

type SaveStatus = { state: "idle" | "saving" | "saved" | "error"; message?: string; retry?: () => void };

interface Composer {
    clientId: string;
    kind: CommentKind;
    block?: BlockRef;
    quote?: string;
    selection?: string;
    anchor?: MediaAnchor;
    /** Human label for a media anchor ("S1 Statement · 1a · light", "0:42"). */
    label?: string;
    parentId?: string;
    text: string;
    error?: string;
    saving: boolean;
    /** The revision whose content the anchor refers to, captured when the composer opened. */
    revisionId: string | null;
    /** Put back from this browser's storage after a reload; nothing is saved until "Save comment". */
    restored?: boolean;
    /**
     * A saved comment with this text at this place, found on an API that reports no client ids, so the server
     * could not confirm it is this draft's own save: the reader decides whether to cancel or save.
     */
    sameAs?: string;
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

/** What a stored composer draft was written for, in the words the composer header used. */
function draftLabel(c: ComposerDraft): string {
    if (c.parent_id) return c.label ?? "Reply";
    if (c.kind === "passage" && c.block) return c.block.start === c.block.end ? `Comment on line ${c.block.start}` : `Comment on lines ${c.block.start}–${c.block.end}`;
    if (c.kind === "document") return "Note about the whole document";
    return `Comment on ${c.label ?? c.kind}`;
}

function recoveredReasonText(reason: RecoveredReason): string {
    switch (reason) {
        case "revision": return "written for an earlier revision of this document and not moved to the current one";
        case "review": return "written for a review that has since been finished";
        case "parent": return "a reply to a comment that is no longer in this review";
        default: return "an edit of a comment that has since changed or been removed";
    }
}

function commentLabel(comment: ReviewComment): string {
    if (MEDIA_COMMENT_KINDS.has(comment.kind)) return comment.target_label || comment.anchor_target?.asset_key || comment.kind;
    if (comment.kind !== "passage" || !comment.start_line) return "Whole document";
    return comment.start_line === comment.end_line ? `Line ${comment.start_line}` : `Lines ${comment.start_line}–${comment.end_line}`;
}

function AnchorChip({ comment, changed }: { comment: ReviewComment; changed: boolean }) {
    if (!changed || comment.kind === "document") return null;
    const state = comment.anchor?.state;
    if (state === "orphaned") {
        return <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-200">{comment.kind === "passage" ? "passage no longer in current revision" : "asset no longer in current revision"}</span>;
    }
    if (state === "moved") {
        return <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">{comment.kind === "passage" ? `now at line ${comment.anchor?.current_start_line}` : `now ${comment.anchor?.current_asset_key}`}</span>;
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
        return <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-200"><CheckCircle2 size={12} /> Delivered to Praxis</span>;
    }
    if (status === "failed") {
        if (submission.next_attempt_at) return <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200"><RefreshCw size={12} /> Delivery failed · retry scheduled</span>;
        return <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-200"><XCircle size={12} /> Delivery failed</span>;
    }
    return <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-200"><Clock size={12} /> {status === "relaying" ? "Delivering to Praxis…" : "Queued for delivery"}</span>;
}

/** Numbered pins per asset for the media viewers, from the comments that carry a media anchor. */
function pinsFor(comments: ReviewComment[]) {
    const byAsset: Record<string, (ImagePin & { point?: { x: number; y: number } | null; viewport?: string | null })[]> = {};
    const time: Record<string, TimeMarker[]> = {};
    const pages: Record<string, PageMarker[]> = {};
    let index = 0;
    for (const comment of comments) {
        if (comment.parent_id || !MEDIA_COMMENT_KINDS.has(comment.kind) || !comment.anchor_target) continue;
        index += 1;
        const anchor = comment.anchor_target as Record<string, unknown> & { asset_key: string };
        const key = anchor.asset_key;
        const base = { id: comment.id, index, label: comment.body, resolved: comment.resolved };
        if (comment.kind === "time") {
            (time[key] ||= []).push({ ...base, t_start: Number(anchor.t_start), t_end: typeof anchor.t_end === "number" ? anchor.t_end : null });
        } else if (comment.kind === "page") {
            (pages[key] ||= []).push({ ...base, page: Number(anchor.page) });
        } else if (comment.kind === "point") {
            (byAsset[key] ||= []).push({ ...base, point: { x: Number(anchor.x), y: Number(anchor.y) }, viewport: typeof anchor.viewport === "string" ? anchor.viewport : null });
        } else if (comment.kind === "screen") {
            (byAsset[key] ||= []).push({ ...base, region: (anchor.region as Region | undefined) ?? null, point: anchor.region ? null : { x: 0.02, y: 0.02 } });
        } else {
            (byAsset[key] ||= []).push({ ...base, region: { x: Number(anchor.x), y: Number(anchor.y), w: Number(anchor.w), h: Number(anchor.h) } });
        }
    }
    const indexOf: Record<string, number> = {};
    for (const list of [...Object.values(byAsset), ...Object.values(time), ...Object.values(pages)]) for (const pin of list) indexOf[pin.id] = pin.index;
    return { byAsset, time, pages, indexOf };
}

function PlainText({ content, mono, onLine, counts, selected }: { content: string; mono: boolean; onLine?: (line: number) => void; counts: Record<number, number>; selected: BlockRef | null }) {
    const lines = content.split("\n");
    return (
        <div className={`overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 ${mono ? "font-mono text-xs leading-6" : "text-sm leading-7"} text-slate-200`} data-plain-text="">
            {lines.map((line, i) => {
                const n = i + 1;
                const count = counts[n] || 0;
                return (
                    <div key={n} id={blockElementId(n)} data-review-block="" data-block-start={n} data-block-end={n} className={`group flex ${selected?.start === n ? "bg-cyan-500/10" : count ? "bg-amber-500/5" : ""}`}>
                        <button type="button" onClick={() => onLine?.(n)} disabled={!onLine} aria-label={`Comment on line ${n}`} data-block-comment-button="" className={`w-12 shrink-0 select-none border-r border-slate-800 pr-2 text-right text-[11px] ${count ? "text-amber-200" : "text-slate-600"} ${onLine ? "hover:text-cyan-200" : ""}`}>
                            {count ? `${n} ·${count}` : n}
                        </button>
                        <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words px-3">{line || " "}</pre>
                    </div>
                );
            })}
        </div>
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
    const [editing, setEditing] = useState(false);
    const [evidenceOpen, setEvidenceOpen] = useState(false);
    const [loadStates, setLoadStates] = useState<LoadStates>({});
    const [composer, setComposer] = useState<Composer | null>(null);
    const [summary, setSummary] = useState("");
    const [summaryStatus, setSummaryStatus] = useState<SaveStatus>({ state: "idle" });
    const [commentStatus, setCommentStatus] = useState<SaveStatus>({ state: "idle" });
    const [editingComment, setEditingComment] = useState<{ id: string; text: string; base: string; saving: boolean; error?: string } | null>(null);
    /** Unsaved text from before a reload whose binding no longer holds; shown until the reader places or discards it. */
    const [recovered, setRecovered] = useState<RecoveredDraft[]>([]);
    const [summaryRestored, setSummaryRestored] = useState(false);
    /** Drafts are written to storage only once the stored draft for this document has been reconciled, so the empty initial state never wipes it. */
    const [draftPhase, setDraftPhase] = useState<"pending" | "ready">("pending");
    const [finishOpen, setFinishOpen] = useState(false);
    const [finishing, setFinishing] = useState(false);
    const [finishError, setFinishError] = useState<string | null>(null);
    // Robert's explicit approve-after-changes grant, sent with Finish review (task a2553798).
    const [delegateApproval, setDelegateApproval] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const [outlineOpen, setOutlineOpen] = useState(false);
    const [reviewOpen, setReviewOpen] = useState(false);
    const [selected, setSelected] = useState<BlockRef | null>(null);
    const [selectedComment, setSelectedComment] = useState<string | null>(null);
    const [focusAsset, setFocusAsset] = useState<string | null>(null);
    const [seekTo, setSeekTo] = useState<number | null>(null);
    const [requestedPage, setRequestedPage] = useState<number | null>(null);
    const [linkCopied, setLinkCopied] = useState(false);
    /** The sticky header's height: the rails stick just below it, at the spot they start from, so their bottom edge never moves. */
    const [headerHeight, setHeaderHeight] = useState<number | null>(null);
    const headerRef = useCallback((el: HTMLElement | null) => {
        if (!el) return;
        const measure = () => setHeaderHeight(el.offsetHeight);
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    /**
     * Desktop rails stick only when the window leaves them their 8rem minimum between the header and the floating
     * controls. A shorter window (the screenshot's 389px at 125% or 150%) would push the floor of a sticky rail under
     * the mini player, so they scroll with the page instead (QA round 1 of task 7fe1005f).
     */
    const [railsFlow, setRailsFlow] = useState(false);
    useEffect(() => {
        if (headerHeight === null) return;
        const root = window.document.documentElement;
        const check = () => {
            // Body units, like the header height and the reserve: the window is divided by the display scale.
            const zoom = parseFloat(getComputedStyle(window.document.body).zoom) || 1;
            const rem = parseFloat(getComputedStyle(root).fontSize) || 16;
            const reserve = parseFloat(getComputedStyle(root).getPropertyValue("--nexus-floating-bottom")) || 6 * rem;
            setRailsFlow(root.clientHeight / zoom - (headerHeight + 1.25 * rem) - reserve < 8 * rem);
        };
        check();
        window.addEventListener("resize", check);
        // lib/floating-controls republishes the reserve on <html>; the display scale arrives on <body>.
        const observer = new MutationObserver(check);
        observer.observe(root, { attributes: true, attributeFilter: ["style"] });
        observer.observe(window.document.body, { attributes: true, attributeFilter: ["style"] });
        return () => {
            window.removeEventListener("resize", check);
            observer.disconnect();
        };
    }, [headerHeight]);
    const summaryTimer = useRef<number | null>(null);
    const summaryDirty = useRef(false);
    /** Phone: the review drawer was closed to make room for the composer; reopen it when the composer closes. */
    const reopenDrawer = useRef(false);
    const reviewRef = useRef<ReviewView | null>(null);
    reviewRef.current = review;

    const dataRef = useRef(data);
    dataRef.current = data;
    const documentIdRef = useRef(documentId);
    documentIdRef.current = documentId;
    const loadSequence = useRef(0);
    /** The document whose stored draft has been reconciled; a composer left over from another id is never written under this one. */
    const draftRestoredFor = useRef<string | null>(null);
    /** Whether this page owns the stored draft (it wrote one, or reconciled its own); only then may an empty state clear storage. */
    const ownsDraft = useRef(false);
    /** Bumps when a comment or summary write is applied locally; a read that started before it must not replace the review with its older copy. */
    const writeSequence = useRef(0);
    const load = useCallback(async (onlyNewRevision = false) => {
        const sequence = ++loadSequence.current;
        const writesBefore = writeSequence.current;
        try {
            const response = await getDocument(documentId);
            if (documentId !== documentIdRef.current || sequence !== loadSequence.current) return;
            if (onlyNewRevision && response.revision?.id === dataRef.current?.revision?.id) return;
            setData(response);
            setLoadError(null);
            // A comment or summary write landed while this read was in flight: the read's copy of the review predates it.
            if (writeSequence.current !== writesBefore) return;
            const current = reviewRef.current;
            if (response.review && (!current || current.id === response.review.id || current.status === "submitted")) {
                setReview(response.review);
                setSubmission(response.review.submission);
                if (!summaryDirty.current) setSummary(response.review.summary || "");
            }
        } catch (err) {
            if (documentId === documentIdRef.current && sequence === loadSequence.current) setLoadError(messageOf(err));
        }
    }, [documentId]);

    useEffect(() => {
        // Every document opens on its latest revision, also when the route reuses this page for another id.
        setViewRevision("current");
        setEditing(false);
        setLoadStates({});
        // Nothing of a previous document may carry over: its review, submission, unsaved text, selection or pending summary save.
        if (summaryTimer.current) { window.clearTimeout(summaryTimer.current); summaryTimer.current = null; }
        reviewRef.current = null;
        summaryDirty.current = false;
        // The stored draft is reconciled again once this document's own read lands, also on a quick return to it.
        draftRestoredFor.current = null;
        setReview(null);
        setSubmission(null);
        setComposer(null);
        setEditingComment(null);
        setSummary("");
        setSummaryStatus({ state: "idle" });
        setCommentStatus({ state: "idle" });
        setSelected(null);
        setSelectedComment(null);
        setFinishOpen(false);
        setFinishError(null);
        setRecovered([]);
        setSummaryRestored(false);
        setDraftPhase("pending");
        void load();
    }, [load]);

    // Delivery state polling while the outcome is still open.
    useEffect(() => {
        if (!review || review.status !== "submitted" || !submission) return;
        if (!deliveryPending(submission)) return;
        const timer = window.setInterval(async () => {
            try { setSubmission(await getSubmission(review.id)); } catch { /* keep the last known state; the next tick retries */ }
        }, pollMs);
        return () => window.clearInterval(timer);
    }, [review, submission, pollMs]);

    // Keep discovering new revisions, without replacing an unfinished review.
    useEffect(() => {
        if (review && review.status !== "submitted") return;
        if (editing) return;
        const refresh = () => { if (!summaryDirty.current) void load(true); };
        const timer = window.setInterval(refresh, timings?.pollMs ?? 15_000);
        window.addEventListener("focus", refresh);
        return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
    }, [load, review?.status, timings?.pollMs, editing]);

    const doc = data?.document ?? null;
    const mediaType: MediaType = mediaTypeOf(data);
    const currentContent = data?.content ?? "";
    const documentChanged = Boolean(review?.document_changed);
    const showingPinned = documentChanged && viewRevision === "pinned" && typeof review?.pinned_content === "string";
    const shownContent = showingPinned ? (review?.pinned_content as string) : currentContent;
    const shownRevision = showingPinned ? review?.pinned_revision ?? null : data?.revision ?? null;
    const reviewedHash = review?.pinned_revision?.content_hash.slice(0, 8) ?? "?";
    const latestHash = data?.revision?.content_hash.slice(0, 8) ?? "?";
    const isDraft = !review || review.status === "draft";
    const canAnnotate = isDraft && (!documentChanged || showingPinned) && !showSource && !editing;
    const textual = ["markdown", "text", "code", "json", "html", "svg", "design"].includes(mediaType);
    const assets: RevisionAsset[] = useMemo(() => {
        const list = data?.assets ?? [];
        if (list.length) return list;
        return doc && data?.revision ? [{ asset_key: "primary", role: "primary", path: doc.path, media_type: mediaType, mime_type: data.mime_type ?? "text/markdown", byte_length: data.revision.byte_length, content_hash: data.revision.content_hash, label: doc.path.split("/").pop() ?? "primary", direction: null, appearance: null, viewport: null, state: null, before_asset_key: null, order: -1, width: data.revision.width ?? null, height: data.revision.height ?? null }] : [];
    }, [data, doc, mediaType]);
    const primary = assets.find((a) => a.asset_key === "primary") ?? null;
    const outline = useMemo(() => (mediaType === "markdown" ? extractOutline(shownContent) : []), [shownContent, mediaType]);
    const comments = review?.comments ?? [];
    const roots = comments.filter((c) => !c.parent_id);
    const repliesOf = (id: string) => comments.filter((c) => c.parent_id === id);
    const passageComments = comments.filter((c) => c.kind === "passage");
    const mediaComments = comments.filter((c) => MEDIA_COMMENT_KINDS.has(c.kind) && !c.parent_id);
    const documentNotes = comments.filter((c) => c.kind === "document" && !c.parent_id);
    const commentCounts = useMemo(() => {
        const counts: Record<number, number> = {};
        for (const comment of passageComments) {
            const line = showingPinned || !documentChanged ? comment.start_line : comment.anchor?.current_start_line ?? null;
            if (line) counts[line] = (counts[line] || 0) + 1;
        }
        return counts;
    }, [passageComments, showingPinned, documentChanged]);
    const pins = useMemo(() => pinsFor(comments), [comments]);
    const directions = data?.manifest?.directions ?? [];
    const selectedDirection = data?.current_decision?.applies_to_current_revision && data.current_decision.decision === "approve" ? data.current_decision.selection?.direction ?? null : null;
    const mediaLoad = useCallback((assetKey: string, state: "loaded" | "failed") => setLoadStates((prev) => (prev[assetKey] === state ? prev : { ...prev, [assetKey]: state })), []);

    // Once per document, after its first read: put back the text this browser was holding when the page last went
    // away (a full reload of the dev server, a crash, a closed tab), but only where its binding still holds. Anything
    // written for another revision, a finished review or a vanished comment is kept as recovered text for the reader
    // to place; nothing is saved by restoring (task 1390fc34).
    useEffect(() => {
        if (!data || data.document.id !== documentId || draftRestoredFor.current === documentId) return;
        draftRestoredFor.current = documentId;
        const stored = readReviewDraft(documentId);
        const kept: RecoveredDraft[] = [];
        if (stored) {
            const plan = reconcileReviewDraft(stored, {
                document_id: documentId,
                revision_id: data.revision?.id ?? null,
                reviewer_id: data.viewer?.id ?? null,
                review: review ? { id: review.id, status: review.status, summary: review.summary || "", comments: review.comments } : null,
            });
            if (!plan.foreign) {
                ownsDraft.current = true;
                const now = new Date().toISOString();
                kept.push(...stored.recovered);
                const keep = (item: RecoveredDraft) => { if (!kept.some((r) => r.id === item.id)) kept.push(item); };
                if (plan.composer && "restore" in plan.composer) {
                    const c = plan.composer.restore;
                    const sameAs = plan.composer.same_as;
                    setComposer((prev) => (prev && prev.text.trim() ? prev : { clientId: c.client_id, kind: c.kind, block: c.block, quote: c.quote, selection: c.selection, anchor: c.anchor, label: c.label, parentId: c.parent_id, text: c.text, saving: false, revisionId: stored.revision_id, restored: true, ...(sameAs ? { sameAs } : {}) }));
                    if (c.kind === "passage" && c.block) setSelected(c.block);
                    if (c.parent_id) setSelectedComment(c.parent_id);
                } else if (plan.composer && "recovered" in plan.composer) {
                    const c = plan.composer.recovered;
                    keep({ id: `draft-${c.client_id}`, text: c.text, label: draftLabel(c), reason: plan.composer.reason, revision_id: stored.revision_id, saved_at: now });
                }
                if (plan.edit && "restore" in plan.edit) {
                    const e = plan.edit.restore;
                    setEditingComment({ id: e.comment_id, text: e.text, base: e.base_body, saving: false });
                } else if (plan.edit && "recovered" in plan.edit) {
                    const e = plan.edit.recovered;
                    keep({ id: `edit-${e.comment_id}`, text: e.text, label: "Edit of a comment", reason: plan.edit.reason, revision_id: stored.revision_id, saved_at: now });
                }
                if (plan.summary) {
                    summaryDirty.current = true;
                    setSummary(plan.summary.restore);
                    setSummaryRestored(true);
                }
            }
        }
        setRecovered(kept.slice(-REVIEW_DRAFT_MAX_RECOVERED));
        setDraftPhase("ready");
    }, [data, documentId, review]);

    // Every keystroke in a composer, a comment edit or the summary lands in this browser's storage, bound to this
    // document, revision and reviewer, until the server acknowledges it or the reader discards it.
    useEffect(() => {
        if (draftPhase !== "ready" || draftRestoredFor.current !== documentId || !data || data.document.id !== documentId) return;
        const record: ReviewDraft = {
            document_id: documentId,
            revision_id: composer?.revisionId ?? data.revision?.id ?? null,
            content_hash: data.revision?.content_hash ?? null,
            reviewer_id: data.viewer?.id ?? null,
            review_id: review?.id ?? null,
            composer: composer && composer.text.trim()
                ? { client_id: composer.clientId, kind: composer.kind, text: composer.text, block: composer.block, quote: composer.quote, selection: composer.selection, anchor: composer.anchor, label: composer.label, parent_id: composer.parentId }
                : null,
            edit: editingComment && editingComment.text.trim() && editingComment.text !== editingComment.base
                ? { comment_id: editingComment.id, base_body: editingComment.base, text: editingComment.text }
                : null,
            summary: summaryDirty.current ? { text: summary, base: review?.summary ?? "" } : null,
            recovered,
            saved_at: new Date().toISOString(),
        };
        const empty = !record.composer && !record.edit && !record.summary && recovered.length === 0;
        // An empty state clears storage only when this page put the draft there; another reviewer's draft in a shared browser is left alone.
        if (empty && !ownsDraft.current) return;
        if (writeReviewDraft(documentId, record)) ownsDraft.current = !empty;
    }, [draftPhase, documentId, data, review, composer, editingComment, summary, summaryStatus.state, recovered]);

    const ensureReview = useCallback(async (): Promise<ReviewView> => {
        const current = reviewRef.current;
        if (current && current.status === "draft") return current;
        const opened = await openReview(documentId);
        writeSequence.current += 1;
        reviewRef.current = opened;
        setReview(opened);
        setSubmission(opened.submission);
        return opened;
    }, [documentId]);

    const applyComment = (comment: ReviewComment) => {
        writeSequence.current += 1;
        setReview((prev) => {
            if (!prev) return prev;
            const exists = prev.comments.some((c) => c.id === comment.id);
            return { ...prev, comments: exists ? prev.comments.map((c) => (c.id === comment.id ? { ...c, ...comment, anchor: comment.anchor ?? c.anchor } : c)) : [...prev.comments, comment] };
        });
    };

    const shownRevisionId = shownRevision?.id ?? null;
    // Chat-directed presenting (lib/presentation-open-document): while this review is on
    // screen, publish the exact revision shown (ids and hash only) so "display this document"
    // in the Praxis chat pins it. The entry is deliberately not erased on unmount: in the
    // single-webview shells the chat lives on another route, so this review has already
    // unmounted by the time Robert asks. It ages out 30 minutes after the last publish or is
    // replaced by the next review opened.
    const shownContentHash = shownRevision?.content_hash ?? null;
    const openDocumentId = doc?.id ?? null;
    const openDocumentTitle = doc?.title ?? null;
    useEffect(() => {
        if (!openDocumentId || !shownRevisionId || !shownContentHash) return;
        const publish = () => rememberOpenDocument({ documentId: openDocumentId, revisionId: shownRevisionId, contentHash: shownContentHash, ...(openDocumentTitle ? { title: openDocumentTitle } : {}) });
        publish();
        const timer = window.setInterval(publish, OPEN_DOCUMENT_REFRESH_MS);
        window.addEventListener("focus", publish);
        return () => { window.clearInterval(timer); window.removeEventListener("focus", publish); };
    }, [openDocumentId, shownRevisionId, shownContentHash, openDocumentTitle]);
    const openComposer = (next: Omit<Composer, "clientId" | "text" | "saving" | "revisionId"> & { text?: string }) => {
        setComposer(() => ({ clientId: newClientId(), saving: false, revisionId: shownRevisionId, ...next, text: next.text ?? "" }));
        if (reviewOpen) { reopenDrawer.current = true; setReviewOpen(false); }
    };

    const startPassageComment = useCallback(
        (block: BlockRef, extra?: { selection?: string }) => {
            if (!canAnnotate) return;
            setSelected(block);
            setSelectedComment(null);
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
                    revisionId: shownRevisionId,
                };
            });
            setReviewOpen(false);
        },
        [canAnnotate, shownContent, shownRevisionId],
    );

    /** Recovered text the reader wants as a note about the whole document: it opens a composer, it is not saved. */
    const placeRecovered = (item: RecoveredDraft) => {
        setRecovered((list) => list.filter((r) => r.id !== item.id));
        setSelected(null);
        setSelectedComment(null);
        openComposer({ kind: "document", text: item.text, restored: true });
    };
    const discardRecovered = (item: RecoveredDraft) => setRecovered((list) => list.filter((r) => r.id !== item.id));
    const copyRecovered = async (item: RecoveredDraft) => {
        try { await navigator.clipboard.writeText(item.text); } catch { /* clipboard blocked; the text stays on screen */ }
    };

    const startDocumentNote = () => {
        setSelected(null);
        setSelectedComment(null);
        openComposer({ kind: "document" });
    };

    const startReply = (parent: ReviewComment) => {
        setSelectedComment(parent.id);
        openComposer({ kind: "document", parentId: parent.id, label: `Reply to ${commentLabel(parent)}` });
    };

    const assetLabel = (key: string) => {
        const asset = assets.find((a) => a.asset_key === key);
        if (!asset) return key;
        if (asset.role === "primary") return asset.label ?? key;
        return [asset.label, asset.direction, asset.appearance].filter(Boolean).join(" · ");
    };

    const startRegion = (assetKey: string, region: Region) => {
        if (!canAnnotate) return;
        const asset = assets.find((a) => a.asset_key === assetKey);
        const kind: CommentKind = asset?.role === "screen" ? "screen" : "region";
        const anchor: MediaAnchor = kind === "screen" ? { asset_key: assetKey, region } : { asset_key: assetKey, ...region };
        setSelectedComment(null);
        openComposer({ kind, anchor, label: `${assetLabel(assetKey)} at (${Math.round(region.x * 100)}%, ${Math.round(region.y * 100)}%) ${Math.round(region.w * 100)}×${Math.round(region.h * 100)}%` });
    };
    const startPoint = (assetKey: string, point: { x: number; y: number; viewport: string }) => {
        if (!canAnnotate) return;
        setSelectedComment(null);
        openComposer({ kind: "point", anchor: { asset_key: assetKey, x: point.x, y: point.y, viewport: point.viewport }, label: `${assetLabel(assetKey)} at (${Math.round(point.x * 100)}%, ${Math.round(point.y * 100)}%) on ${point.viewport}` });
    };
    const startTimestamp = (range: { t_start: number; t_end?: number }) => {
        if (!canAnnotate || !primary) return;
        setSelectedComment(null);
        openComposer({ kind: "time", anchor: { asset_key: primary.asset_key, t_start: range.t_start, ...(range.t_end !== undefined ? { t_end: range.t_end } : {}) }, label: range.t_end !== undefined ? `${formatSeconds(range.t_start)}–${formatSeconds(range.t_end)}` : formatSeconds(range.t_start) });
    };
    const startPage = (page: number) => {
        if (!canAnnotate || !primary) return;
        setSelectedComment(null);
        openComposer({ kind: "page", anchor: { asset_key: primary.asset_key, page }, label: `page ${page}` });
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
                ...(composer.parentId ? { parent_id: composer.parentId } : {}),
                ...(composer.kind === "passage" && composer.block
                    ? { start_line: composer.block.start, end_line: composer.block.end, quote: composer.quote, selection: composer.selection ?? null }
                    : {}),
                ...(composer.anchor ? { anchor: composer.anchor } : {}),
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

    const saveCommentEdit = async () => {
        if (!editingComment || !review || !editingComment.text.trim()) return;
        setEditingComment({ ...editingComment, saving: true, error: undefined });
        setCommentStatus({ state: "saving" });
        try {
            const updated = await updateComment(review.id, editingComment.id, editingComment.text.trim());
            applyComment({ ...updated, anchor: review.comments.find((c) => c.id === updated.id)?.anchor });
            setCommentStatus({ state: "saved" });
            setEditingComment(null);
        } catch (err) {
            const message = messageOf(err);
            setEditingComment((prev) => (prev ? { ...prev, saving: false, error: message } : prev));
            setCommentStatus({ state: "error", message, retry: () => void saveCommentEdit() });
        }
    };

    const removeComment = async (comment: ReviewComment) => {
        if (!review) return;
        setCommentStatus({ state: "saving" });
        try {
            await deleteComment(review.id, comment.id);
            writeSequence.current += 1;
            setReview((prev) => (prev ? { ...prev, comments: prev.comments.filter((c) => c.id !== comment.id && c.parent_id !== comment.id) } : prev));
            setCommentStatus({ state: "saved" });
        } catch (err) {
            const message = messageOf(err);
            setCommentStatus({ state: "error", message, retry: () => void removeComment(comment) });
        }
    };

    const toggleResolved = async (comment: ReviewComment) => {
        if (!review) return;
        try {
            const updated = await setCommentResolved(review.id, comment.id, !comment.resolved);
            applyComment({ ...updated, anchor: comment.anchor });
        } catch (err) {
            setCommentStatus({ state: "error", message: messageOf(err), retry: () => void toggleResolved(comment) });
        }
    };

    const persistSummary = useCallback(
        async (value: string) => {
            setSummaryStatus({ state: "saving" });
            try {
                const draft = await ensureReview();
                const updated = await saveSummary(draft.id, value);
                summaryDirty.current = false;
                writeSequence.current += 1;
                setReview((prev) => (prev ? { ...prev, summary: updated.summary, updated_at: updated.updated_at } : updated));
                setSummaryRestored(false);
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
        setDelegateApproval(false);
        summaryDirty.current = false;
        writeSequence.current += 1;
        setSummaryRestored(false);
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
            const result = await finishReview(draft.id, summary, { approveAfterChanges: delegateApproval });
            adoptFinished(result.review, result.submission);
        } catch (err) {
            const message = messageOf(err);
            if (!draftId) {
                setFinishError(`${message} — nothing was sent; your draft is intact.`);
                return;
            }
            try {
                const current = await getReview(draftId);
                if (current.status === "submitted") { adoptFinished(current, current.submission); return; }
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
        try { setSubmission(await retryDelivery(review.id)); }
        catch (err) { setSubmission((prev) => (prev ? { ...prev, last_error: messageOf(err) } : prev)); }
        finally { setRetrying(false); }
    };

    const startNewReview = async () => {
        ++loadSequence.current;
        try {
            const opened = await openReview(documentId);
            ++loadSequence.current;
            reviewRef.current = opened;
            setReview(opened);
            setSubmission(opened.submission);
            setSummary(opened.summary || "");
            setViewRevision("current");
            await load();
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

    /** A comment tapped in the rail: show its spot on the stage. */
    const jumpToComment = (comment: ReviewComment) => {
        setSelectedComment(comment.id);
        if (comment.kind === "passage") { jumpTo(showingPinned || !documentChanged ? comment.start_line : comment.anchor?.current_start_line ?? comment.start_line); return; }
        const anchor = comment.anchor_target as (Record<string, unknown> & { asset_key: string }) | null | undefined;
        if (!anchor) return;
        setFocusAsset(anchor.asset_key);
        if (comment.kind === "time") setSeekTo(Number(anchor.t_start));
        if (comment.kind === "page") setRequestedPage(Number(anchor.page));
        setOutlineOpen(false);
        setReviewOpen(false);
        if (typeof window !== "undefined") window.document.querySelector("[data-stage]")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    const copyLink = async () => {
        const url = data?.links.review_url || window.location.href;
        try {
            await navigator.clipboard.writeText(url);
            setLinkCopied(true);
            window.setTimeout(() => setLinkCopied(false), 1500);
        } catch { /* clipboard blocked; the URL is in the address bar */ }
    };

    const onEditSave = async (content: string, editSummary: string) => {
        if (!data?.revision) return;
        await saveEdit(documentId, { base_revision_id: data.revision.id, content, client_edit_id: newClientId(), summary: editSummary || undefined });
        setEditing(false);
        await load();
    };

    const task = data?.source.task ?? null;
    const project = data?.source.project ?? null;
    const asOf = typeof doc?.metadata?.as_of === "string" ? (doc.metadata.as_of as string) : null;
    // The human brief Praxis registered with the document (Praxis
    // docs/human-brief.md): which project, what this is, what the reviewer
    // decides. Shown under the title; absent on documents registered before it.
    const brief = briefFromMetadata(doc?.metadata);
    const canEdit = Boolean(data?.editable) && !showingPinned && data?.file_state === "ok" && !editing;

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

    const composerTitle = (c: Composer) => {
        if (c.parentId) return c.label ?? "Reply";
        if (c.kind === "passage" && c.block) return c.block.start === c.block.end ? `Comment on line ${c.block.start}` : `Comment on lines ${c.block.start}–${c.block.end}`;
        if (c.kind === "document") return "Note about the whole document";
        return `Comment on ${c.label ?? c.kind}`;
    };

    const composerPanel = composer && (
        <div className="rounded-lg border border-cyan-500/40 bg-slate-950 p-3" data-composer="" data-composer-kind={composer.kind}>
            <div className="mb-2 flex items-center justify-between gap-2 text-xs text-cyan-100">
                <span className="font-semibold">{composerTitle(composer)}</span>
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
                placeholder={composer.parentId ? "Your reply" : composer.kind === "document" ? "Your note about the document as a whole" : "What should change here?"}
                autoFocus
                aria-label="Comment text"
                className="h-24 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500/60"
            />
            {composer.error && (
                <p role="alert" className="mt-1 flex items-start gap-1 text-[11px] text-rose-200"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> {composer.error} — your text is kept; try again.</p>
            )}
            {composer.restored && !composer.error && (
                <p role="status" data-composer-restored="" {...(composer.sameAs ? { "data-composer-same-as": composer.sameAs } : {})} className="mt-1 text-[11px] text-amber-200">
                    Restored from this browser after the page reloaded; not saved until you save it.
                    {composer.sameAs && " A saved comment with the same text is already at this place; cancel this draft if it is the same one."}
                </p>
            )}
            <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={closeComposer} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500">Cancel</button>
                <button type="button" onClick={() => void submitComposer()} disabled={composer.saving || !composer.text.trim()} className="inline-flex items-center gap-1 rounded-md border border-cyan-500/50 bg-cyan-500/20 px-3 py-1.5 text-xs font-semibold text-cyan-100 disabled:opacity-50">
                    {composer.saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save comment
                </button>
            </div>
        </div>
    );

    const commentBody = (comment: ReviewComment) => (
        editingComment?.id === comment.id ? (
            <div>
                <textarea value={editingComment.text} onChange={(e) => setEditingComment((prev) => (prev ? { ...prev, text: e.target.value } : prev))} aria-label="Edit comment" className="h-20 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-500/60" />
                {editingComment.error && <p role="alert" className="mt-1 text-[11px] text-rose-200">{editingComment.error}</p>}
                <div className="mt-1 flex justify-end gap-2">
                    <button type="button" onClick={() => setEditingComment(null)} className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300">Cancel</button>
                    <button type="button" onClick={() => void saveCommentEdit()} disabled={editingComment.saving || !editingComment.text.trim()} className="rounded border border-cyan-500/50 bg-cyan-500/20 px-2 py-1 text-[11px] text-cyan-100 disabled:opacity-50">Save</button>
                </div>
            </div>
        ) : (
            <p className={`whitespace-pre-wrap text-sm ${comment.resolved ? "text-slate-400 line-through decoration-slate-600" : "text-slate-200"}`}>{comment.body}</p>
        )
    );

    const commentActions = (comment: ReviewComment, root: boolean) => (
        isDraft && editingComment?.id !== comment.id && (
            <div className="mt-1.5 flex flex-wrap justify-end gap-2 text-[11px] text-slate-400">
                {root && <button type="button" onClick={() => startReply(comment)} className="inline-flex items-center gap-1 hover:text-white" data-comment-reply=""><CornerDownRight size={11} /> Reply</button>}
                {root && <button type="button" onClick={() => void toggleResolved(comment)} className={`inline-flex items-center gap-1 hover:text-white ${comment.resolved ? "text-emerald-300" : ""}`} data-comment-resolve="" aria-pressed={Boolean(comment.resolved)}><Check size={11} /> {comment.resolved ? "Resolved" : "Resolve"}</button>}
                <button type="button" onClick={() => setEditingComment({ id: comment.id, text: comment.body, base: comment.body, saving: false })} className="inline-flex items-center gap-1 hover:text-white"><Pencil size={11} /> Edit</button>
                <button type="button" onClick={() => void removeComment(comment)} className="inline-flex items-center gap-1 hover:text-rose-200"><Trash2 size={11} /> Delete</button>
            </div>
        )
    );

    const commentList = (
        <ul className="space-y-2" data-comment-list="">
            {comments.length === 0 && (
                <li className="text-xs italic text-slate-500">
                    {mediaType === "markdown" || mediaType === "text" || mediaType === "code" || mediaType === "json"
                        ? "No comments yet. Tap a passage's comment control, select text, or add a note about the whole document."
                        : mediaType === "video" || mediaType === "audio" ? "No comments yet. Pause at a moment (or mark in/out) and use Comment at this time, or add a note about the whole file."
                            : mediaType === "pdf" ? "No comments yet. Use Comment on page, or add a note about the whole file."
                                : "No comments yet. Drag on an image to comment on a region, or add a note about the whole deliverable."}
                </li>
            )}
            {roots.map((comment) => {
                const index = pins.indexOf[comment.id];
                const isSelected = selectedComment === comment.id;
                return (
                    <li key={comment.id} className={`rounded-md border p-2.5 ${isSelected ? "border-cyan-500/60 bg-cyan-500/5" : "border-slate-800 bg-slate-950/70"}`} data-comment-id={comment.id} data-comment-kind={comment.kind}>
                        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                            {index && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-slate-950">{index}</span>}
                            {comment.kind === "document" ? (
                                <span className="font-semibold text-slate-200">{commentLabel(comment)}</span>
                            ) : (
                                <button type="button" onClick={() => jumpToComment(comment)} className="font-semibold text-cyan-200 hover:underline" data-comment-jump="">{commentLabel(comment)}</button>
                            )}
                            <AnchorChip comment={comment} changed={documentChanged} />
                            {comment.resolved && <span className="rounded-full border border-emerald-500/40 px-1.5 text-[10px] text-emerald-200">resolved</span>}
                            <span className="ml-auto">{formatWhen(comment.created_at)}</span>
                        </div>
                        {comment.kind === "passage" && (
                            <blockquote className="mb-1.5 whitespace-pre-wrap border-l-2 border-slate-700 pl-2 font-mono text-[11px] text-slate-500">
                                {comment.selection ? comment.selection : excerpt(comment.quote, 200)}
                            </blockquote>
                        )}
                        {commentBody(comment)}
                        {commentActions(comment, true)}
                        {repliesOf(comment.id).length > 0 && (
                            <ul className="mt-2 space-y-1.5 border-l-2 border-slate-800 pl-2.5" data-comment-replies="">
                                {repliesOf(comment.id).map((reply) => (
                                    <li key={reply.id} data-comment-id={reply.id}>
                                        <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-slate-500"><CornerDownRight size={10} /> reply · {formatWhen(reply.created_at)}</div>
                                        {commentBody(reply)}
                                        {commentActions(reply, false)}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </li>
                );
            })}
        </ul>
    );

    const submissionCard = submission && (
        <div className="rounded-lg border border-slate-700 bg-slate-950/80 p-3" data-submission-card="">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <DeliveryBadge submission={submission} />
                <span className="text-[11px] text-slate-500">Finished {formatWhen(review?.submitted_at)}</span>
            </div>
            {review?.approval_delegated && (
                <p className="mt-2 text-[11px] text-emerald-200" data-approval-delegated="">
                    Approval delegated: the executor that makes this change records your approval of the corrected revision, citing this review.
                </p>
            )}
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
                Finishing sends every comment verbatim, with its {textual ? "quoted passage" : "exact spot (screen, region, moment or page)"} and this {mediaLabel(mediaType).toLowerCase()}&apos;s revision, into your Praxis chat. Finishing with no comments is fine.
            </p>
            <p className="mt-1 text-[11px] text-emerald-100/70" data-finish-scope="">
                {delegateApproval
                    ? "Approval is delegated: once the executor makes the change you ask for, it records your approval of that corrected revision only, citing this review. Nothing goes to anyone else or gets published."
                    : "This is feedback only: it does not approve the document, and nothing goes to anyone else or gets published."}
            </p>
            <label className="mt-2 flex items-start gap-2 text-[11px] text-emerald-100/90" data-delegate-approval="">
                <input type="checkbox" checked={delegateApproval} onChange={(e) => setDelegateApproval(e.target.checked)} className="mt-0.5 accent-emerald-400" />
                <span>Approve once this change is made. Needs your verified session; the executor can record only this approval.</span>
            </label>
            <label className="mt-2 block text-[11px] font-semibold text-slate-300" htmlFor="review-summary-final">Summary (optional)</label>
            <textarea id="review-summary-final" value={summary} onChange={(e) => onSummaryChange(e.target.value)} className="mt-1 h-20 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-emerald-500/60" />
            {finishError && <p role="alert" className="mt-1 text-[11px] text-rose-200">{finishError}</p>}
            <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setFinishOpen(false)} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300">Keep reviewing</button>
                <button type="button" onClick={() => void finish()} disabled={finishing} className="inline-flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-100 disabled:opacity-50">
                    {finishing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send to Praxis
                </button>
            </div>
        </div>
    );

    const noteButtonLabel = textual && mediaType !== "design" ? "Add a note about the whole document" : "Add a note about the whole deliverable";
    const canNote = isDraft && (!documentChanged || showingPinned) && !showSource && !editing;

    // Unsaved text from before a reload that cannot go back where it was written. It is the reader's words, shown
    // verbatim with where they were meant for; placing it opens a composer, discarding it is the only way it goes away.
    const recoveredCard = recovered.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100" data-recovered-drafts="">
            <p className="font-semibold">Unsaved text from before this page reloaded</p>
            <p className="mt-0.5 text-[11px] text-amber-100/80">It was never saved and has not been moved; place it yourself or discard it.</p>
            <ul className="mt-2 space-y-2">
                {recovered.map((item) => (
                    <li key={item.id} className="rounded-md border border-amber-500/30 bg-slate-950/60 p-2" data-recovered-draft={item.id} data-recovered-reason={item.reason}>
                        <div className="text-[11px] text-amber-200/90">{item.label} · {recoveredReasonText(item.reason)}</div>
                        <pre className="mt-1 whitespace-pre-wrap font-sans text-sm text-slate-100" data-recovered-text="">{item.text}</pre>
                        <div className="mt-1.5 flex flex-wrap justify-end gap-2 text-[11px]">
                            {canNote && <button type="button" onClick={() => placeRecovered(item)} className="rounded border border-cyan-500/50 bg-cyan-500/15 px-2 py-1 text-cyan-100 hover:bg-cyan-500/25">Use as a note about the whole {textual && mediaType !== "design" ? "document" : "deliverable"}</button>}
                            <button type="button" onClick={() => void copyRecovered(item)} className="rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-slate-500">Copy</button>
                            <button type="button" onClick={() => discardRecovered(item)} className="rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-rose-400 hover:text-rose-200">Discard</button>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );

    const reviewPanel = (
        <div className="space-y-3" data-review-panel="">
            {data && <DecisionCard data={data} viewedRevision={shownRevision} viewingCurrent={!showingPinned} onRefresh={load} directions={directions} compact />}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100"><MessageSquare size={15} className="text-cyan-300" /> {documentChanged && !isDraft ? "Previous review" : "Your review"}</h2>
                <span className={`rounded-full border px-2 py-0.5 text-[11px] ${isDraft ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"}`}>{isDraft ? "Draft" : "Finished"}</span>
            </div>
            <div>{saveIndicator}</div>
            {recoveredCard}
            {submissionCard}
            {!isDraft && (
                <button type="button" onClick={() => void startNewReview()} className="text-[11px] text-cyan-300 hover:underline">Start a new review of this {mediaLabel(mediaType).toLowerCase()}</button>
            )}
            {isDraft && (!documentChanged || showingPinned) && !showSource && !editing && (
                <button type="button" onClick={startDocumentNote} className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 hover:border-cyan-500/50">
                    <MessageSquarePlus size={13} /> {noteButtonLabel}
                </button>
            )}
            <div className="hidden lg:block">{composerPanel}</div>
            {isDraft && (
                <div>
                    <label className="block text-[11px] font-semibold text-slate-300" htmlFor="review-summary">Summary (optional, saved as you type)</label>
                    <textarea id="review-summary" value={summary} onChange={(e) => onSummaryChange(e.target.value)} placeholder="Overall impression, decisions, what to do next…" className="mt-1 h-20 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-cyan-500/60" />
                    {summaryRestored && (
                        <p role="status" data-summary-restored="" className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-amber-200">
                            Summary restored from this browser after the page reloaded; it is not saved yet.
                            <button type="button" onClick={() => { if (summaryTimer.current) { window.clearTimeout(summaryTimer.current); summaryTimer.current = null; } void persistSummary(summary); }} className="underline">Save now</button>
                        </p>
                    )}
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
                    Comments ({comments.length})
                    {[passageComments.length > 0 && `${passageComments.length} passage`, mediaComments.length > 0 && `${mediaComments.length} on media`, documentNotes.length > 0 && `${documentNotes.length} whole-document`].filter(Boolean).length > 1
                        ? ` · ${[passageComments.length > 0 && `${passageComments.length} passage`, mediaComments.length > 0 && `${mediaComments.length} on media`, documentNotes.length > 0 && `${documentNotes.length} whole-document`].filter(Boolean).join(", ")}`
                        : ""}
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

    const navigatorTitle = mediaType === "markdown" ? "Contents" : mediaType === "design" ? "Screens" : "Markers";
    const outlinePanel = (
        <nav aria-label={navigatorTitle} className="text-xs" data-outline="">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500"><ListTree size={12} /> {navigatorTitle}</div>
            {mediaType === "markdown" ? (
                outline.length === 0 ? <p className="text-slate-500">No headings.</p> : (
                    <ul className="space-y-1">
                        {outline.map((entry) => (
                            <li key={entry.id} style={{ paddingLeft: `${Math.max(0, entry.level - 1) * 10}px` }}>
                                <button type="button" onClick={() => jumpTo(entry.line)} className="w-full truncate text-left text-slate-300 hover:text-cyan-200" title={entry.text}>{entry.text}</button>
                            </li>
                        ))}
                    </ul>
                )
            ) : mediaType === "design" ? (
                <ul className="space-y-1" data-navigator-screens="">
                    {assets.filter((a) => a.role === "screen").map((a) => (
                        <li key={a.asset_key}>
                            <button type="button" onClick={() => { setFocusAsset(a.asset_key); setOutlineOpen(false); }} className={`w-full truncate text-left hover:text-cyan-200 ${focusAsset === a.asset_key ? "text-cyan-200" : "text-slate-300"}`} title={a.label ?? a.asset_key}>
                                {a.label} <span className="text-slate-500">{[a.direction, a.appearance].filter(Boolean).join(" · ")}</span>
                                {pins.byAsset[a.asset_key]?.length ? <span className="ml-1 rounded-full bg-amber-400/20 px-1 text-[10px] text-amber-200">{pins.byAsset[a.asset_key].length}</span> : null}
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <ul className="space-y-1" data-navigator-markers="">
                    {mediaComments.length === 0 && <li className="text-slate-500">No markers yet.</li>}
                    {mediaComments.map((c) => (
                        <li key={c.id}>
                            <button type="button" onClick={() => jumpToComment(c)} className="flex w-full items-center gap-1.5 text-left text-slate-300 hover:text-cyan-200">
                                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-slate-950">{pins.indexOf[c.id]}</span>
                                <span className="truncate">{commentLabel(c)}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </nav>
    );

    /** The stage for the current media type and revision. */
    const stage = (() => {
        if (!data || !doc) return null;
        if (editing && data.revision) {
            return <TextEditor content={currentContent} mediaType={mediaType} baseRevisionHash={data.revision.content_hash} onSave={onEditSave} onCancel={() => setEditing(false)} onReload={() => { setEditing(false); void load(); }} />;
        }
        const revisionId = shownRevision?.id ?? null;
        const src = primary ? assetUrl(doc.id, primary.asset_key, { revision: revisionId }) : rawDocumentUrl(doc.id, { revision: revisionId });
        if (showSource && textual) {
            return <PlainText content={shownContent} mono counts={commentCounts} selected={selected} />;
        }
        switch (mediaType) {
            case "markdown":
                return <DocumentMarkdown content={shownContent} selected={selected} commentCounts={commentCounts} interactive={canAnnotate} onBlockSelect={startPassageComment} />;
            case "text":
            case "code":
            case "json":
                return <PlainText content={shownContent} mono={mediaType !== "text"} counts={commentCounts} selected={selected} onLine={canAnnotate ? (n) => startPassageComment({ start: n, end: n }) : undefined} />;
            case "html":
                return primary ? <PrototypeViewer src={src} assetKey={primary.asset_key} title={doc.title} pins={(pins.byAsset[primary.asset_key] ?? []).filter((p) => p.point).map((p) => ({ id: p.id, index: p.index, x: p.point!.x, y: p.point!.y, viewport: p.viewport, label: p.label, resolved: p.resolved }) as PointPin)} selectedPinId={selectedComment} onSelectPin={setSelectedComment} annotate={canAnnotate} onPoint={(point) => startPoint(primary.asset_key, point)} onLoadState={mediaLoad} /> : null;
            case "image":
            case "svg":
                return primary ? <ImageViewer src={src} alt={doc.title} assetKey={primary.asset_key} width={primary.width} height={primary.height} pins={pins.byAsset[primary.asset_key] ?? []} selectedPinId={selectedComment} onSelectPin={setSelectedComment} annotate={canAnnotate} onRegion={(region) => startRegion(primary.asset_key, region)} onLoadState={mediaLoad} /> : null;
            case "video":
            case "audio":
                return primary ? <VideoViewer src={src} assetKey={primary.asset_key} kind={mediaType} mimeType={primary.mime_type} markers={pins.time[primary.asset_key] ?? []} selectedMarkerId={selectedComment} onSelectMarker={setSelectedComment} annotate={canAnnotate} onTimestamp={startTimestamp} onLoadState={mediaLoad} seekTo={seekTo} /> : null;
            case "pdf":
                return primary ? <PdfViewer src={src} assetKey={primary.asset_key} markers={pins.pages[primary.asset_key] ?? []} selectedMarkerId={selectedComment} onSelectMarker={setSelectedComment} annotate={canAnnotate} onPage={startPage} onLoadState={mediaLoad} requestedPage={requestedPage} /> : null;
            case "design":
                return data.manifest ? (
                    <DesignPackageViewer
                        documentId={doc.id}
                        revisionId={revisionId}
                        manifest={data.manifest}
                        assets={assets}
                        pins={{ byAsset: pins.byAsset, selectedId: selectedComment, onSelect: setSelectedComment }}
                        annotate={canAnnotate}
                        onScreenRegion={startRegion}
                        onPreviewPoint={startPoint}
                        onLoadState={mediaLoad}
                        requestedAssetKey={focusAsset}
                        selectedDirection={selectedDirection}
                    />
                ) : <PlainText content={shownContent} mono counts={commentCounts} selected={selected} />;
            default:
                return <DocumentMarkdown content={shownContent} selected={selected} commentCounts={commentCounts} interactive={canAnnotate} onBlockSelect={startPassageComment} />;
        }
    })();

    // The rails stick where they start, just below the header, and end above the floating ticker, audio, voice and
    // feedback controls (lib/floating-controls), so their last controls, Finish review among them, scroll into open space
    // whether or not the page has scrolled. vh is divided by the display scale: under the body zoom 100vh is taller than
    // the window. Too short a window for that and they scroll with the page, which ends past the controls (layout
    // paddingBottom, root scroll padding); the header's height as scroll margin keeps focus from parking a control under it.
    const railPosition = railsFlow
        ? "[&_*]:scroll-mt-[var(--review-rail-top,6rem)]"
        : "sticky top-[var(--review-rail-top,6rem)] max-h-[max(8rem,calc(100vh/var(--nexus-display-scale,1)-var(--review-rail-top,6rem)-var(--nexus-floating-bottom,6rem)))] overflow-y-auto";

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30" data-document-review-page="" data-media-type={mediaType} style={headerHeight === null ? undefined : ({ "--review-rail-top": `calc(${headerHeight}px + 1.25rem)` } as CSSProperties)}>
            <header ref={headerRef} className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
                {/* Row 1: where you are and what you can do. Row 2: what this is. */}
                <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pt-2">
                    <div className="hidden min-w-0 sm:block">
                        <Breadcrumbs
                            parents={doc?.task_id
                                ? [{ label: "Task Board", href: "/task-board" }, { label: task?.title || "Task", href: `/task/${doc.task_id}` }]
                                : doc?.project_id
                                    ? [{ label: project?.name || "Project", href: `/project/${doc.project_id}` }]
                                    : [{ label: "Reviews", href: "/documents" }]}
                            current={doc?.title || "Document"}
                        />
                    </div>
                    {/* Phone: one step back instead of the full trail. */}
                    <Link href={doc?.task_id ? `/task/${doc.task_id}` : doc?.project_id ? `/project/${doc.project_id}` : "/documents"} className="max-w-[55%] truncate text-sm text-slate-400 hover:text-white sm:hidden" data-back-link="">
                        ← {doc?.task_id ? task?.title || "Task" : doc?.project_id ? project?.name || "Project" : "Reviews"}
                    </Link>
                    <Link href="/documents" className="flex shrink-0 items-center gap-1 text-sm text-slate-400 hover:text-white" data-all-documents-link="">
                        <FileCheck2 size={14} /> Reviews
                    </Link>
                    <div className="ml-auto flex max-w-full shrink-0 items-center gap-1.5 overflow-x-auto text-xs [scrollbar-width:none] sm:flex-wrap sm:overflow-visible" data-header-actions="">
                        {canEdit && (
                            <button type="button" onClick={() => { setEditing(true); setShowSource(false); setComposer(null); }} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-cyan-500/50 bg-cyan-500/10 px-2.5 py-1.5 text-cyan-100 hover:bg-cyan-500/20" data-edit-button="">
                                <Pencil size={13} /> Edit
                            </button>
                        )}
                        {textual && !editing && (
                            <button type="button" onClick={() => setShowSource((v) => !v)} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2.5 py-1.5 ${showSource ? "border-cyan-500/60 text-cyan-200" : "border-slate-700 text-slate-300 hover:border-slate-500"}`} aria-pressed={showSource}>
                                {showSource ? <FileText size={13} /> : <FileCode size={13} />} {showSource ? "Rendered" : "Source"}
                            </button>
                        )}
                        {data && (
                            <button type="button" onClick={() => setEvidenceOpen(true)} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-300 hover:border-slate-500" data-evidence-button="">
                                <ShieldCheck size={13} /> Evidence
                            </button>
                        )}
                        {doc && (
                            <>
                            {shownRevision && ['markdown', 'pdf', 'image', 'video'].includes(mediaType) && <PresentDocumentButton documentId={doc.id} revisionId={shownRevision.id} contentHash={shownRevision.content_hash} />}
                            <a href={rawDocumentUrl(doc.id, { revision: showingPinned ? review?.revision_id : null, download: true })} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-300 hover:border-slate-500">
                                <Download size={13} /> Download
                            </a>
                            </>
                        )}
                        <button type="button" onClick={() => void copyLink()} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-300 hover:border-slate-500">
                            {linkCopied ? <Check size={13} className="text-emerald-300" /> : null} {linkCopied ? "Link copied" : "Copy link"}
                        </button>
                    </div>
                </div>
                <div className="mx-auto max-w-[1600px] px-4 pb-2.5 pt-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${mediaTone(mediaType)}`} data-media-chip="">
                            <MediaIcon type={mediaType} size={12} /> {mediaLabel(mediaType)}
                        </span>
                        <h1 className="min-w-0 truncate text-base font-semibold leading-snug text-white" title={doc?.title}>{doc?.title || "Document"}</h1>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                        <DocumentStatusBadge status={data?.review_status} prefix />
                        {doc?.kind && doc.kind !== mediaType && <span className="uppercase tracking-wide">{doc.kind}</span>}
                        {asOf && <span>as of {asOf}</span>}
                        {shownRevision && (
                            <span title={shownRevision.content_hash} data-revision-chip="">
                                rev {shownRevision.content_hash.slice(0, 8)} · captured {formatWhen(shownRevision.captured_at)}{shownRevision.source === "nexus_edit" ? " · edited in Nexus" : ""}
                            </span>
                        )}
                        {data?.readiness && (
                            <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px ${data.readiness.ready ? "border-emerald-500/40 text-emerald-200" : "border-rose-500/40 text-rose-200"}`} data-readiness-chip={data.readiness.ready ? "ready" : "not-ready"} title="Whether every required visual of this revision is servable">
                                {data.readiness.ready ? <CheckCircle2 size={10} /> : <AlertTriangle size={10} />} visuals {data.readiness.required_ok}/{data.readiness.required_total}
                            </span>
                        )}
                        {task && (
                            <span>
                                from <Link href={`/task/${task.id}`} className="text-cyan-300 hover:underline">{task.title || task.id}</Link>
                                {(task.status || task.status_message) && (
                                    <span className="ml-1.5 rounded border border-slate-700 px-1.5 py-px text-slate-400" data-task-status="" title="Status of the task that produced this document (execution and QA), not your decision on the document">
                                        Task: {[task.status, task.status_message].filter(Boolean).join(" · ")}
                                    </span>
                                )}
                            </span>
                        )}
                        {project && <span>in <Link href={`/project/${project.id}`} className="text-cyan-300 hover:underline">{project.name || project.id}</Link></span>}
                    </div>
                    {brief && (
                        <div className="mt-2 max-w-3xl">
                            <HumanBriefBlock brief={brief} compact />
                        </div>
                    )}
                </div>
                {/* Phone controls: explicit buttons, no hover required. */}
                <div className="flex gap-2 border-t border-slate-800/80 px-4 py-2 lg:hidden">
                    <button type="button" onClick={() => setOutlineOpen(true)} className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-slate-700 bg-slate-900 py-2 text-xs text-slate-200">
                        <ListTree size={13} /> {navigatorTitle}
                    </button>
                    <button type="button" onClick={() => setReviewOpen(true)} className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 py-2 text-xs text-cyan-100" data-open-review="">
                        <MessageSquare size={13} /> Review &amp; decide ({comments.length})
                    </button>
                </div>
            </header>

            <div className="mx-auto max-w-[1600px] px-4 py-5 lg:grid lg:grid-cols-[200px_minmax(0,1fr)_380px] lg:gap-6">
                {/* Sticky or in the page flow: see railPosition. */}
                <aside className="hidden lg:block">
                    <div className={`${railPosition} pr-2`} data-rail-position={railsFlow ? "flow" : "sticky"}>{outlinePanel}</div>
                </aside>

                <article className="min-w-0" data-stage="">
                    {loadError && (
                        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
                            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {loadError}
                            <button type="button" onClick={() => void load()} className="ml-auto underline">Retry</button>
                        </div>
                    )}
                    {!data && !loadError && <div className="flex min-h-[320px] items-center justify-center text-cyan-300"><Loader2 className="animate-spin" size={28} /></div>}
                    {data && data.file_state !== "ok" && (
                        <div role="status" className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100">
                            The file on disk is currently unavailable ({data.file_error || data.file_state}). Showing the last captured revision{VISUAL_NOTE(mediaType)}.
                        </div>
                    )}
                    {data && documentChanged && (
                        <div role="status" className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100" data-changed-banner="">
                            <AlertTriangle size={14} className="shrink-0" />
                            <span className="min-w-0 flex-1">
                                A newer revision of this document was registered after the one your review covers.{" "}
                                {showingPinned
                                    ? `You are viewing rev ${reviewedHash}, the revision you reviewed; comments stay anchored to it. Decisions apply to the latest revision (rev ${latestHash}).`
                                    : `You are viewing the latest revision (rev ${latestHash}); you reviewed rev ${reviewedHash}, and your review's passage comments stay pinned to it and are not moved.`}
                            </span>
                            <button type="button" onClick={() => setViewRevision(showingPinned ? "current" : "pinned")} className="rounded-md border border-amber-400/50 px-2 py-1 text-amber-100 hover:bg-amber-500/20">
                                {showingPinned ? "View current file" : "View reviewed revision"}
                            </button>
                            {!isDraft && !showingPinned && (
                                <button type="button" onClick={() => void startNewReview()} className="rounded-md border border-cyan-400/50 px-2 py-1 text-cyan-100 hover:bg-cyan-500/20">Review this revision</button>
                            )}
                        </div>
                    )}
                    {data && <OutgoingCard data={data} viewingCurrent={!showingPinned} onRefresh={load} />}
                    {/* The decision heads the review rail (desktop) and the Review & decide drawer (phone), so the stage stays the visual. */}
                    {stage}
                </article>

                <aside className="hidden lg:block">
                    <div className={`${railPosition} rounded-xl border border-slate-800 bg-slate-900/40 p-3`} data-rail-position={railsFlow ? "flow" : "sticky"}>{reviewPanel}</div>
                </aside>
            </div>

            {/* Phone sheets and drawers pad their ends past the mini player and feedback launcher, which stay on top of them;
                the scroll padding keeps a focused or scrolled-to control (Send to Praxis) out from under them too. */}
            {/* Phone: composer sheet */}
            {composer && (
                <div className="fixed inset-x-0 bottom-0 z-[70] max-h-[calc(70vh/var(--nexus-display-scale,1))] overflow-y-auto border-t border-cyan-500/40 bg-slate-950 p-3 pb-[max(1.5rem,var(--nexus-floating-overlay-bottom,0px))] scroll-pb-[var(--nexus-floating-overlay-bottom,0px)] shadow-2xl lg:hidden" data-composer-sheet="">
                    {composerPanel}
                </div>
            )}

            {/* Phone: navigator drawer */}
            {outlineOpen && (
                <div className="fixed inset-0 z-[80] lg:hidden" role="dialog" aria-label={navigatorTitle}>
                    <button type="button" aria-label={`Close ${navigatorTitle.toLowerCase()}`} onClick={() => setOutlineOpen(false)} className="absolute inset-0 bg-black/60" />
                    <div className="absolute inset-x-0 bottom-0 max-h-[calc(75vh/var(--nexus-display-scale,1))] overflow-y-auto rounded-t-2xl border-t border-slate-700 bg-slate-950 p-4 pb-[max(2rem,var(--nexus-floating-overlay-bottom,0px))] scroll-pb-[var(--nexus-floating-overlay-bottom,0px)]">
                        <div className="mb-2 flex justify-end"><button type="button" onClick={() => setOutlineOpen(false)} aria-label="Close" className="rounded p-1 text-slate-400"><X size={16} /></button></div>
                        {outlinePanel}
                    </div>
                </div>
            )}

            {/* Phone: review drawer */}
            {reviewOpen && (
                <div className="fixed inset-0 z-[80] lg:hidden" role="dialog" aria-label="Your review">
                    <button type="button" aria-label="Close review" onClick={() => setReviewOpen(false)} className="absolute inset-0 bg-black/60" />
                    <div className="absolute inset-x-0 bottom-0 max-h-[calc(85vh/var(--nexus-display-scale,1))] overflow-y-auto rounded-t-2xl border-t border-slate-700 bg-slate-950 p-4 pb-[max(2rem,var(--nexus-floating-overlay-bottom,0px))] scroll-pb-[var(--nexus-floating-overlay-bottom,0px)]" data-review-drawer="">
                        <div className="mb-2 flex justify-end"><button type="button" onClick={() => setReviewOpen(false)} aria-label="Close" className="rounded p-1 text-slate-400"><X size={16} /></button></div>
                        {reviewPanel}
                    </div>
                </div>
            )}

            {data && <EvidenceDrawer data={data} assets={assets} loadStates={loadStates} open={evidenceOpen} onClose={() => setEvidenceOpen(false)} />}
        </main>
    );
}

function VISUAL_NOTE(mediaType: MediaType): string {
    return ["markdown", "text", "code", "json"].includes(mediaType) ? "" : "; its assets still serve from the review store";
}
