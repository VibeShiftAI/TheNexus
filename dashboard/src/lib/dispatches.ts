/**
 * Dispatch history + manual dispatch API client for the task screen.
 *
 * History rows live in the Nexus DB (server/routes/dispatches.js), written by
 * Praxis's executor seam. Dispatch/follow-up actions relay through the Nexus
 * server to Praxis (:4000 /api/praxis/* → :54322).
 */

export type DispatchOutcome =
    | 'running'
    | 'success'
    | 'failure'
    | 'timeout'
    | 'needs_input'
    | 'cancelled';

export type DispatchExecutor = 'antigravity' | 'codex' | 'claude-code' | 'openrouter';

export interface TaskDispatch {
    id: string;
    task_id: string;
    project_id: string | null;
    kind: 'dispatch' | 'follow_up';
    parent_id: string | null;
    executor: DispatchExecutor | string;
    model: string | null;
    /** Tokens this run consumed, when recorded (else null). */
    tokens?: number | null;
    /** 1 when `tokens` is an estimate from text volume rather than an exact count. */
    tokens_estimated?: number | null;
    prompt: string | null;
    instructions: string | null;
    output: string | null;
    error: string | null;
    outcome: DispatchOutcome | string;
    session_id: string | null;
    workspace: string | null;
    log_path: string | null;
    started_at: string;
    completed_at: string | null;
}

/** Executors whose sessions can be resumed with a follow-up prompt. */
export const RESUMABLE_EXECUTORS = new Set(['claude-code', 'codex']);

export function canFollowUp(dispatch: TaskDispatch): boolean {
    return (
        dispatch.outcome !== 'running' &&
        Boolean(dispatch.session_id) &&
        Boolean(dispatch.workspace) &&
        RESUMABLE_EXECUTORS.has(dispatch.executor)
    );
}

export async function getTaskDispatches(taskId: string, limit = 50): Promise<TaskDispatch[]> {
    const res = await fetch(
        `/api/dispatches?task_id=${encodeURIComponent(taskId)}&limit=${limit}&_cb=${Date.now()}`,
        { cache: 'no-store' },
    );
    if (!res.ok) throw new Error(`Failed to load dispatch history (${res.status})`);
    const body = (await res.json()) as { dispatches?: TaskDispatch[] };
    return body.dispatches ?? [];
}

export interface DispatchTaskInput {
    taskId: string;
    executor?: string;
    model?: string;
    /** Provider for an explicitly selected provider-backed model route. */
    provider?: string;
    instructions?: string;
    force?: boolean;
}

export interface DispatchTaskResult {
    ok: boolean;
    reply: string;
    /** True when Praxis refused (duplicate run, terminal status, …). */
    refused: boolean;
}

/** Immediately dispatch a task to a CLI executor via Praxis. */
export async function dispatchTask(input: DispatchTaskInput): Promise<DispatchTaskResult> {
    const res = await fetch('/api/praxis/dispatch/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            taskId: input.taskId,
            ...(input.executor ? { executor: input.executor } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.provider ? { provider: input.provider } : {}),
            ...(input.instructions ? { instructions: input.instructions } : {}),
            ...(input.force ? { force: true } : {}),
        }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reply?: string; error?: string };
    if (res.status === 409) {
        return { ok: false, refused: true, reply: body.reply || 'Praxis refused the dispatch.' };
    }
    if (!res.ok) throw new Error(body.error || `Dispatch failed (${res.status})`);
    return { ok: body.ok !== false, refused: false, reply: body.reply || 'Dispatched.' };
}

export interface FollowUpInput {
    taskId: string;
    projectId?: string | null;
    executor: string;
    sessionId: string;
    prompt: string;
    workspace: string;
    model?: string | null;
    parentDispatchId?: string | null;
}

/** Send a follow-up prompt into a finished dispatch's saved CLI session. */
export async function sendFollowUp(input: FollowUpInput): Promise<{ dispatchId: string }> {
    const res = await fetch('/api/praxis/dispatch/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as { dispatchId?: string; error?: string };
    if (!res.ok || !body.dispatchId) {
        throw new Error(body.error || `Follow-up failed (${res.status})`);
    }
    return { dispatchId: body.dispatchId };
}
