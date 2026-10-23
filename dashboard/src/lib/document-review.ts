// Client for the Markdown document review API (/api/documents), reached
// through the dashboard's /api proxy so the same code works on the desktop,
// the phone shell and the Cloudflare tunnel. Types mirror the server's
// server/routes/documents.js responses.

/** `superseded`: a draft round closed read-only when replacement work on the document was accepted (contract §12); its comments are kept. */
export type ReviewStatus = 'draft' | 'submitted' | 'superseded';
export type DeliveryStatus = 'queued' | 'relaying' | 'delivered' | 'failed';
export type AnchorStateName = 'intact' | 'moved' | 'orphaned' | 'document';
/** The document's editorial state, derived by the server (contract docs/contracts/document-review-deliverables.md §3). */
export type DocumentReviewStatus = 'needs_review' | 'changes_requested' | 'approved' | 'reference';
/** List buckets: the four editorial states plus `in_progress`, documents with open replacement work (contract §12). */
export type DocumentListBucket = DocumentReviewStatus | 'in_progress';
export type DocumentStatusFilter = DocumentListBucket | 'all';

/** Replacement work on a document (contract §12): one open item at a time, from acceptance to a ready new version or an explicit failure/cancellation. */
export type ReplacementState = 'accepted' | 'queued' | 'held' | 'running' | 'implemented' | 'qa_passed' | 'ready' | 'failed' | 'cancelled';
export interface DocumentReplacement {
    id: string;
    document_id: string;
    state: ReplacementState;
    open: boolean;
    terminal: boolean;
    detail: string | null;
    qa_state: 'pending' | 'passed' | 'failed' | null;
    /** The revision the work replaces and, once registered under the work's task, the revision it produced. */
    base_revision_id: string;
    result_revision_id: string | null;
    task_id: string | null;
    execution_id: string | null;
    attempt: number;
    recovers_replacement_id: string | null;
    client_request_id: string;
    source: { submission_id: string | null; review_id: string | null; decision_id: string | null; authority: string | null; submission_delivery_status: DeliveryStatus | null };
    superseded_review_ids: string[];
    accepted_by: string;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
    links: { task_path: string | null; review_path: string; result_raw_path: string | null; self_path: string };
}
/** A list row's compact view of the work that governs the document: open work, or a failed or cancelled attempt whose bytes are the current revision. */
export interface ListReplacement { id: string; state: ReplacementState; task_id: string | null; attempt: number; open: boolean }
/**
 * Why a version takes no review actions: work in progress; the current revision
 * registered by an attempt that failed or was cancelled and was never declared
 * ready (closed until an explicit recovery delivers a new version); no revision;
 * or a visual revision whose required asset is missing (contract §12.4, 12.5).
 */
export type ReviewabilityReason = 'replacement_in_progress' | 'replacement_failed' | 'no_revision' | 'revision_not_ready';
/** Whether the document takes review actions right now (a new review, a decision, an edit); separate from `review_status`. */
export interface Reviewability { ok: boolean; reason: ReviewabilityReason | null; replacement_id: string | null }
export type IntendedAction = 'none' | 'implement' | 'send' | 'publish';
export type DecisionKind = 'approve' | 'request_changes';

export const DOCUMENT_KINDS = ['document', 'report', 'spec', 'plan', 'research', 'walkthrough', 'other', 'design', 'image', 'video', 'audio', 'prototype', 'pdf', 'data'] as const;

/** Media model (contract docs/contracts/review-media-and-design-packages.md §1). */
export type MediaType = 'markdown' | 'text' | 'code' | 'json' | 'html' | 'svg' | 'image' | 'video' | 'audio' | 'pdf' | 'design';
export const MEDIA_TYPES: readonly MediaType[] = ['markdown', 'text', 'code', 'json', 'html', 'svg', 'image', 'video', 'audio', 'pdf', 'design'];
export const EDITABLE_MEDIA: ReadonlySet<MediaType> = new Set<MediaType>(['markdown', 'text', 'code', 'json', 'html', 'svg', 'design']);
export const VISUAL_MEDIA: ReadonlySet<MediaType> = new Set<MediaType>(['design', 'image', 'video', 'audio', 'pdf', 'html', 'svg']);

export type AssetRole = 'primary' | 'screen' | 'before' | 'tokens' | 'preview' | 'evidence';

/** One asset of a revision: the file itself (`primary`) or a design package member, addressed by asset key. */
export interface RevisionAsset {
    asset_key: string;
    role: AssetRole;
    path: string;
    media_type: MediaType;
    mime_type: string;
    byte_length: number;
    content_hash: string;
    label: string | null;
    direction: string | null;
    appearance: 'light' | 'dark' | null;
    viewport: string | null;
    state: string | null;
    before_asset_key: string | null;
    order: number;
    width: number | null;
    height: number | null;
}

export interface DesignDirection { id: string; title: string; summary?: string | null; recommended?: boolean }
export interface DesignScreen {
    id: string; title: string; file: string; before: string | null;
    direction: string | null; appearance: 'light' | 'dark' | null; viewport: string | null; state: string | null; notes: string | null;
}
export interface DesignManifest {
    format: 'nexus-design-package/1';
    title: string;
    summary: string | null;
    directions: DesignDirection[];
    screens: DesignScreen[];
    tokens: string | null;
    previews: { id: string; title: string; file: string; viewport: string | null }[];
    evidence: { id: string; label: string; file: string }[];
    source: { provider?: string; project_id?: string; project_url?: string; session_id?: string; stage?: string } | null;
}

export interface ReadinessCheck {
    asset_key: string; role: AssetRole; required: boolean; ok: boolean;
    status: 'servable' | 'missing' | 'changed' | 'undecodable' | 'too_large';
    byte_length: number; content_hash: string; mime_type: string; media_type: MediaType; source?: 'blob' | 'disk';
}
export interface Readiness {
    document_id: string; revision_id: string; content_hash: string; media_type: MediaType;
    ready: boolean; checked_at: string; checks: ReadinessCheck[]; required_total: number; required_ok: number;
}

/** Comment kinds beyond Markdown passages, each with the anchor it carries (contract §3.1). */
export type MediaCommentKind = 'region' | 'point' | 'time' | 'page' | 'screen';
export type CommentKind = 'passage' | 'document' | MediaCommentKind;
export const MEDIA_COMMENT_KINDS: ReadonlySet<string> = new Set(['region', 'point', 'time', 'page', 'screen']);
export interface Region { x: number; y: number; w: number; h: number }
export type MediaAnchor =
    | ({ asset_key: string } & Region)
    | { asset_key: string; x: number; y: number; viewport?: string }
    | { asset_key: string; t_start: number; t_end?: number }
    | ({ asset_key: string; page: number } & Partial<Region>)
    | { asset_key: string; region?: Region };
/** The stored anchor as the server returns it (with the asset hash it was pinned to). */
export type StoredAnchor = MediaAnchor & { asset_hash?: string };

export interface DocumentBlockingTask {
    id: string;
    title: string;
    status: string;
    project_id: string | null;
    project_name?: string;
}

export interface DocumentRecord {
    id: string;
    title: string;
    path: string;
    root_project_id: string | null;
    project_id: string | null;
    task_id: string | null;
    kind: string;
    metadata: Record<string, unknown>;
    current_revision_id: string | null;
    registered_by: string | null;
    created_at: string;
    updated_at: string;
    /** Declared-deliverable fields; absent on an API that predates the review contract. */
    deliverable_key?: string | null;
    purpose?: string | null;
    requires_review?: boolean;
    blocking_task_ids?: string[];
    intended_action?: IntendedAction;
    /** Media model; absent on an API that predates it (then Markdown). */
    media_type?: MediaType;
    mime_type?: string;
}

export interface DocumentDecision {
    id: string;
    document_id: string;
    revision_id: string;
    content_hash: string;
    decision: DecisionKind;
    actor_id: string;
    authority: string;
    note: string;
    client_decision_id: string | null;
    intended_action: IntendedAction;
    /** What the decision chose when the deliverable offered a choice (a design package's direction). */
    selection?: { direction?: string } & Record<string, unknown> | null;
    created_at: string;
}

export interface RevisionMeta {
    id: string;
    document_id: string;
    content_hash: string;
    byte_length: number;
    line_count: number;
    file_mtime: string | null;
    captured_at: string;
    media_type?: MediaType;
    mime_type?: string;
    /** `capture` for the producer's bytes, `nexus_edit` for a revision written from the reviewer. */
    source?: 'capture' | 'nexus_edit';
    edited_by?: string | null;
    asset_count?: number;
    width?: number | null;
    height?: number | null;
    /** 1-based version within the document (capture order); absent on an API that predates it. */
    version?: number | null;
}

export interface ReviewComment {
    id: string;
    kind: CommentKind;
    start_line: number | null;
    end_line: number | null;
    block_hash: string | null;
    quote: string | null;
    selection: string | null;
    body: string;
    /** Media anchor (region, point, time, page, screen) and the label the reviewer saw. */
    anchor_target?: StoredAnchor | null;
    target_label?: string | null;
    /** A reply's root comment in the same review; null for a root. */
    parent_id?: string | null;
    /** The idempotency id the reviewer sent; absent on an API that predates it. */
    client_id?: string | null;
    resolved?: boolean;
    resolved_at?: string | null;
    created_at: string;
    updated_at: string;
    anchor?: { state: AnchorStateName; current_start_line?: number | null; current_asset_key?: string | null };
}

export interface SubmissionView {
    id: string;
    review_id: string;
    document_id: string;
    revision_id: string;
    delivery_status: DeliveryStatus;
    delivery_attempts: number;
    next_attempt_at: string | null;
    last_error: string | null;
    delivered_at: string | null;
    receipt: { conversation_id: string; user_message_id: string; assistant_message_id: string; delivered_at: string } | null;
    review_url: string | null;
    created_at: string;
    updated_at: string;
    message_text?: string;
}

export interface ReviewView {
    id: string;
    document_id: string;
    revision_id: string;
    reviewer_id: string;
    status: ReviewStatus;
    summary: string;
    created_at: string;
    updated_at: string;
    submitted_at: string | null;
    /** The operator proof the finish carried (access_user, access_device, operator_credential) or null for an unsigned finish. */
    submitted_authority?: string | null;
    /** Robert's explicit approve-after-changes grant: the executor applying this review may record his approval of the result. */
    approval_delegated?: boolean;
    comments: ReviewComment[];
    pinned_revision: RevisionMeta | null;
    document_changed: boolean;
    pinned_content?: string;
    submission: SubmissionView | null;
    /** Set when the round was closed read-only by accepted replacement work (status `superseded`). */
    closed_at?: string | null;
    closed_reason?: string | null;
    replacement_id?: string | null;
    is_current_revision?: boolean;
}

export interface DocumentSource {
    task: { id: string; title: string | null; status: string | null; status_message: string | null; project_id: string | null; updated_at: string | null } | null;
    project: { id: string; name: string | null; path: string | null } | null;
}

/** Sending authority is separate from the document's editorial decision. */
export interface DocumentOutgoing {
    document_id: string;
    revision_id: string;
    content_hash: string;
    envelope_hash: string;
    delivery_id: string;
    status: 'draft' | 'approved' | 'delivering' | 'sent' | 'uncertain' | 'cancelled';
    envelope: { to: string; cc: string[]; subject: string; text: string; attachments: never[] };
    provenance: { member_id: string; project_id: string; task_id: string; source_refs: string[]; commitment_id?: string };
    grant: { decision: 'approve_send'; authority: string; actor_id: string; approved_at: string } | null;
    invalidated_at?: string | null;
    invalidation_reason?: string | null;
    claimed_at?: string | null;
    receipt?: { delivery_id: string; status: 'sent' | 'uncertain'; message_id?: string } | null;
    created_at: string;
    updated_at: string;
}

export interface DocumentResponse {
    blocking_tasks?: DocumentBlockingTask[];
    document: DocumentRecord;
    revision: RevisionMeta | null;
    content: string | null;
    /** Media model; absent on an API that predates it (then a Markdown document with one text asset). */
    media_type?: MediaType;
    mime_type?: string;
    asset_count?: number;
    editable?: boolean;
    preview_asset_key?: string | null;
    readiness_path?: string | null;
    assets?: RevisionAsset[];
    manifest?: DesignManifest | null;
    readiness?: Readiness | null;
    file_state: string;
    file_error: string | null;
    source: DocumentSource;
    review: ReviewView | null;
    review_status?: DocumentReviewStatus;
    outgoing?: DocumentOutgoing | null;
    current_decision?: (DocumentDecision & { applies_to_current_revision: boolean }) | null;
    /** The reviewer this read is for; absent on an API that predates it. Unsaved review text is bound to it. */
    viewer?: { id: string } | null;
    /** Version lifecycle (contract §12): the open or latest replacement work, whether this version takes review actions, and where it sits in the document's versions. Absent on an API that predates it. */
    replacement?: DocumentReplacement | null;
    reviewable?: Reviewability;
    version?: { current_revision_id: string | null; current_version: number | null; revision_count: number };
    links: { review_url: string; raw_url: string; review_path?: string };
}

export interface DocumentListEntry extends DocumentRecord {
    blocking_tasks?: DocumentBlockingTask[];
    blocking_task_count?: number;
    asset_count?: number;
    editable?: boolean;
    preview_asset_key?: string | null;
    current_revision: RevisionMeta | null;
    review_url: string;
    review_path?: string;
    review_status?: DocumentReviewStatus;
    /** Open replacement work and whether this version takes review actions (contract §12); absent on an API that predates them. */
    replacement?: ListReplacement | null;
    reviewable?: boolean;
    review_state: { review_id: string; status: ReviewStatus; updated_at: string; comment_count: number; delivery_status: DeliveryStatus | null; closed_reason?: string | null } | null;
}

export interface DocumentListFilters {
    status?: DocumentStatusFilter;
    task_id?: string;
    project_id?: string;
    kind?: string;
    q?: string;
    limit?: number;
    offset?: number;
}

export interface DocumentPage {
    documents: DocumentListEntry[];
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
    status: DocumentStatusFilter;
    /**
     * The API predates the review contract: it ignored status, search and
     * paging and answered its first page unfiltered, so there is no
     * truthful status, total or count to show until it restarts.
     */
    legacy: boolean;
}

export type DocumentCounts = Record<DocumentListBucket | 'all', number>;

export interface DocumentHistory {
    document_id: string;
    current_revision_id: string | null;
    review_status: DocumentReviewStatus;
    /** Version lifecycle (contract §12); absent on an API that predates it. */
    current_version?: number | null;
    reviewable?: boolean;
    revisions: (RevisionMeta & { is_current?: boolean })[];
    decisions: DocumentDecision[];
    registrations: { id: string; revision_id: string; content_hash: string; task_id: string | null; project_id: string | null; registered_at: string; registered_by: string | null; media_type?: MediaType; asset_count?: number }[];
    edits?: { id: string; base_revision_id: string; result_revision_id: string; actor_id: string; authority: string; summary: string; created_at: string }[];
    reviews: { id: string; revision_id: string; reviewer_id: string; status: ReviewStatus; created_at: string; submitted_at: string | null; comment_count: number; delivery_status: DeliveryStatus | null; closed_at?: string | null; closed_reason?: string | null; replacement_id?: string | null; is_current_revision?: boolean }[];
    replacements?: DocumentReplacement[];
}

export interface NewCommentInput {
    client_id: string;
    kind: CommentKind;
    body: string;
    start_line?: number;
    end_line?: number;
    quote?: string;
    selection?: string | null;
    anchor?: MediaAnchor;
    parent_id?: string;
}

export class DocumentApiError extends Error {
    status: number;
    code: string | null;
    /** For a refused decision, what the operator session check found (for example `assertion-missing`). */
    reason: string | null;
    constructor(message: string, status: number, code: string | null = null, reason: string | null = null) {
        super(message);
        this.status = status;
        this.code = code;
        this.reason = reason;
    }
}

/**
 * Session-authenticated fetch. The documents API trusts the browser's session
 * (the cookies Cloudflare Access turns into the operator assertion) and never
 * a bearer: the shared nexus helper's placeholder `Authorization: Bearer
 * local-dev-token` made the decision authority check a credential instead of
 * the session and refuse Robert's Request changes (2026-10-04, task a1cc8616),
 * so this client sends no Authorization header. Cookies ride along, and the
 * cache-buster mirrors that helper.
 */
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const target = `${url}${url.includes('?') ? '&' : '?'}_cb=${Date.now()}`;
    const res = await fetch(target, {
        ...options,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    let data: unknown = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
        const body = (data && typeof data === 'object') ? data as { error?: string; code?: string; reason?: string } : {};
        throw new DocumentApiError(body.error || `Request failed (${res.status})`, res.status, body.code ?? null, typeof body.reason === 'string' ? body.reason : null);
    }
    return data as T;
}

const BASE = '/api/documents';

export function getReviewTaskOptions(): Promise<{ tasks: DocumentBlockingTask[] }> {
    return request(`${BASE}/review-task-options`, { cache: 'no-store' });
}

export function requestDocumentReview(documentId: string, blockingTaskIds: string[]): Promise<{
    document: DocumentRecord; review_status: DocumentReviewStatus; blocking_tasks: DocumentBlockingTask[];
}> {
    return request(`${BASE}/${encodeURIComponent(documentId)}/request-review`, {
        method: 'POST', body: JSON.stringify({ blocking_task_ids: blockingTaskIds }),
    });
}

export function getDocument(documentId: string): Promise<DocumentResponse> {
    return request<DocumentResponse>(`${BASE}/${encodeURIComponent(documentId)}`, { cache: 'no-store' });
}

/** In-app path of the shared reviewer for a document; every dashboard link to a document goes through here. */
export function documentHref(documentId: string): string {
    return `/documents/${encodeURIComponent(documentId)}`;
}

function filterParams(filters: DocumentListFilters): URLSearchParams {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.task_id) params.set('task_id', filters.task_id);
    if (filters.project_id) params.set('project_id', filters.project_id);
    if (filters.kind) params.set('kind', filters.kind);
    if (filters.q && filters.q.trim()) params.set('q', filters.q.trim());
    if (filters.limit !== undefined) params.set('limit', String(filters.limit));
    if (filters.offset) params.set('offset', String(filters.offset));
    return params;
}

/**
 * One page of registered documents (newest first). Status, search, project,
 * task and kind are filtered by the server, and `total` counts every match,
 * so a page of 25 out of 130 says so truthfully.
 */
export async function listDocumentsPage(filters: DocumentListFilters = {}): Promise<DocumentPage> {
    const query = filterParams(filters).toString();
    const data = await request<Partial<DocumentPage> & { documents?: DocumentListEntry[] }>(`${BASE}${query ? `?${query}` : ''}`, { cache: 'no-store' });
    const documents = data.documents || [];
    if (typeof data.total !== 'number') {
        return { documents, total: documents.length, limit: documents.length, offset: 0, has_more: false, status: 'all', legacy: true };
    }
    return {
        documents,
        total: data.total,
        limit: data.limit ?? documents.length,
        offset: data.offset ?? 0,
        has_more: Boolean(data.has_more),
        status: data.status ?? filters.status ?? 'all',
        legacy: false,
    };
}

/**
 * A page can come back empty past the end of a view that still has
 * documents: decisions moved its last documents out while it was open, and a
 * reload or poll kept the old offset. Returns the offset of the last page that
 * still has documents, or null when the page is fine (it has rows, the view
 * is truly empty, or the API is pre-contract). Views step back to it rather
 * than calling a non-empty view empty.
 */
export function stepBackOffset(page: DocumentPage | null, pageSize: number): number | null {
    if (!page || page.legacy || page.documents.length > 0 || page.total <= 0 || page.offset === 0) return null;
    const lastOffset = Math.floor((page.total - 1) / pageSize) * pageSize;
    return lastOffset < page.offset ? lastOffset : null;
}

/** Per-status counts for the same filters as the list (status itself is ignored); `all` is their sum. */
export async function countDocuments(filters: Pick<DocumentListFilters, 'task_id' | 'project_id' | 'kind' | 'q'> = {}): Promise<DocumentCounts> {
    const query = filterParams({ task_id: filters.task_id, project_id: filters.project_id, kind: filters.kind, q: filters.q }).toString();
    const data = await request<{ counts: DocumentCounts }>(`${BASE}/counts${query ? `?${query}` : ''}`, { cache: 'no-store' });
    // An API that predates the version lifecycle has no `in_progress` bucket: nothing is being revised there.
    return { ...data.counts, in_progress: typeof data.counts.in_progress === 'number' ? data.counts.in_progress : 0 };
}

/** Replacement work on a document: the open item, every item newest first, and whether the current version takes review actions (contract §12). */
export function listReplacements(documentId: string): Promise<{ document_id: string; current_revision_id: string | null; open: DocumentReplacement | null; reviewable: boolean; replacements: DocumentReplacement[] }> {
    return request(`${BASE}/${encodeURIComponent(documentId)}/replacements`, { cache: 'no-store' });
}

const REPLACEMENT_LABELS: Record<ReplacementState, { text: string; tone: string }> = {
    accepted: { text: 'Revision accepted', tone: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' },
    queued: { text: 'Revision queued', tone: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' },
    held: { text: 'Revision held', tone: 'border-amber-500/40 bg-amber-500/10 text-amber-200' },
    running: { text: 'Revision in progress', tone: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' },
    implemented: { text: 'Revision implemented, QA pending', tone: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' },
    qa_passed: { text: 'Revision passed QA', tone: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' },
    ready: { text: 'New version ready', tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' },
    failed: { text: 'Revision failed', tone: 'border-rose-500/40 bg-rose-500/10 text-rose-200' },
    cancelled: { text: 'Revision cancelled', tone: 'border-slate-700 bg-slate-800/40 text-slate-400' },
};

/** Label and badge tone for replacement work; worded apart from the document's editorial state and the task's board status. */
export function replacementStateLabel(state: ReplacementState): { text: string; tone: string } {
    return REPLACEMENT_LABELS[state] ?? { text: `Revision ${String(state).replace(/_/g, ' ')}`, tone: 'border-slate-700 text-slate-400' };
}

export function getDocumentHistory(documentId: string): Promise<DocumentHistory> {
    return request<DocumentHistory>(`${BASE}/${encodeURIComponent(documentId)}/history`, { cache: 'no-store' });
}

/**
 * Approve document / Request changes on the exact revision the operator read.
 * The server refuses a revision that is no longer current (409
 * stale_revision) and anyone without an operator session (403
 * operator_required). Recording a decision never sends or publishes anything.
 */
export function recordDecision(documentId: string, input: { decision: DecisionKind; revision_id: string; content_hash?: string; note?: string; client_decision_id: string; selection?: { direction: string } }): Promise<{ decision: DocumentDecision; review_status: DocumentReviewStatus; duplicate?: boolean }> {
    return request(`${BASE}/${encodeURIComponent(documentId)}/decisions`, { method: 'POST', body: JSON.stringify(input) });
}

const STATUS_LABELS: Record<DocumentReviewStatus, { text: string; tone: string }> = {
    needs_review: { text: 'Review pending', tone: 'border-amber-400/50 bg-amber-400/10 text-amber-200' },
    changes_requested: { text: 'Changes requested', tone: 'border-orange-500/50 bg-orange-500/10 text-orange-200' },
    approved: { text: 'Document approved', tone: 'border-sky-400/50 bg-sky-400/10 text-sky-200' },
    reference: { text: 'Reference', tone: 'border-slate-700 bg-slate-800/40 text-slate-400' },
};

/**
 * Label for the document's own editorial state. Deliberately worded apart
 * from task execution ("completed") and technical QA ("QA passed"): those
 * describe the work, this describes Robert's decision on the document.
 */
export function documentStatusLabel(status: DocumentReviewStatus | undefined): { text: string; tone: string } | null {
    return status ? STATUS_LABELS[status] : null;
}

/** Human label and badge tone for the caller's own comment/feedback state; Finish review is feedback, never a decision. */
export function reviewStateLabel(entry: Pick<DocumentListEntry, 'review_state'>): { text: string; tone: string } {
    const state = entry.review_state;
    if (!state) return { text: 'No feedback yet', tone: 'border-slate-700 text-slate-400' };
    if (state.status === 'draft') {
        return {
            text: `Draft feedback · ${state.comment_count} comment${state.comment_count === 1 ? '' : 's'}`,
            tone: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
        };
    }
    if (state.status === 'superseded') {
        // The draft was closed read-only when replacement work was accepted; the comments are kept, not sent.
        return {
            text: `Draft feedback superseded · ${state.comment_count} comment${state.comment_count === 1 ? '' : 's'} kept`,
            tone: 'border-slate-700 bg-slate-800/40 text-slate-400',
        };
    }
    const delivery = state.delivery_status;
    if (delivery === 'delivered') return { text: 'Feedback sent to Praxis', tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' };
    if (delivery === 'failed') return { text: 'Feedback delivery failed', tone: 'border-rose-500/40 bg-rose-500/10 text-rose-200' };
    return { text: 'Feedback delivering', tone: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' };
}

/**
 * Opens (or resumes) the caller's draft round. Passing the revision the page
 * is showing lets the server refuse a stale tab with `stale_revision` instead
 * of silently starting a round on a version the reader has not seen; the
 * server also refuses with `replacement_in_progress` while a new version is
 * being produced (contract §12). Nothing is recorded on either refusal.
 */
export async function openReview(documentId: string, revisionId?: string | null): Promise<ReviewView> {
    const body = revisionId ? JSON.stringify({ revision_id: revisionId }) : '{}';
    const data = await request<{ review: ReviewView }>(`${BASE}/${encodeURIComponent(documentId)}/reviews`, { method: 'POST', body });
    return data.review;
}

export async function getReview(reviewId: string): Promise<ReviewView> {
    const data = await request<{ review: ReviewView }>(`${BASE}/reviews/${encodeURIComponent(reviewId)}`, { cache: 'no-store' });
    return data.review;
}

export async function saveSummary(reviewId: string, summary: string): Promise<ReviewView> {
    const data = await request<{ review: ReviewView }>(`${BASE}/reviews/${encodeURIComponent(reviewId)}`, { method: 'PATCH', body: JSON.stringify({ summary }) });
    return data.review;
}

export async function addComment(reviewId: string, input: NewCommentInput): Promise<ReviewComment> {
    const data = await request<{ comment: ReviewComment }>(`${BASE}/reviews/${encodeURIComponent(reviewId)}/comments`, { method: 'POST', body: JSON.stringify(input) });
    return data.comment;
}

export async function updateComment(reviewId: string, commentId: string, body: string): Promise<ReviewComment> {
    const data = await request<{ comment: ReviewComment }>(`${BASE}/reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(commentId)}`, { method: 'PATCH', body: JSON.stringify({ body }) });
    return data.comment;
}

/** Mark a comment resolved (or not); the reviewer's own bookkeeping, carried into the feedback payload. */
export async function setCommentResolved(reviewId: string, commentId: string, resolved: boolean): Promise<ReviewComment> {
    const data = await request<{ comment: ReviewComment }>(`${BASE}/reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(commentId)}`, { method: 'PATCH', body: JSON.stringify({ resolved }) });
    return data.comment;
}

/** Same-origin URL of one asset of a revision (image, video, PDF, prototype, design member); never an external host. */
export function assetUrl(documentId: string, assetKey: string, options: { revision?: string | null; download?: boolean } = {}): string {
    const params = new URLSearchParams();
    if (options.revision) params.set('revision', options.revision);
    if (options.download) params.set('download', '1');
    const query = params.toString();
    return `${BASE}/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(assetKey)}${query ? `?${query}` : ''}`;
}

export function getReadiness(documentId: string, revisionId?: string | null): Promise<Readiness> {
    const query = revisionId ? `?revision=${encodeURIComponent(revisionId)}` : '';
    return request<Readiness>(`${BASE}/${encodeURIComponent(documentId)}/readiness${query}`, { cache: 'no-store' });
}

export interface EditResult {
    edit: { id: string; base_revision_id: string; result_revision_id: string; summary: string; created_at: string } | null;
    revision: RevisionMeta;
    content: string | null;
    assets?: RevisionAsset[];
    review_status?: DocumentReviewStatus;
    duplicate?: boolean;
    unchanged?: boolean;
}

/**
 * Direct edit (contract §4): writes the text as a new `nexus_edit` revision,
 * pinned to the revision the operator edited. The server refuses a revision
 * that is no longer current (409 stale_revision) and anyone without an
 * operator session; a decision never carries over to the new revision.
 */
export function saveEdit(documentId: string, input: { base_revision_id: string; content: string; client_edit_id: string; summary?: string }): Promise<EditResult> {
    return request<EditResult>(`${BASE}/${encodeURIComponent(documentId)}/content`, { method: 'PUT', body: JSON.stringify(input) });
}

/** The media type of a response, defaulting to Markdown for an API that predates the media model. */
export function mediaTypeOf(data: Pick<DocumentResponse, 'media_type' | 'document' | 'revision'> | null | undefined): MediaType {
    return data?.media_type ?? data?.revision?.media_type ?? data?.document?.media_type ?? 'markdown';
}

/** Human label for a media type. */
export function mediaLabel(type: MediaType | undefined): string {
    switch (type) {
        case 'design': return 'Design package';
        case 'image': return 'Image';
        case 'video': return 'Video';
        case 'audio': return 'Audio';
        case 'pdf': return 'PDF';
        case 'html': return 'Prototype';
        case 'svg': return 'SVG';
        case 'code': return 'Code';
        case 'json': return 'JSON';
        case 'text': return 'Text';
        default: return 'Document';
    }
}

/** m:ss(.t) for a timestamp anchor. */
export function formatSeconds(seconds: number): string {
    const total = Math.max(0, Math.round(seconds * 10) / 10);
    const minutes = Math.floor(total / 60);
    const rest = total - minutes * 60;
    const secs = Number.isInteger(rest) ? String(rest).padStart(2, '0') : rest.toFixed(1).padStart(4, '0');
    return `${minutes}:${secs}`;
}

export async function deleteComment(reviewId: string, commentId: string): Promise<void> {
    await request(`${BASE}/reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
}

/**
 * Finish a review. `approveAfterChanges` sends Robert's explicit grant: the
 * executor that applies this review may record his approval of the corrected
 * revision. The server accepts the grant only from his verified session or
 * operator credential, so a finish without it never carries the field.
 */
export async function finishReview(reviewId: string, summary: string, options: { approveAfterChanges?: boolean } = {}): Promise<{ review: ReviewView; submission: SubmissionView }> {
    const body: { summary: string; approve_after_changes?: true } = { summary };
    if (options.approveAfterChanges) body.approve_after_changes = true;
    return request(`${BASE}/reviews/${encodeURIComponent(reviewId)}/finish`, { method: 'POST', body: JSON.stringify(body) });
}

export async function getSubmission(reviewId: string): Promise<SubmissionView> {
    const data = await request<{ submission: SubmissionView }>(`${BASE}/reviews/${encodeURIComponent(reviewId)}/submission`, { cache: 'no-store' });
    return data.submission;
}

export async function retryDelivery(reviewId: string): Promise<SubmissionView> {
    const data = await request<{ submission: SubmissionView }>(`${BASE}/reviews/${encodeURIComponent(reviewId)}/submission/retry`, { method: 'POST', body: '{}' });
    return data.submission;
}

export function rawDocumentUrl(documentId: string, options: { revision?: string | null; download?: boolean } = {}): string {
    const params = new URLSearchParams();
    if (options.revision) params.set('revision', options.revision);
    if (options.download) params.set('download', '1');
    const query = params.toString();
    return `${BASE}/${encodeURIComponent(documentId)}/raw${query ? `?${query}` : ''}`;
}

/** Stable per-client comment ids so a retried save cannot duplicate a comment. */
export function newClientId(): string {
    const cryptoApi = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** An explicit operator grant or permanent cancellation for the exact envelope on screen. */
export function recordOutgoingDecision(documentId: string, input: { decision: 'approve_send' | 'cancel'; revision_id: string; envelope_hash: string }): Promise<{ outgoing: DocumentOutgoing }> {
    return request(`${BASE}/${encodeURIComponent(documentId)}/outgoing/decision`, { method: 'POST', body: JSON.stringify(input) });
}
