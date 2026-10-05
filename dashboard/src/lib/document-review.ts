// Client for the Markdown document review API (/api/documents), reached
// through the dashboard's /api proxy so the same code works on the desktop,
// the phone shell and the Cloudflare tunnel. Types mirror the server's
// server/routes/documents.js responses.

export type ReviewStatus = 'draft' | 'submitted';
export type DeliveryStatus = 'queued' | 'relaying' | 'delivered' | 'failed';
export type AnchorStateName = 'intact' | 'moved' | 'orphaned' | 'document';
/** The document's editorial state, derived by the server (contract docs/contracts/document-review-deliverables.md §3). */
export type DocumentReviewStatus = 'needs_review' | 'changes_requested' | 'approved' | 'reference';
export type DocumentStatusFilter = DocumentReviewStatus | 'all';
export type IntendedAction = 'none' | 'implement' | 'send' | 'publish';
export type DecisionKind = 'approve' | 'request_changes';

export const DOCUMENT_KINDS = ['document', 'report', 'spec', 'plan', 'research', 'walkthrough', 'other'] as const;

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
    intended_action?: IntendedAction;
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
}

export interface ReviewComment {
    id: string;
    kind: 'passage' | 'document';
    start_line: number | null;
    end_line: number | null;
    block_hash: string | null;
    quote: string | null;
    selection: string | null;
    body: string;
    created_at: string;
    updated_at: string;
    anchor?: { state: AnchorStateName; current_start_line?: number | null };
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
}

export interface DocumentSource {
    task: { id: string; title: string | null; status: string | null; status_message: string | null; project_id: string | null; updated_at: string | null } | null;
    project: { id: string; name: string | null; path: string | null } | null;
}

export interface DocumentResponse {
    document: DocumentRecord;
    revision: RevisionMeta | null;
    content: string | null;
    file_state: string;
    file_error: string | null;
    source: DocumentSource;
    review: ReviewView | null;
    review_status?: DocumentReviewStatus;
    current_decision?: (DocumentDecision & { applies_to_current_revision: boolean }) | null;
    links: { review_url: string; raw_url: string; review_path?: string };
}

export interface DocumentListEntry extends DocumentRecord {
    current_revision: RevisionMeta | null;
    review_url: string;
    review_path?: string;
    review_status?: DocumentReviewStatus;
    review_state: { review_id: string; status: ReviewStatus; updated_at: string; comment_count: number; delivery_status: DeliveryStatus | null } | null;
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

export type DocumentCounts = Record<DocumentReviewStatus | 'all', number>;

export interface DocumentHistory {
    document_id: string;
    current_revision_id: string | null;
    review_status: DocumentReviewStatus;
    revisions: RevisionMeta[];
    decisions: DocumentDecision[];
    registrations: { id: string; revision_id: string; content_hash: string; task_id: string | null; project_id: string | null; registered_at: string; registered_by: string | null }[];
    reviews: { id: string; revision_id: string; reviewer_id: string; status: ReviewStatus; created_at: string; submitted_at: string | null; comment_count: number; delivery_status: DeliveryStatus | null }[];
}

export interface NewCommentInput {
    client_id: string;
    kind: 'passage' | 'document';
    body: string;
    start_line?: number;
    end_line?: number;
    quote?: string;
    selection?: string | null;
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
    return data.counts;
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
export function recordDecision(documentId: string, input: { decision: DecisionKind; revision_id: string; content_hash?: string; note?: string; client_decision_id: string }): Promise<{ decision: DocumentDecision; review_status: DocumentReviewStatus; duplicate?: boolean }> {
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
    const delivery = state.delivery_status;
    if (delivery === 'delivered') return { text: 'Feedback sent to Praxis', tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' };
    if (delivery === 'failed') return { text: 'Feedback delivery failed', tone: 'border-rose-500/40 bg-rose-500/10 text-rose-200' };
    return { text: 'Feedback delivering', tone: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' };
}

export async function openReview(documentId: string): Promise<ReviewView> {
    const data = await request<{ review: ReviewView }>(`${BASE}/${encodeURIComponent(documentId)}/reviews`, { method: 'POST', body: '{}' });
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
