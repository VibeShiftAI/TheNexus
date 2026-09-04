import { API_URL, authFetch } from './shared';

// ═══════════════════════════════════════════════════════════════
// LOCAL LLM QUEUE API
// ═══════════════════════════════════════════════════════════════

export type LocalLlmJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'paused';

export interface LocalLlmJob {
    id: string;
    type: string;
    priority: number;
    payload: Record<string, unknown>;
    status: LocalLlmJobStatus;
    attempts: number;
    maxAttempts: number;
    scheduledFor?: string;
    calendarEventId?: string;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    completedAt?: string;
    result?: string;
    error?: string;
}

export interface LocalLlmQueueState {
    worker: {
        paused: boolean;
        pauseReason?: string;
        updatedAt: string;
    };
    jobs: LocalLlmJob[];
    /** Present when fetched with activeOnly — status → count over the full history. */
    counts?: Record<string, number>;
}

export interface EnqueueLocalLlmJobInput {
    type: string;
    priority?: number;
    scheduled_for?: string;
    max_attempts?: number;
    payload?: Record<string, unknown>;
}

const LOCAL_QUEUE_API = API_URL.replace(/\/projects$/, '/local-queue');

export async function getLocalLlmQueue(activeOnly = true): Promise<LocalLlmQueueState> {
    // activeOnly (default) returns worker + counts + running/queued jobs only —
    // the full history is thousands of jobs and should never sit on a poll loop.
    const res = await authFetch(`${LOCAL_QUEUE_API}${activeOnly ? '?active=1' : ''}`);
    if (!res.ok) throw new Error(`Failed to fetch local queue (${res.status})`);
    return res.json();
}

export async function enqueueLocalLlmJob(input: EnqueueLocalLlmJobInput): Promise<LocalLlmJob> {
    const res = await authFetch(`${LOCAL_QUEUE_API}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`Failed to enqueue local job (${res.status})`);
    return res.json();
}

export async function promoteLocalLlmJob(jobId: string, priority = 0): Promise<LocalLlmJob> {
    const res = await authFetch(`${LOCAL_QUEUE_API}/jobs/${jobId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
    });
    if (!res.ok) throw new Error(`Failed to promote local job (${res.status})`);
    return res.json();
}

export async function cancelLocalLlmJob(jobId: string, reason = 'Cancelled from Nexus'): Promise<LocalLlmJob> {
    const res = await authFetch(`${LOCAL_QUEUE_API}/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
    });
    if (!res.ok) throw new Error(`Failed to cancel local job (${res.status})`);
    return res.json();
}

export async function retryLocalLlmJob(jobId: string): Promise<LocalLlmJob> {
    const res = await authFetch(`${LOCAL_QUEUE_API}/jobs/${jobId}/retry`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to retry local job (${res.status})`);
    return res.json();
}

export async function pauseLocalLlmQueue(reason = 'Paused from Nexus'): Promise<LocalLlmQueueState> {
    const res = await authFetch(`${LOCAL_QUEUE_API}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
    });
    if (!res.ok) throw new Error(`Failed to pause local queue (${res.status})`);
    return res.json();
}

export async function resumeLocalLlmQueue(): Promise<LocalLlmQueueState> {
    const res = await authFetch(`${LOCAL_QUEUE_API}/resume`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to resume local queue (${res.status})`);
    return res.json();
}


