/**
 * review-drafts: keep unsaved review text (a comment being composed, a saved
 * comment being edited, a summary the autosave has not sent yet) across a
 * reload or remount of the document review page.
 *
 * Why: the live dashboard is a hot-reloading `next dev`. On 2026-10-19 an
 * executor saved a module the root layout imports that is not Fast Refresh
 * safe, so every open page performed a full reload, twice, while Robert was
 * typing a comment on the Groundrules launch readiness report. The composer
 * lived in React state only; both drafts were gone and nothing had reached
 * the server (task 1390fc34). Comments only persist when "Save comment" is
 * acknowledged, so the text before that click needs a home of its own.
 *
 * The draft is written to storage as it is typed, keyed by document, with
 * what it was written for: the revision on screen, the reviewer the page was
 * serving, the open review and the comment anchor. Restoring is decided by
 * `reconcileReviewDraft`: text goes back into a composer only when that
 * binding still holds; otherwise it is kept as recovered text for the reader
 * to place. A draft is never moved to another document, revision, reviewer
 * or parent comment, and restoring never saves anything by itself.
 *
 * localStorage first (it survives a reload, the sign-in round trip and an
 * app-shell restart), sessionStorage as the fallback. Every call is wrapped:
 * storage that is disabled or full must never break typing. Only review text
 * is stored, never a credential.
 */

import type { CommentKind, MediaAnchor } from "./document-review";

export const REVIEW_DRAFT_PREFIX = "nexus:document-review-draft:";

/** Drafts older than this are ignored on read; the next keystroke replaces them. */
export const REVIEW_DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Recovered passages kept per document; the oldest drops first. */
export const REVIEW_DRAFT_MAX_RECOVERED = 8;

/** The kinds whose text is tied to a place in one revision's bytes or assets. */
const ANCHORED_KINDS: ReadonlySet<string> = new Set(["passage", "region", "point", "time", "page", "screen"]);

export interface ComposerDraft {
    /** The idempotency id of the comment being written, so a retry after a reload is the same save. */
    client_id: string;
    kind: CommentKind;
    text: string;
    block?: { start: number; end: number };
    quote?: string;
    selection?: string;
    anchor?: MediaAnchor;
    label?: string;
    parent_id?: string;
}

export interface CommentEditDraft {
    comment_id: string;
    /** The comment body the edit started from; a comment changed elsewhere is not overwritten blindly. */
    base_body: string;
    text: string;
}

export interface SummaryDraft {
    text: string;
    /** The server summary the text was typed over; a summary saved elsewhere since then wins. */
    base: string;
}

export type RecoveredReason = "revision" | "review" | "parent" | "comment";

/** Text whose binding no longer holds: shown to the reader, never re-anchored. */
export interface RecoveredDraft {
    id: string;
    text: string;
    /** Where it was written for, in the reader's words ("Comment on lines 7–8", "Reply", "Edit of a comment"). */
    label: string;
    reason: RecoveredReason;
    revision_id: string | null;
    saved_at: string;
}

export interface ReviewDraft {
    document_id: string;
    /** The revision on screen when the text was written; never re-anchored to another. */
    revision_id: string | null;
    content_hash: string | null;
    /** The reviewer the page was serving (null when the API did not report one). */
    reviewer_id: string | null;
    /** The open draft review at the time, when one existed. */
    review_id: string | null;
    composer: ComposerDraft | null;
    edit: CommentEditDraft | null;
    summary: SummaryDraft | null;
    recovered: RecoveredDraft[];
    saved_at: string;
}

export interface LiveReviewComment {
    id: string;
    body: string;
    kind?: string;
    /** The idempotency id the reviewer sent with the save; an API that predates it reports none. */
    client_id?: string | null;
    parent_id?: string | null;
    start_line?: number | null;
    end_line?: number | null;
    quote?: string | null;
    anchor_target?: { asset_key?: string | null } | null;
}

export interface LiveReviewState {
    document_id: string;
    /** The revision on screen now. */
    revision_id: string | null;
    reviewer_id: string | null;
    review: { id: string; status: string; summary: string; comments: LiveReviewComment[] } | null;
}

export type ComposerPlan =
    /**
     * Back into the composer. `same_as` names a saved comment with the same text at the same place when the
     * server reported no client ids, so the save could not be confirmed as this draft's: the reader decides.
     */
    | { restore: ComposerDraft; same_as?: string }
    | { recovered: ComposerDraft; reason: RecoveredReason }
    /** The save reached the server before the reload (its client id is on a comment): the draft is done. */
    | { saved: ComposerDraft; comment_id: string };
export type EditPlan = { restore: CommentEditDraft } | { recovered: CommentEditDraft; reason: RecoveredReason };

export interface DraftReconciliation {
    /** The draft belongs to another document or another reviewer: leave it alone and show nothing. */
    foreign: boolean;
    composer: ComposerPlan | null;
    edit: EditPlan | null;
    summary: { restore: string } | null;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type DraftStores = DraftStorage | DraftStorage[] | null;

function defaultStorage(): DraftStorage[] {
    const stores: DraftStorage[] = [];
    if (typeof window === "undefined") return stores;
    for (const name of ["localStorage", "sessionStorage"] as const) {
        try {
            if (window[name]) stores.push(window[name]);
        } catch {
            /* Access can fail independently for either store. */
        }
    }
    return stores;
}

function storageList(storage: DraftStores): DraftStorage[] {
    return Array.isArray(storage) ? storage : storage ? [storage] : [];
}

export function reviewDraftKey(documentId: string): string {
    return `${REVIEW_DRAFT_PREFIX}${documentId}`;
}

const isText = (value: unknown): value is string => typeof value === "string";
const textOrNull = (value: unknown): string | null => (isText(value) ? value : null);
const hasText = (value: string | null | undefined): value is string => isText(value) && value.trim().length > 0;

function parseComposer(value: unknown): ComposerDraft | null {
    if (!value || typeof value !== "object") return null;
    const c = value as Record<string, unknown>;
    if (!isText(c.client_id) || !isText(c.kind) || !hasText(textOrNull(c.text))) return null;
    const draft: ComposerDraft = { client_id: c.client_id, kind: c.kind as CommentKind, text: c.text as string };
    const block = c.block as Record<string, unknown> | undefined;
    if (block && typeof block.start === "number" && typeof block.end === "number") draft.block = { start: block.start, end: block.end };
    if (isText(c.quote)) draft.quote = c.quote;
    if (isText(c.selection)) draft.selection = c.selection;
    if (c.anchor && typeof c.anchor === "object" && isText((c.anchor as Record<string, unknown>).asset_key)) draft.anchor = c.anchor as MediaAnchor;
    if (isText(c.label)) draft.label = c.label;
    if (isText(c.parent_id)) draft.parent_id = c.parent_id;
    return draft;
}

function parseEdit(value: unknown): CommentEditDraft | null {
    if (!value || typeof value !== "object") return null;
    const e = value as Record<string, unknown>;
    if (!isText(e.comment_id) || !isText(e.base_body) || !hasText(textOrNull(e.text))) return null;
    return { comment_id: e.comment_id, base_body: e.base_body, text: e.text as string };
}

function parseSummary(value: unknown): SummaryDraft | null {
    if (!value || typeof value !== "object") return null;
    const s = value as Record<string, unknown>;
    if (!isText(s.text) || !isText(s.base)) return null;
    return { text: s.text, base: s.base };
}

const REASONS: ReadonlySet<string> = new Set(["revision", "review", "parent", "comment"]);

function parseRecovered(value: unknown): RecoveredDraft[] {
    if (!Array.isArray(value)) return [];
    const list: RecoveredDraft[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        if (!isText(r.id) || !hasText(textOrNull(r.text)) || !isText(r.label) || !isText(r.reason) || !REASONS.has(r.reason) || !isText(r.saved_at)) continue;
        list.push({ id: r.id, text: r.text as string, label: r.label, reason: r.reason as RecoveredReason, revision_id: textOrNull(r.revision_id), saved_at: r.saved_at });
    }
    return list.slice(-REVIEW_DRAFT_MAX_RECOVERED);
}

function parseDraft(raw: string | null, now: number): ReviewDraft | null {
    if (!raw) return null;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!value || typeof value !== "object") return null;
    const d = value as Record<string, unknown>;
    if (!isText(d.document_id) || !isText(d.saved_at)) return null;
    const savedAt = Date.parse(d.saved_at);
    if (Number.isNaN(savedAt) || now - savedAt > REVIEW_DRAFT_MAX_AGE_MS) return null;
    const draft: ReviewDraft = {
        document_id: d.document_id,
        revision_id: textOrNull(d.revision_id),
        content_hash: textOrNull(d.content_hash),
        reviewer_id: textOrNull(d.reviewer_id),
        review_id: textOrNull(d.review_id),
        composer: parseComposer(d.composer),
        edit: parseEdit(d.edit),
        summary: parseSummary(d.summary),
        recovered: parseRecovered(d.recovered),
        saved_at: d.saved_at,
    };
    return isEmptyReviewDraft(draft) ? null : draft;
}

/** Nothing worth keeping: no composer text, no edit text, no summary text, nothing recovered. */
export function isEmptyReviewDraft(draft: Pick<ReviewDraft, "composer" | "edit" | "summary" | "recovered">): boolean {
    return !hasText(draft.composer?.text) && !hasText(draft.edit?.text) && !hasText(draft.summary?.text) && draft.recovered.length === 0;
}

/** Read both stores: a fallback write must not be hidden by an older local copy. */
export function readReviewDraft(documentId: string, storage: DraftStores = defaultStorage(), now: number = Date.now()): ReviewDraft | null {
    let latest: ReviewDraft | null = null;
    for (const store of storageList(storage)) {
        try {
            const draft = parseDraft(store.getItem(reviewDraftKey(documentId)), now);
            // Writers use Date.toISOString(): UTC ISO timestamps sort chronologically as strings.
            if (draft && (!latest || draft.saved_at >= latest.saved_at)) latest = draft;
        } catch {
            /* A failing read must not prevent trying the other store. */
        }
    }
    return latest;
}

/** Return whether the draft persisted; an empty draft clears both stores. */
export function writeReviewDraft(documentId: string, draft: ReviewDraft, storage: DraftStores = defaultStorage()): boolean {
    if (isEmptyReviewDraft(draft)) return clearReviewDraft(documentId, storage);
    const stores = storageList(storage);
    const key = reviewDraftKey(documentId);
    const record = { ...draft, recovered: draft.recovered.slice(-REVIEW_DRAFT_MAX_RECOVERED) };
    for (const store of stores) {
        try {
            store.setItem(key, JSON.stringify(record));
        } catch {
            continue; // Quota/security failure: try sessionStorage too.
        }
        // Keep only the successful copy so switching stores cannot resurrect an old draft.
        for (const other of stores) {
            if (other === store) continue;
            try { other.removeItem(key); } catch { /* read chooses the newest if removal is blocked */ }
        }
        return true;
    }
    return false; // The mounted textarea is now the only copy we can promise.
}

export function clearReviewDraft(documentId: string, storage: DraftStores = defaultStorage()): boolean {
    let cleared = true;
    for (const store of storageList(storage)) {
        try {
            store.removeItem(reviewDraftKey(documentId));
        } catch {
            cleared = false;
        }
    }
    return cleared;
}

/** Whether a saved comment sits where the draft was written: same kind, same parent, same lines and quote or the same asset. */
function samePlace(c: ComposerDraft, comment: LiveReviewComment): boolean {
    if (comment.kind && comment.kind !== c.kind) return false;
    if ((comment.parent_id ?? null) !== (c.parent_id ?? null)) return false;
    if (c.kind === "passage") {
        return (comment.start_line ?? null) === (c.block?.start ?? null)
            && (comment.end_line ?? null) === (c.block?.end ?? null)
            && (comment.quote ?? null) === (c.quote ?? null);
    }
    if (c.anchor) return (comment.anchor_target?.asset_key ?? null) === c.anchor.asset_key;
    return true;
}

/**
 * Whether a composer draft's save reached the server before the page went away.
 * Only the draft's own client id on a saved comment proves it; a draft is
 * never dropped on wording alone. The same words at another place are a
 * different comment (2026-10-19 QA probe: "Please clarify." saved on lines 7-8
 * and typed again on line 3 was discarded by the earlier body match). When the
 * API reports no client ids at all (a server that predates them), identity
 * cannot be confirmed: a comment with the same text at the same place is
 * returned as `twin`, a hint for the reader, and the draft is kept. Saving a
 * kept draft whose save did land is idempotent on the server (same client id).
 */
function savedIdentity(c: ComposerDraft, comments: LiveReviewComment[]): { saved: LiveReviewComment | null; twin: LiveReviewComment | null } {
    const byClientId = comments.find((comment) => comment.client_id && comment.client_id === c.client_id) ?? null;
    if (byClientId) return { saved: byClientId, twin: null };
    if (comments.some((comment) => comment.client_id)) return { saved: null, twin: null };
    const text = c.text.trim();
    return { saved: null, twin: comments.find((comment) => comment.body === text && samePlace(c, comment)) ?? null };
}

/**
 * Decide what a stored draft may do on the page as it is now. Pure: the
 * caller applies the plan. The rules, in order of what they protect:
 *  - another document or another known reviewer: foreign, show nothing;
 *  - a comment whose save already reached the server, proven by its client
 *    id on a saved comment: done, nothing to restore; wording alone never
 *    discards a draft, and without client ids a same-text comment at the
 *    same place is only pointed out;
 *  - a finished review cannot take new or edited comments: recovered text;
 *  - a reply whose parent is gone: recovered text;
 *  - an anchored comment written for a different revision: recovered text,
 *    never re-anchored to the revision on screen;
 *  - an edit of a comment that was removed or changed elsewhere: recovered;
 *  - a summary typed over the server summary that is still current, or that
 *    continues what the server has (the autosave landed, its reply did not):
 *    restored; a summary the server has since moved past is dropped, since
 *    the server copy is the newer one.
 */
export function reconcileReviewDraft(draft: ReviewDraft, live: LiveReviewState): DraftReconciliation {
    const none: DraftReconciliation = { foreign: false, composer: null, edit: null, summary: null };
    if (draft.document_id !== live.document_id) return { ...none, foreign: true };
    if (draft.reviewer_id && live.reviewer_id && draft.reviewer_id !== live.reviewer_id) return { ...none, foreign: true };
    const review = live.review;
    const reviewOpen = !review || review.status === "draft";
    const comments = review?.comments ?? [];
    const plan: DraftReconciliation = { ...none };

    if (draft.composer && hasText(draft.composer.text)) {
        const c = draft.composer;
        const { saved, twin } = savedIdentity(c, comments);
        if (saved) plan.composer = { saved: c, comment_id: saved.id };
        else if (!reviewOpen) plan.composer = { recovered: c, reason: "review" };
        else if (c.parent_id && !comments.some((comment) => comment.id === c.parent_id)) plan.composer = { recovered: c, reason: "parent" };
        else if (ANCHORED_KINDS.has(c.kind) && draft.revision_id && live.revision_id && draft.revision_id !== live.revision_id) plan.composer = { recovered: c, reason: "revision" };
        else plan.composer = twin ? { restore: c, same_as: twin.id } : { restore: c };
    }

    if (draft.edit && hasText(draft.edit.text)) {
        const e = draft.edit;
        const target = comments.find((comment) => comment.id === e.comment_id) ?? null;
        if (!reviewOpen || !review) plan.edit = { recovered: e, reason: "review" };
        else if (!target || (target.body !== e.base_body && target.body !== e.text.trim())) plan.edit = { recovered: e, reason: "comment" };
        else if (e.text.trim() !== target.body) plan.edit = { restore: e };
    }

    if (draft.summary && reviewOpen) {
        const serverSummary = review?.summary ?? "";
        const text = draft.summary.text;
        const continues = serverSummary.length > 0 && text.startsWith(serverSummary);
        if (text !== serverSummary && (draft.summary.base === serverSummary || continues)) plan.summary = { restore: text };
    }

    return plan;
}
