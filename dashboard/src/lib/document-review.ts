// Client for the Markdown document review API (/api/documents), reached
// through the dashboard's /api proxy so the same code works on the desktop,
// the phone shell and the Cloudflare tunnel. Types mirror the server's
// server/routes/documents.js responses.
import { authFetch } from './nexus/shared';

export type ReviewStatus = 'draft' | 'submitted';
export type DeliveryStatus = 'queued' | 'relaying' | 'delivered' | 'failed';
export type AnchorStateName = 'intact' | 'moved' | 'orphaned' | 'document';

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
    links: { review_url: string; raw_url: string };
}

export interface DocumentListEntry extends DocumentRecord {
    current_revision: RevisionMeta | null;
    review_url: string;
    review_state: { review_id: string; status: ReviewStatus; updated_at: string; comment_count: number; delivery_status: DeliveryStatus | null } | null;
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
    constructor(message: string, status: number, code: string | null = null) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const res = await authFetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    let data: unknown = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
        const body = (data && typeof data === 'object') ? data as { error?: string; code?: string } : {};
        throw new DocumentApiError(body.error || `Request failed (${res.status})`, res.status, body.code ?? null);
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

/** Registered documents (newest first) with the caller's review state; filters narrow to one task or project. */
export async function listDocuments(filters: { task_id?: string; project_id?: string } = {}): Promise<DocumentListEntry[]> {
    const params = new URLSearchParams();
    if (filters.task_id) params.set('task_id', filters.task_id);
    if (filters.project_id) params.set('project_id', filters.project_id);
    const query = params.toString();
    const data = await request<{ documents: DocumentListEntry[] }>(`${BASE}${query ? `?${query}` : ''}`, { cache: 'no-store' });
    return data.documents || [];
}

export function listTaskDocuments(taskId: string): Promise<DocumentListEntry[]> {
    return listDocuments({ task_id: taskId });
}

/** Human label and badge tone for a list entry's review state; the task panel and the /documents index agree through this. */
export function reviewStateLabel(entry: Pick<DocumentListEntry, 'review_state'>): { text: string; tone: string } {
    const state = entry.review_state;
    if (!state) return { text: 'Not reviewed yet', tone: 'border-slate-700 text-slate-400' };
    if (state.status === 'draft') {
        return {
            text: `Draft · ${state.comment_count} comment${state.comment_count === 1 ? '' : 's'}`,
            tone: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
        };
    }
    const delivery = state.delivery_status;
    if (delivery === 'delivered') return { text: 'Review sent to Praxis', tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' };
    if (delivery === 'failed') return { text: 'Review finished · delivery failed', tone: 'border-rose-500/40 bg-rose-500/10 text-rose-200' };
    return { text: 'Review finished · delivering', tone: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' };
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

export async function finishReview(reviewId: string, summary: string): Promise<{ review: ReviewView; submission: SubmissionView }> {
    return request(`${BASE}/reviews/${encodeURIComponent(reviewId)}/finish`, { method: 'POST', body: JSON.stringify({ summary }) });
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
