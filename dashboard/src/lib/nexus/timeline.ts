import { API_URL, authFetch } from './shared';

// ═══════════════════════════════════════════════════════════════
// EXECUTION TIMELINE & INLINE COMMENTS API
// ═══════════════════════════════════════════════════════════════

export type ExecutionStage = 'research' | 'plan' | 'implement';

export interface ExecutionStep {
    id: string;
    runId?: string;
    node: string;
    stage: ExecutionStage;
    step: number;
    status: 'pending' | 'running' | 'completed' | 'failed';
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    messages?: Array<{ role: string; content: string }>;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    error?: string;
}

export interface InlineComment {
    id: string;
    taskId: string;
    stage: 'research' | 'plan' | 'walkthrough';
    selectionText: string;
    selectionStart?: number;
    selectionEnd?: number;
    comment: string;
    resolved: boolean;
    resolvedAt?: string;
    createdAt: string;
}

/**
 * Get execution timeline for a task
 */
export async function getTaskTimeline(
    projectId: string,
    taskId: string,
    stage?: ExecutionStage
): Promise<ExecutionStep[]> {
    const params = stage ? `?stage=${stage}` : '';
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}/timeline${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.steps || [];
}

/**
 * Get inline comments for a task
 */
export async function getInlineComments(
    projectId: string,
    taskId: string,
    stage?: 'research' | 'plan' | 'walkthrough' | 'spec'
): Promise<InlineComment[]> {
    const params = stage ? `?stage=${stage}` : '';
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}/comments${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.comments || [];
}

/**
 * Add an inline comment to a task
 */
export async function addInlineComment(
    projectId: string,
    taskId: string,
    comment: {
        stage: 'research' | 'plan' | 'walkthrough' | 'spec';
        selectionText: string;
        selectionStart?: number;
        selectionEnd?: number;
        comment: string;
    }
): Promise<{ success: boolean; comment: InlineComment }> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(comment)
    });
    if (!res.ok) {
        throw new Error('Failed to add comment');
    }
    return res.json();
}

/**
 * Resolve or unresolve an inline comment
 */
export async function resolveInlineComment(
    projectId: string,
    taskId: string,
    commentId: string,
    resolved: boolean
): Promise<{ success: boolean; comment: InlineComment }> {
    const res = await fetch(`${API_URL}/${projectId}/tasks/${taskId}/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved })
    });
    if (!res.ok) {
        throw new Error('Failed to update comment');
    }
    return res.json();
}

