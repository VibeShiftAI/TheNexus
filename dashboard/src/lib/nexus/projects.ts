import { updateTask } from './tasks';
import type { TaskStatus } from './tasks';
import { API_URL, authFetch } from './shared';
import type { Task } from './tasks';
import type { ProjectCommsSettings, ReportTemplate } from '@praxis/contract';

// ═══════════════════════════════════════════════════════════════
// PROJECT TYPES
// ═══════════════════════════════════════════════════════════════

/** One revision of a project's end state (appended server-side on every change). */
export interface EndStateRevision {
    end_state: string;
    at: string;
    source?: string;
    reason?: string;
}

/** A declared need — something the project is missing on the way to its end state. */
export interface ProjectNeed {
    id: string;
    kind: 'capability' | 'resource' | 'credential' | 'decision' | 'information';
    description: string;
    status: 'open' | 'met' | 'dropped';
    created_at: string;
    resolved_at?: string;
    source?: string;
    notes?: string;
}

export type UpgradePosture = 'auto' | 'propose' | 'off';

/**
 * A machine-checkable end-state acceptance criterion. The Project Data
 * Steward evaluates these weekly and cites per-criterion pass/fail instead
 * of the bare "no open tasks" heuristic.
 */
export interface EndStateCriterion {
    id: string;
    kind: 'url_up' | 'command' | 'task_set';
    description: string;
    url?: string;
    expect_status?: number;
    command?: string;
    task_ids?: string[];
    enabled?: boolean;
    created_at?: string;
    source?: string;
}

export interface Project {
    id: string;
    name: string;
    path: string;
    type: string;
    description?: string;
    vibe?: string;
    tasks?: string[];
    stack?: Record<string, string>;
    urls?: {
        production?: string;
        repo?: string;
    };
    end_state?: string;
    end_state_updated_at?: string | null;
    end_state_history?: EndStateRevision[];
    tags?: string[];
    status?: 'active' | 'parked' | 'paused' | 'completed' | 'archived' | string;
    /** Attention priority: 0 = normal, >0 elevated, <0 backburner. */
    priority?: number;
    /** auto = system files + schedules improvements; propose = files only; off = no autonomous filings. */
    upgrade_posture?: UpgradePosture | string;
    needs?: ProjectNeed[];
    end_state_criteria?: EndStateCriterion[];
    archived_at?: string | null;
    /**
     * Stakeholder governance (2026-08-22): per-project status-report settings
     * and the branded report template. JSON columns — `{}` until configured;
     * PATCH with the whole object to replace (like `needs`). Types re-exported
     * in the STAKEHOLDERS section below; use `parseCommsSettings()` /
     * `hasReportTemplate()` from @praxis/contract to read them safely.
     */
    comms_settings?: ProjectCommsSettings | Record<string, never>;
    report_template?: ReportTemplate | Record<string, never>;
    stats?: {
        pending_reviews?: number;
    };
}


export interface GitStatus {
    hasGit: boolean;
    hasRemote: boolean;
    hasCommits?: boolean;
    remoteUrl: string | null;
    not_added: string[];
    conflicted: string[];
    created: string[];
    deleted: string[];
    modified: string[];
    renamed: string[];
    files: any[];
    staged: string[];
    ahead: number;
    behind: number;
    current: string | null;
    tracking: string | null;
    latest_commit?: {
        hash: string;
        date: string;
        message: string;
        author_name: string;
        author_email: string;
    } | null;
    daysSinceCommit: number | null;
    uncommittedCount: number;
    error: string | null;
}

export async function getProjects(): Promise<Project[]> {
    try {
        const res = await authFetch(API_URL, {
            cache: 'no-store'
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch projects: ${res.statusText} (${res.status})`);
        }

        return res.json();
    } catch (error) {
        console.error("Failed to fetch projects:", error);
        throw error;
    }
}

/** List archived projects (excluded from getProjects). For the archive-management view. */
export async function getArchivedProjects(): Promise<Project[]> {
    const res = await authFetch(`${API_URL}?archived=true`, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`Failed to fetch archived projects: ${res.statusText} (${res.status})`);
    }
    return res.json();
}

// ─── Project pulse (batched activity rollups for cards + brief screen) ──────

export interface PulseGit {
    hasGit: boolean;
    hasRemote: boolean;
    hasCommits: boolean;
    remoteUrl: string | null;
    branch: string | null;
    uncommitted: number;
    ahead: number;
    behind: number;
    lastCommit: { hash: string; message: string; date: string } | null;
    /** Daily commit counts, oldest first (14 buckets batched, 30 on detail). */
    series: number[];
    total: number;
}

export interface PulseTasks {
    active: number;
    activeNames: string[];
    queued: number;
    attention: number;
    review: number;
    done7d: number;
    total: number;
}

export interface PulseCrew {
    running: number;
    last: {
        executor: string;
        model: string | null;
        outcome: string;
        taskName: string | null;
        at: string;
        tokens: number | null;
    } | null;
    tokens24h: number;
    tokens7d: number;
    dispatches7d: number;
}

export interface ProjectPulse {
    projectId: string;
    git: PulseGit;
    tasks: PulseTasks;
    crew: PulseCrew;
    lastActivityAt: string | null;
}

export interface OpsLogEvent {
    type: 'commit' | 'dispatch' | 'task';
    at: string;
    title: string;
    meta?: string;
    by?: string;
    outcome?: string;
    tokens?: number | null;
}

export interface ProjectBrief extends ProjectPulse {
    opsLog: OpsLogEvent[];
}

export async function getProjectsPulse(): Promise<Record<string, ProjectPulse>> {
    const res = await authFetch(`${API_URL}/pulse`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to fetch project pulse (${res.status})`);
    const data = await res.json();
    return data.pulses ?? {};
}

export async function getProjectBrief(id: string): Promise<ProjectBrief> {
    const res = await authFetch(`${API_URL}/${id}/pulse`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to fetch project brief (${res.status})`);
    return res.json();
}

export async function getProjectStatus(id: string): Promise<GitStatus> {
    const res = await authFetch(`${API_URL}/${id}/status`);
    if (!res.ok) {
        throw new Error("Failed to fetch status");
    }
    return res.json();
}

export async function initGitRepo(id: string): Promise<{ success: boolean; message: string }> {
    const res = await authFetch(`${API_URL}/${id}/git/init`, {
        method: 'POST',
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to initialize git");
    }
    return res.json();
}

export async function addGitRemote(id: string, url: string): Promise<{ success: boolean; message: string }> {
    const res = await authFetch(`${API_URL}/${id}/git/remote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to add remote");
    }
    return res.json();
}

export async function scaffoldProject(name: string, type: string, config?: any): Promise<{ success: boolean; message: string; path: string }> {
    const res = await authFetch(`${API_URL}/scaffold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, ...config }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create project");
    }
    return res.json();
}

export interface PingResult {
    hasUrl: boolean;
    isUp: boolean | null;
    url: string | null;
    status?: number;
    error?: string;
}

export async function pingProject(id: string): Promise<PingResult> {
    const res = await authFetch(`${API_URL}/${id}/ping`);
    if (!res.ok) {
        throw new Error("Failed to ping project");
    }
    return res.json();
}

export interface Activity {
    projectId: string;
    projectName: string;
    type: 'commit';
    hash: string;
    message: string;
    author: string;
    date: string;
    /** Model that performed the activity, when attributable (else null/absent). */
    model?: string | null;
    /** True when `model` is an executor-derived label (e.g. "Codex") rather than a precise model string. */
    modelInferred?: boolean;
    /** Tokens the activity consumed, when recorded (else null/absent). */
    tokens?: number | null;
    /** True when `tokens` is an approximation (from text volume) rather than an exact count. */
    tokensEstimated?: boolean;
    /**
     * The dispatch that produced this activity, when the commit correlates to a
     * recorded run. Present alongside `taskId`; both null when no dispatch
     * matched — the row then has no logs to drill into.
     */
    dispatchId?: string | null;
    /** Task the correlated dispatch belongs to — the Log Viewer is scoped to it. */
    taskId?: string | null;
}

/**
 * A Praxis operational event, as recorded in the activity log (ag_events).
 *
 * These used to arrive as [PRAXIS EVENT] cards in the chat — 100–150 a day at
 * peak, some of them hundreds of lines. Praxis now relays every one of them
 * here and only puts the ones that need Robert into the chat, so this feed is
 * the complete record and the chat is the exception list.
 */
export interface ActivityEvent {
    id: number;
    event_type: string;
    severity: 'info' | 'warning' | 'critical';
    title: string;
    message: string | null;
    task_id: string | null;
    source: string;
    metadata: Record<string, unknown> | string;
    requires_action: number;
    created_at: string;
}

export async function getActivityEvents(limit = 40): Promise<ActivityEvent[]> {
    const baseUrl = API_URL.replace('/projects', '');
    const res = await authFetch(`${baseUrl}/ag/events?limit=${limit}`);
    if (!res.ok) {
        throw new Error("Failed to fetch activity events");
    }
    return res.json();
}

export async function getActivity(): Promise<Activity[]> {
    const baseUrl = API_URL.replace('/projects', '');
    const res = await authFetch(`${baseUrl}/activity`);
    if (!res.ok) {
        throw new Error("Failed to fetch activity");
    }
    return res.json();
}

export async function getProject(id: string): Promise<Project> {
    const res = await authFetch(`${API_URL}/${id}`);
    if (!res.ok) {
        throw new Error("Project not found");
    }
    return res.json();
}

export interface Commit {
    hash: string;
    message: string;
    author: string;
    email: string;
    date: string;
}

export interface CommitsResponse {
    commits: Commit[];
    hasGit: boolean;
}

export async function getProjectCommits(id: string): Promise<CommitsResponse> {
    const res = await authFetch(`${API_URL}/${id}/commits`);
    if (!res.ok) {
        throw new Error("Failed to fetch commits");
    }
    return res.json();
}

export async function getPins(): Promise<string[]> {
    const baseUrl = API_URL.replace('/projects', '');
    const res = await authFetch(`${baseUrl}/pins`);
    if (!res.ok) {
        throw new Error("Failed to fetch pins");
    }
    return res.json();
}

export async function pinProject(id: string): Promise<void> {
    const res = await authFetch(`${API_URL}/${id}/pin`, { method: 'POST' });
    if (!res.ok) throw new Error("Failed to pin project");
}

export async function unpinProject(id: string): Promise<void> {
    const res = await authFetch(`${API_URL}/${id}/pin`, { method: 'DELETE' });
    if (!res.ok) throw new Error("Failed to unpin project");
}

export async function approveResearch(projectId: string, taskId: string, feedback?: string): Promise<{ success: boolean; task: Task }> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}/approve-research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
    });
    if (!res.ok) {
        try {
            const errorData = await res.json();
            if (errorData.planSaved) {
                throw new Error(`${errorData.error || 'Unknown error'} (Plan was saved - refresh to see it)`);
            }
            throw new Error(errorData.error || "Failed to approve research");
        } catch (e) {
            throw new Error("Failed to approve research");
        }
    }
    return res.json();
}

export async function rejectResearch(projectId: string, taskId: string, feedback?: string): Promise<{ success: boolean; task: Task }> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}/reject-research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
    });
    if (!res.ok) {
        throw new Error("Failed to reject research");
    }
    return res.json();
}

// Note: approvePlan and rejectPlan removed; plan approval is handled by task state updates.
export async function approveWalkthrough(projectId: string, taskId: string, feedback?: string): Promise<{ success: boolean; task: Task; commitHash?: string }> {
    // Step 1: Update task status to complete
    const updateResult = await updateTask(projectId, taskId, {
        status: 'completed' as TaskStatus
    });

    if (!updateResult.success) {
        throw new Error("Failed to update task status");
    }

    // Step 2: Generate commit message based on task (include walkthrough for context)
    const msgResult = await generateCommitMessage(projectId, taskId);
    const commitMessage = msgResult.message || `feat: ${updateResult.task.title}`;

    // Step 3: Commit and push
    let commitHash: string | undefined;
    try {
        const commitResult = await commitAndPush(projectId, commitMessage);
        if (commitResult.success) {
            // Extract commit hash if available
            commitHash = commitResult.message?.match(/[a-f0-9]{7,}/)?.[0];
        }
    } catch (e) {
        // Commit is optional - task is still marked complete
        console.warn('Commit failed, but task marked complete:', e);
    }

    return {
        success: true,
        task: updateResult.task,
        commitHash
    };
}

export async function rejectWalkthrough(projectId: string, taskId: string, feedback?: string): Promise<{ success: boolean; task: Task }> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}/reject-walkthrough`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
    });
    if (!res.ok && res.status !== 202) {
        throw new Error("Failed to reject walkthrough");
    }
    return res.json();
}

export interface CancelResult {
    success: boolean;
    task: Task;
    restoredFiles: number;
    warning?: string;
}

export async function cancelWalkthrough(projectId: string, taskId: string, feedback?: string): Promise<CancelResult> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}/cancel-walkthrough`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to cancel walkthrough");
    }
    return res.json();
}

export interface CommitPushResult {
    success: boolean;
    message: string;
    filesCommitted: number;
    pushed?: boolean;
    error?: string;
}

export async function commitAndPush(id: string, message: string): Promise<CommitPushResult> {
    const res = await authFetch(`${API_URL}/${id}/commit-push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to commit and push");
    }
    return res.json();
}

export interface GeneratedMessage {
    message: string;
    generated: boolean;
    note?: string;
}

export async function generateCommitMessage(id: string, taskId?: string): Promise<GeneratedMessage> {
    const res = await authFetch(`${API_URL}/${id}/generate-commit-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
    });
    if (!res.ok) {
        throw new Error("Failed to generate commit message");
    }
    return res.json();
}


/**
 * Update project details
 */
export async function updateProject(
    id: string,
    // end_state_reason/source are revision metadata consumed by the server's
    // end-state history appender (not stored as columns).
    updates: Partial<Project> & { end_state_reason?: string; end_state_source?: string },
): Promise<Project> {
    const res = await authFetch(`${API_URL}/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update project");
    }
    return res.json();
}

/**
 * Delete result from the server
 */
export interface DeleteResult {
    success: boolean;
    dbDeleted: boolean;
    filesDeleted: boolean;
    message: string;
    error?: string;
}

/**
 * Delete a project from the database and optionally from the filesystem
 * @param id - Project ID
 * @param deleteFiles - If true, also delete the project folder from disk
 */
export async function deleteProject(id: string, deleteFiles: boolean = false): Promise<DeleteResult> {
    const res = await authFetch(`${API_URL}/${id}?deleteFiles=${deleteFiles}`, {
        method: 'DELETE',
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete project');
    }
    return res.json();
}

/**
 * Archive a project and all of its tasks. Reversible and DB-only — the project's
 * files on disk are never touched. Archived projects drop off the dashboard and
 * out of context-retrieval paths.
 */
export async function archiveProject(id: string): Promise<{ success: boolean; project: Project; tasksArchived: number; message: string }> {
    const res = await authFetch(`${API_URL}/${id}/archive`, { method: 'POST' });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to archive project');
    }
    return res.json();
}

/** Restore an archived project and its tasks. */
export async function unarchiveProject(id: string): Promise<{ success: boolean; project: Project; tasksRestored: number; message: string }> {
    const res = await authFetch(`${API_URL}/${id}/unarchive`, { method: 'POST' });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to unarchive project');
    }
    return res.json();
}

/**
 * Get project README content
 */
export async function getProjectReadme(id: string): Promise<{ exists: boolean; content: string | null; filename?: string }> {
    const res = await authFetch(`${API_URL}/${id}/readme`);
    if (!res.ok) {
        throw new Error("Failed to fetch README");
    }
    return res.json();
}



/**
 * Get project context files (Conductor)
 */
export async function getProjectContext(id: string): Promise<{ contexts: Array<{ context_type: string, content: string, status: string, updated_at: string }> }> {
    const res = await authFetch(`${API_URL}/${id}/context`);
    if (!res.ok) {
        throw new Error("Failed to fetch project context");
    }
    return res.json();
}

/**
 * Update project context file
 */
export async function updateProjectContext(id: string, type: string, content: string, status?: string): Promise<{ success: boolean; context: any }> {
    const res = await authFetch(`${API_URL}/${id}/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, content, status }),
    });
    if (!res.ok) {
        throw new Error("Failed to update project context");
    }
    return res.json();
}

/**
 * Sync context from Git (git pull → read .context/ files → upsert to DB)
 */
export async function syncContextFromGit(id: string): Promise<{ success: boolean; synced: number; pulled: boolean; errors: string[] }> {
    const res = await authFetch(`${API_URL}/${id}/context/sync`, {
        method: 'POST',
    });
    if (!res.ok) {
        throw new Error("Failed to sync context from Git");
    }
    return res.json();
}

/**
 * Verify context sync status (compare DB vs local .context/ files)
 */
export async function verifyContextSync(id: string): Promise<{ inSync: boolean; differences: Array<{ type: string; issue: string }> }> {
    const res = await authFetch(`${API_URL}/${id}/context/verify`);
    if (!res.ok) {
        throw new Error("Failed to verify context sync");
    }
    return res.json();
}
