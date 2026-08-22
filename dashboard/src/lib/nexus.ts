// ═══════════════════════════════════════════════════════════════
// SYSTEM MONITORING TYPES (from @praxis/contract)
// ═══════════════════════════════════════════════════════════════

import type {
  PortInfo as _PortInfo,
  SystemInfo as _SystemInfo,
  PraxisTelemetry as _PraxisTelemetry,
  SystemStatus as _SystemStatus,
} from '@praxis/contract';

export type PortInfo = _PortInfo;
export type SystemInfo = _SystemInfo;
export type PraxisTelemetry = _PraxisTelemetry;
export type SystemStatus = _SystemStatus;

/** Daily API call budget thresholds (mirrored from @praxis/contract) */
export const API_BUDGET = {
  WARNING: 500,
  AUTONOMOUS_LIMIT: 800,
  HARD_LIMIT: 1200,
} as const;

export interface TokenUsageEntry {
    timestamp: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    projectId: string | null;
    task: string | null;
}

export interface UsageStats {
    totals: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        estimatedCostUSD: number;
    };
    byProvider: Record<string, {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cost: number;
        callCount: number;
    }>;
    byModel: Record<string, {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cost: number;
        callCount: number;
    }>;
    recentUsage: TokenUsageEntry[];
    projectStats?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cost: number;
        callCount: number;
    };
}

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

export interface Note {
    id: string;
    project_id: string | null;
    content: string;
    /** Free-form in the DB; common values: general, decision, blocker, reminder, daily-log, idea, bug, archived. */
    category: string;
    source: 'praxis' | 'operator';
    pinned: boolean;
    created_at: string;
    updated_at: string;
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

// Use relative URL to allow Next.js rewrites to proxy requests to localhost:4000
// This is critical for production where the browser can't access localhost directly
import { getAuthHeader } from './auth';
import type { BoardProject } from './task-board';

const API_URL = '/api/projects';

// Helper for authenticated fetch
async function authFetch(url: string, options: RequestInit = {}) {
    const headers = await getAuthHeader();
    // credentials: 'include' ensures Cloudflare Access cookies are sent
    // when accessing via the Cloudflare Tunnel (nexus.vibeshiftai.com)
    // Add a cache-buster query param to bypass stuck 308 Permanent Redirects cached by the browser
    const urlWithCacheBuster = url.includes('?') ? `${url}&_cb=${Date.now()}` : `${url}?_cb=${Date.now()}`;
    return fetch(urlWithCacheBuster, {
        ...options,
        credentials: 'include',
        headers: {
            ...headers,
            ...options.headers,
        }
    });
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

// ═══════════════════════════════════════════════════════════════
// TASK MANAGER API
// ═══════════════════════════════════════════════════════════════

/** Standard task lifecycle stages. Projects may define additional ad-hoc stages. */
export const STANDARD_STATUSES = ['idea', 'planning', 'todo', 'scheduled', 'dispatched', 'in_progress', 'needs_input', 'blocked', 'ready_for_review', 'review', 'completed', 'failed', 'cancelled', 'archived'] as const;
export type StandardTaskStatus = typeof STANDARD_STATUSES[number];

/** TaskStatus accepts any string — the standard stages above are defaults, but projects can use custom stages ad-hoc. */
export type TaskStatus = StandardTaskStatus | (string & {});

export interface Feedback {
    id: string;
    content: string;
    createdAt: string;
    action?: 'approve' | 'reject' | 'comment';  // What action was taken with this feedback
}

export interface ResearchReport {
    content: string;                // Markdown research content
    generatedAt: string;
    mode?: 'quick' | 'deep';        // Research mode used
    approvedAt?: string;
    rejectedAt?: string;
    feedback?: Feedback[];          // Comments/feedback on the research
}

export interface ImplementationPlan {
    content: string;                // Markdown plan content
    generatedAt: string;
    approvedAt?: string;
    rejectedAt?: string;
    feedback?: Feedback[];          // Comments/feedback on the plan
}

export interface Walkthrough {
    content: string;                // Markdown walkthrough content
    generatedAt: string;
    approvedAt?: string;
    rejectedAt?: string;
    commitHash?: string;            // Set after commit/push
    feedback?: Feedback[];          // Comments/feedback on the walkthrough
}

export interface Task {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    createdAt: string;
    updatedAt?: string;

    // Phase 2 fields
    researchInteractionId?: string;         // For deep research persistence
    researchStartedAt?: string;             // For deep research persistence
    researchError?: string;                 // For deep research persistence

    researchReport?: ResearchReport;        // AI research output
    spec_output?: string;                   // Task specification
    implementationPlan?: ImplementationPlan;
    walkthrough?: Walkthrough;

    model_assignment?: string | null;

    // First-class citizen fields
    initiativeValidation?: InitiativeValidation;
    source?: string;

    metadata?: {
        [key: string]: any;
    };
}

export interface TasksResponse {
    tasks: Task[];
}

export interface InitiativeValidation {
    classification: 'TASK' | 'BUG' | 'QUESTION' | 'CLARIFICATION_NEEDED';
    confidence: number;
    reasoning: string;
    requiresClarification: boolean;
}

export async function validateInitiative(title: string, description?: string): Promise<InitiativeValidation> {
    // API_URL is .../api/projects. We want .../api/initiatives/validate
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/initiatives/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description }),
    });
    if (!res.ok) {
        throw new Error("Failed to validate initiative");
    }
    return res.json();
}

export async function getTasks(id: string): Promise<TasksResponse> {
    const res = await authFetch(`${API_URL}/${id}/tasks`);
    if (!res.ok) {
        throw new Error("Failed to fetch planned tasks");
    }
    return res.json();
}

export async function addTask(
    id: string,
    title: string,
    description?: string,
    model_assignment?: string | null,
    sequence?: {
        /** Predecessor task ids — all must complete before this task starts. */
        dependencies?: string[];
        /** The single task to auto-start after this one completes. */
        successor_id?: string | null;
    },
): Promise<{ success: boolean; task: Task }> {
    const res = await authFetch(`${API_URL}/${id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title,
            description,
            model_assignment,
            ...(sequence?.dependencies?.length ? { dependencies: sequence.dependencies } : {}),
            ...(sequence?.successor_id ? { successor_id: sequence.successor_id } : {}),
        }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to add task");
    }
    return res.json();
}

export async function deleteTask(id: string, taskId: string): Promise<{ success: boolean }> {
    const res = await authFetch(`${API_URL}/${id}/tasks/${taskId}`, {
        method: 'DELETE',
    });
    if (!res.ok) {
        throw new Error("Failed to delete task");
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

export async function updateTask(
    id: string,
    taskId: string,
    updates: {
        title?: string;
        description?: string;
        status?: TaskStatus;
        // Artifact fields
        research_output?: string | null;
        plan_output?: string | null;
        walkthrough?: string | null;
        model_assignment?: string | null;
        [key: string]: any;  // Allow other fields
    }
): Promise<{ success: boolean; task: Task }> {
    const res = await authFetch(`${API_URL}/${id}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    if (!res.ok) {
        throw new Error("Failed to update task");
    }
    return res.json();
}

/** A task fetched by id alone (flat endpoint) — includes its raw db columns. */
export interface TaskById extends Task {
    project_id?: string | null;
    name?: string;
    priority?: number;
    created_at?: string;
    updated_at?: string;
    suspended_reason?: string | null;
    suspended_context?: string | null;
    /** Predecessor task ids — all must complete before this task starts. */
    dependencies?: string[];
    /** The single task to start immediately after this one completes. */
    successor_id?: string | null;
    /** Saved dispatch-console defaults — the task screen auto-saves these. */
    default_executor?: string | null;
    default_model?: string | null;
    dispatch_instructions?: string | null;
}

/**
 * Fetch a single task by id without knowing its project (top-level
 * /api/tasks/:taskId). Returns null on 404 — the task screen shows a
 * not-found state instead of throwing.
 */
export async function getTaskById(taskId: string): Promise<TaskById | null> {
    const baseUrl = API_URL.replace('/projects', '/tasks');
    const res = await authFetch(`${baseUrl}/${encodeURIComponent(taskId)}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to fetch task (${res.status})`);
    return res.json();
}

/**
 * Update a task by id alone (top-level /api/tasks/:taskId PATCH) — for the
 * task screen, which may not have the project loaded yet.
 */
export async function updateTaskById(
    taskId: string,
    updates: { status?: string; priority?: number; description?: string; model_assignment?: string | null; [key: string]: any },
): Promise<{ success: boolean; task: Task }> {
    const baseUrl = API_URL.replace('/projects', '/tasks');
    const res = await authFetch(`${baseUrl}/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error((body as { error?: string }).error || 'Failed to update task');
    }
    return res.json();
}

/**
 * Update a task's priority (0=low, 1=normal, 2=high).
 * Uses the top-level /api/tasks/:taskId endpoint, which handles the `priority` column directly.
 */
export async function setTaskPriority(taskId: string, priority: number): Promise<{ success: boolean; task: Task }> {
    const baseUrl = API_URL.replace('/projects', '/tasks');
    const res = await authFetch(`${baseUrl}/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority }),
    });
    if (!res.ok) {
        throw new Error("Failed to update task priority");
    }
    return res.json();
}

export async function addResearchFeedback(projectId: string, taskId: string, feedback: string): Promise<{ success: boolean; task: Task }> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}/research-feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
    });
    if (!res.ok) {
        throw new Error("Failed to add feedback");
    }
    return res.json();
}

export async function addPlanFeedback(projectId: string, taskId: string, feedback: string): Promise<{ success: boolean; task: Task }> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}/plan-feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
    });
    if (!res.ok) {
        throw new Error("Failed to add feedback");
    }
    return res.json();
}

export async function addWalkthroughFeedback(projectId: string, taskId: string, feedback: string): Promise<{ success: boolean; task: Task }> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}/walkthrough-feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
    });
    if (!res.ok) {
        throw new Error("Failed to add feedback");
    }
    return res.json();
}

// ═══════════════════════════════════════════════════════════════
// AUTO-RESEARCH API
// ═══════════════════════════════════════════════════════════════

export interface ResearchStatus {
    status: 'idle' | 'researching' | 'completed' | 'error';
    error: string | null;
    lastResearchDate: string | null;
}

export async function researchTasks(projectId: string): Promise<{ success: boolean; message: string; status: string }> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok && res.status !== 202) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to start research');
    }
    return res.json();
}

export async function getResearchStatus(projectId: string): Promise<ResearchStatus> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/research/status`);
    if (!res.ok) {
        throw new Error('Failed to get research status');
    }
    return res.json();
}


// ═══════════════════════════════════════════════════════════════
// TASK EDITING API
// ═══════════════════════════════════════════════════════════════

export interface UpdateTaskData {
    title?: string;
    description?: string;
    status?: TaskStatus;
    model_assignment?: string | null;
}

export interface ReviewItem {
    type: 'task-research' | 'task-plan' | 'task-walkthrough' | 'project-context';
    id: string;
    projectId: string;
    name: string;
    level: 'Task' | 'Project';
}

export interface DashboardStats {
    tasksByStatus: Record<string, number>;
    artifactsInReview: {
        total: number;
        project: number;
        task: number;
        items: ReviewItem[];
    };
}

export async function getDashboardStats(): Promise<DashboardStats> {
    const res = await authFetch(`${API_URL.replace('/api/projects', '/api/dashboard/stats')}`);
    if (!res.ok) {
        throw new Error("Failed to fetch dashboard stats");
    }
    return res.json();
}

export async function getBoardState(projectId?: string): Promise<BoardProject[]> {
    const baseUrl = API_URL.replace('/projects', '');
    const params = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    const res = await authFetch(`${baseUrl}/board-state${params}`);
    if (!res.ok) {
        throw new Error("Failed to fetch board state");
    }
    return res.json();
}
/**
 * Update a task's title and description
 * Only works for tasks in 'idea' or 'planning' status
 */
export async function updateTaskDetails(projectId: string, taskId: string, data: UpdateTaskData): Promise<{ success: boolean; task: Task }> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
    });

    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to update task');
    }

    return res.json();
}


// ═══════════════════════════════════════════════════════════════
// SYSTEM MONITORING API
// ═══════════════════════════════════════════════════════════════

/**
 * Get current system status (ports, CPU, memory)
 */
export async function getSystemStatus(): Promise<SystemStatus> {
    const baseUrl = API_URL.replace('/projects', '');
    const res = await authFetch(`${baseUrl}/system/status`);
    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to get system status (${res.status}): ${errorText.slice(0, 100)}. Make sure to restart the backend server.`);
    }
    return res.json();
}

/**
 * Get AI token usage statistics
 */
export async function getUsageStats(options?: {
    projectId?: string;
    provider?: string;
    days?: number;
}): Promise<UsageStats> {
    const params = new URLSearchParams();
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.provider) params.set('provider', options.provider);
    if (options?.days) params.set('days', options.days.toString());

    const baseUrl = API_URL.replace('/projects', '');
    const url = params.toString()
        ? `${baseUrl}/ai/usage?${params.toString()}`
        : `${baseUrl}/ai/usage`;

    const res = await authFetch(url);
    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to get usage stats (${res.status}): ${errorText.slice(0, 100)}. Make sure to restart the backend server.`);
    }
    return res.json();
}

/**
 * Reset all usage statistics (requires confirmation)
 */
export async function resetUsageStats(): Promise<{ success: boolean; message: string }> {
    const baseUrl = API_URL.replace('/projects', '');
    const res = await authFetch(`${baseUrl}/ai/usage/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET_ALL_USAGE_STATS' })
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to reset usage stats');
    }
    return res.json();
}

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


// ═══════════════════════════════════════════════════════════════
// SUPERVISOR / WORKFLOW STATUS API
// ═══════════════════════════════════════════════════════════════

export type SupervisorPhase = 'idle' | 'researching' | 'planning' | 'implementing' | 'reviewing' | 'committing' | 'completed' | 'error';

export interface SupervisorStatus {
    status: TaskStatus;
    phase?: SupervisorPhase; // For backward compatibility in UI
    session: {
        startedAt: string;
        lastActivityAt: string;
        actionsCompleted: any[];
        currentAction: any;
        error: string | null;
        completedAt?: string;
    } | null;
    hasWalkthrough: boolean;
    error: string | null;
}

/**
 * Get the current supervisor status for a task
 */
export async function getSupervisorStatus(projectId: string, taskId: string): Promise<SupervisorStatus> {
    const res = await authFetch(`${API_URL}/${projectId}/tasks/${taskId}/implement/status`);

    if (!res.ok) {
        throw new Error('Failed to get supervisor status');
    }

    return res.json();
}



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

// ═══════════════════════════════════════════════════════════════
// MULTI-LEVEL WORKFLOW SYSTEM TYPES & API
// ═══════════════════════════════════════════════════════════════

// Dashboard Initiative Types
export type InitiativeStatus = 'idea' | 'planning' | 'in_progress' | 'paused' | 'complete' | 'cancelled';
export type InitiativeType = 'security-sweep' | 'dependency-audit' | 'readme-update' | 'api-migration' | 'health-check' | 'documentation' | 'custom';

export interface DashboardInitiative {
    id: string;
    name: string;
    description: string;
    workflow_type: InitiativeType;
    status: InitiativeStatus;
    configuration: Record<string, unknown>;
    target_projects: string[];
    progress: Record<string, unknown>;
    supervisor_status?: string;
    supervisor_details?: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

export interface InitiativeProjectProgress {
    id: string;
    initiative_id: string;
    project_id: string;
    status: 'pending' | 'in_progress' | 'complete' | 'skipped' | 'failed';
    spawned_workflow_id?: string;
    spawned_task_ids?: string[];
    result: Record<string, unknown>;
    error_message?: string;
    started_at?: string;
    completed_at?: string;
    project?: { id: string; name: string; path: string };
}

export interface InitiativeSummary {
    total: number;
    pending: number;
    inProgress: number;
    complete: number;
    failed: number;
}

// ─────────────────────────────────────────────────────────────────
// DASHBOARD INITIATIVES API
// ─────────────────────────────────────────────────────────────────

const INITIATIVES_API = '/api/initiatives';

/**
 * Get all dashboard initiatives
 */
export async function getDashboardInitiatives(status?: InitiativeStatus): Promise<{ initiatives: DashboardInitiative[] }> {
    const params = status ? `?status=${status}` : '';
    const res = await authFetch(`${INITIATIVES_API}${params}`);
    if (!res.ok) {
        throw new Error('Failed to fetch initiatives');
    }
    return res.json();
}

/**
 * Get a single dashboard initiative with progress
 */
export async function getDashboardInitiative(id: string): Promise<{
    initiative: DashboardInitiative;
    progress: InitiativeProjectProgress[];
    summary: InitiativeSummary;
}> {
    const res = await authFetch(`${INITIATIVES_API}/${id}`);
    if (!res.ok) {
        throw new Error('Failed to fetch initiative');
    }
    return res.json();
}

/**
 * Create a new dashboard initiative
 */
export async function createDashboardInitiative(data: {
    name: string;
    description?: string;
    workflow_type: InitiativeType;
    target_projects?: string[];
    configuration?: Record<string, unknown>;
}): Promise<{ success: boolean; initiative: DashboardInitiative }> {
    const res = await authFetch(INITIATIVES_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to create initiative');
    }
    return res.json();
}

/**
 * Update a dashboard initiative
 */
export async function updateDashboardInitiative(
    id: string,
    updates: Partial<Pick<DashboardInitiative, 'name' | 'description' | 'status' | 'configuration' | 'target_projects'>>
): Promise<{ success: boolean; initiative: DashboardInitiative }> {
    const res = await authFetch(`${INITIATIVES_API}/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
    });
    if (!res.ok) {
        throw new Error('Failed to update initiative');
    }
    return res.json();
}

/**
 * Delete a dashboard initiative
 */
export async function deleteDashboardInitiative(id: string): Promise<{ success: boolean; message: string }> {
    const res = await authFetch(`${INITIATIVES_API}/${id}`, {
        method: 'DELETE'
    });
    if (!res.ok) {
        throw new Error('Failed to delete initiative');
    }
    return res.json();
}

/**
 * Run a dashboard initiative across targeted projects
 */
export async function runDashboardInitiative(id: string): Promise<{ success: boolean; message: string; initiative: DashboardInitiative }> {
    const res = await authFetch(`${INITIATIVES_API}/${id}/run`, {
        method: 'POST'
    });
    if (!res.ok) {
        throw new Error('Failed to run initiative');
    }
    return res.json();
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS / ENV EDITOR API
// ═══════════════════════════════════════════════════════════════

export interface EnvSettings {
    PROJECT_ROOT: string;
    GOOGLE_API_KEY: string;
    OPENAI_API_KEY: string;
    ANTHROPIC_API_KEY: string;
    XAI_API_KEY: string;
    NEXUS_SERVICE_KEY: string;
}

export async function getEnvSettings(): Promise<EnvSettings> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/settings/env`);
    if (!res.ok) throw new Error("Failed to fetch environment settings");
    return res.json();
}

export async function saveEnvSettings(settings: Partial<EnvSettings>): Promise<{ success: boolean; updated: string[] }> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/settings/env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save environment settings");
    }
    return res.json();
}

// ─── Cross-project API-key rotation ────────────────────────────────────────

export interface ProjectKeyLocation {
    project: string;
    /** Path relative to the projects root, e.g. "Praxis/.env". */
    file: string;
    /** Masked preview (first 4 + last 4) — the server never sends full values. */
    masked: string;
}

export interface ProjectKeyGroup {
    name: string;
    locations: ProjectKeyLocation[];
}

// ── Usage monitor / model routing (Praxis via /api/usage-monitor proxy) ────

export interface UsageWindow {
    startedAt: number;
    endsAt: number;
    events: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

export interface UsageRateLimit {
    ts: number;
    windowMinutes: number;
    usedPercent: number;
    resetsAt: number | null;
    planType?: string;
}

export interface UsageFamilyState {
    today: {
        events: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        byModel: Record<string, { events: number; inputTokens: number; outputTokens: number }>;
        estCostUsd: number;
    };
    window: UsageWindow | null;
    rateLimits: UsageRateLimit[];
    limit: { coolingDown: boolean; lastHitAt: number | null; resetAt: number | null };
}

export interface RoutingDecision {
    ts: string;
    task_id: string | null;
    task_title: string | null;
    complexity: number | null;
    confidence: number | null;
    scorer: string | null;
    executor: string | null;
    model: string | null;
    thinking_level: string | null;
    applied: number;
    rationale: string | null;
}

export interface UsageMonitorState {
    generatedAt: number;
    families: { claude: UsageFamilyState; codex: UsageFamilyState };
    recentDecisions: RoutingDecision[];
}

export async function getUsageMonitorState(): Promise<UsageMonitorState> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/usage-monitor/state`);
    if (!res.ok) throw new Error("Failed to load usage monitor state");
    return res.json();
}

export async function getProjectKeys(): Promise<{ root: string; keys: ProjectKeyGroup[] }> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/settings/project-keys`);
    if (!res.ok) throw new Error("Failed to scan project keys");
    return res.json();
}

export async function rotateProjectKey(
    name: string,
    value: string,
    files?: string[],
): Promise<{ success: boolean; name: string; updated: string[] }> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/settings/project-keys/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value, files }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to rotate key");
    }
    return res.json();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Notes API
// ═══════════════════════════════════════════════════════════════════════════════

export async function getProjectNotes(projectId: string): Promise<Note[]> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/projects/${projectId}/notes`);
    if (!res.ok) throw new Error('Failed to fetch project notes');
    const data = await res.json();
    return data.notes || [];
}

export async function getGlobalNotes(): Promise<Note[]> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/notes`);
    if (!res.ok) throw new Error('Failed to fetch global notes');
    const data = await res.json();
    return data.notes || [];
}

export async function createNote(
    content: string,
    category: string = 'general',
    projectId?: string | null
): Promise<Note> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const url = projectId
        ? `${baseUrl}/projects/${projectId}/notes`
        : `${baseUrl}/notes`;
    const res = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, category, source: 'operator' }),
    });
    if (!res.ok) throw new Error('Failed to create note');
    const data = await res.json();
    return data.note;
}

export async function updateNote(
    noteId: string,
    updates: { content?: string; category?: string; pinned?: number }
): Promise<Note> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/notes/${noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error('Failed to update note');
    const data = await res.json();
    return data.note;
}

export async function deleteNote(noteId: string): Promise<void> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/notes/${noteId}`, {
        method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete note');
}

// ─── Travel Shell Tabs ──────────────────────────────────────────────────────
// The Windows travel shell pulls its tab roster from /api/tabs at launch;
// editing here means no rebuild/reinstall to change the tab lineup.

export interface TravelTab {
    id: string;
    label: string;
    url: string;
    accent: string;
    hosted?: boolean;
    enabled: boolean;
}

export async function getTravelTabs(): Promise<TravelTab[]> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/tabs?all=1`);
    if (!res.ok) throw new Error("Failed to fetch travel tabs");
    const data = await res.json();
    return data.tabs;
}

export async function saveTravelTabs(tabs: TravelTab[]): Promise<TravelTab[]> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/tabs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabs }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save travel tabs");
    }
    return (await res.json()).tabs;
}

// ═══════════════════════════════════════════════════════════════
// CONTACTS — shared stakeholder directory (@praxis/contract shapes)
// ═══════════════════════════════════════════════════════════════

import type {
    Contact as _Contact,
    ProjectContact as _ProjectContact,
    CommsFeed as _CommsFeed,
} from '@praxis/contract';

export type Contact = _Contact & { projects?: Array<{ project_id: string; project_name: string; role?: string | null }> };
export type ProjectContact = _ProjectContact;
export type CommsFeed = _CommsFeed;
/** Unified directory naming (2026-07-16): a Member IS a Contact row. */
export type Member = Contact;
export type ProjectMember = ProjectContact;

const CONTACTS_URL = '/api/contacts';

export async function listContacts(search?: string): Promise<Contact[]> {
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';
    const res = await authFetch(`${CONTACTS_URL}${qs}`);
    if (!res.ok) throw new Error('Failed to list contacts');
    return (await res.json()).contacts;
}

export async function getContact(id: string): Promise<Contact> {
    const res = await authFetch(`${CONTACTS_URL}/${id}`);
    if (!res.ok) throw new Error('Failed to fetch contact');
    return res.json();
}

export async function createContact(input: Partial<Contact> & { name: string }): Promise<Contact> {
    const res = await authFetch(CONTACTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to create contact');
    return data.contact;
}

export async function updateContact(id: string, updates: Partial<Contact>): Promise<Contact> {
    const res = await authFetch(`${CONTACTS_URL}/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to update contact');
    return data.contact;
}

export async function deleteContact(id: string): Promise<void> {
    const res = await authFetch(`${CONTACTS_URL}/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete contact');
}

export async function getProjectContacts(projectId: string): Promise<ProjectContact[]> {
    const res = await authFetch(`${CONTACTS_URL}?project_id=${encodeURIComponent(projectId)}`);
    if (!res.ok) throw new Error('Failed to fetch project contacts');
    return (await res.json()).contacts;
}

export async function linkContactToProject(contactId: string, projectId: string, role?: string, notes?: string): Promise<void> {
    const res = await authFetch(`${CONTACTS_URL}/${contactId}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, role, notes }),
    });
    if (!res.ok) throw new Error('Failed to link contact');
}

/**
 * Update a member's link to a project. Only the provided fields change on the
 * server; `extra.decision_maker` flags/unflags the member as a Primary
 * Decision Maker (see the STAKEHOLDERS section).
 */
export async function updateContactLink(
    contactId: string,
    projectId: string,
    role?: string | null,
    notes?: string | null,
    extra?: { decision_maker?: boolean },
): Promise<void> {
    const res = await authFetch(`${CONTACTS_URL}/${contactId}/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, notes, ...(extra ?? {}) }),
    });
    if (!res.ok) throw new Error('Failed to update contact link');
}

/** Flag / unflag a project member as Primary Decision Maker (PATCHes only `decision_maker`). */
export async function setProjectDecisionMaker(contactId: string, projectId: string, on: boolean): Promise<void> {
    const res = await authFetch(`${CONTACTS_URL}/${contactId}/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision_maker: on }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update decision-maker flag');
    }
}

export async function unlinkContactFromProject(contactId: string, projectId: string): Promise<void> {
    const res = await authFetch(`${CONTACTS_URL}/${contactId}/projects/${projectId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to unlink contact');
}

/** External-comms feed (Praxis feedback gateway), via the praxis relay. */
export async function getCommsFeed(since?: string): Promise<CommsFeed> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : '';
    const res = await authFetch(`/api/praxis/comms${qs}`);
    if (!res.ok) throw new Error('Comms feed unavailable');
    return res.json();
}

// ═══════════════════════════════════════════════════════════════
// STAKEHOLDERS — PDM governance: request approval queue, comms
// settings, Project Status Reports (via Praxis), review meetings
// (@praxis/contract shapes — entities/stakeholders.ts)
// ═══════════════════════════════════════════════════════════════

import type {
    StakeholderGate as _StakeholderGate,
    StakeholderDecision as _StakeholderDecision,
    ProjectCommsSettings as _ProjectCommsSettings,
    ReportTemplate as _ReportTemplate,
    StakeholderReport as _StakeholderReport,
} from '@praxis/contract';
import type { CalendarEvent } from './calendar';
import { calendarEventsUrl } from './calendar';

export type StakeholderGate = _StakeholderGate;
export type StakeholderDecision = _StakeholderDecision;
export type ProjectCommsSettings = _ProjectCommsSettings;
export type ReportTemplate = _ReportTemplate;
export type StakeholderReport = _StakeholderReport;

/** How the dashboard signs every gate decision it records. */
export const OPERATOR_DECIDER: NonNullable<StakeholderDecision['decided_by']> = {
    name: 'Robert (operator)',
    via: 'operator',
};

/** A gated feedback request as served by GET /api/projects/:id/requests. */
export interface ProjectRequest {
    id: string;
    name: string;
    description?: string;
    status: string;
    priority?: number;
    created_at: string;
    updated_at?: string;
    source?: string;
    gate: StakeholderGate;
}

/** Requests awaiting (or past) a PDM/operator decision. `pending` = gate still open. */
export async function getProjectRequests(projectId: string, status: 'pending' | 'all' = 'pending'): Promise<ProjectRequest[]> {
    const res = await authFetch(`${API_URL}/${encodeURIComponent(projectId)}/requests?status=${status}`);
    if (!res.ok) throw new Error(`Requests API unavailable (${res.status})`);
    const data = await res.json();
    return Array.isArray(data?.requests) ? data.requests : [];
}

/** Record a gate decision on a request task (approve → idea, reject/duplicate → cancelled, defer → stays blocked). */
export async function decideStakeholderRequest(
    taskId: string,
    body: StakeholderDecision,
): Promise<{ success: boolean; task: Task; gate: StakeholderGate }> {
    const res = await authFetch(`/api/tasks/${encodeURIComponent(taskId)}/stakeholder-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to record decision (${res.status})`);
    return data;
}

// ─── Review meetings (calendar series, event_type "stakeholder_meeting") ───

export type MeetingRecurrence = 'weekly' | 'biweekly' | 'monthly';

/** Calendar row + the series fields stakeholder meetings carry. */
export interface MeetingEvent extends CalendarEvent {
    series_id: string | null;
    recurrence: MeetingRecurrence | null;
    /** Member ids invited to the meeting. */
    attendees: string[];
}

export interface CreateMeetingSeriesInput {
    title: string;
    /** ISO timestamp of the first occurrence. */
    start_time: string;
    end_time?: string;
    /** Default 60. */
    duration_minutes?: number;
    /** null/undefined = one-off meeting. */
    recurrence?: MeetingRecurrence | null;
    /** Occurrences when recurring (default 12, max 52). */
    count?: number;
    project_id: string;
    attendees?: string[];
    description?: string;
}

function normalizeMeeting(raw: CalendarEvent & Partial<MeetingEvent>): MeetingEvent {
    return {
        ...raw,
        series_id: raw.series_id ?? null,
        recurrence: raw.recurrence ?? null,
        attendees: Array.isArray(raw.attendees) ? raw.attendees : [],
    };
}

/** Stakeholder review meetings for a project between two instants (inclusive window). */
export async function getProjectMeetings(projectId: string, from: Date, to: Date): Promise<MeetingEvent[]> {
    const url =
        `${calendarEventsUrl(from.toISOString(), to.toISOString())}` +
        `&project_id=${encodeURIComponent(projectId)}&event_type=stakeholder_meeting`;
    const res = await authFetch(url);
    if (!res.ok) throw new Error(`Calendar API unavailable (${res.status})`);
    const data = await res.json();
    const rows: Array<CalendarEvent & Partial<MeetingEvent>> = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
    // Defensive client-side filter — an older server ignores the query filters.
    return rows
        .filter((e) => e.event_type === 'stakeholder_meeting' && (e.project_id ?? null) === projectId)
        .map(normalizeMeeting)
        .sort((a, b) => a.start_time.localeCompare(b.start_time));
}

/** Create a one-off meeting (recurrence null) or a series of occurrences. */
export async function createMeetingSeries(body: CreateMeetingSeriesInput): Promise<{ series_id: string; events: MeetingEvent[] }> {
    const res = await authFetch('/api/calendar/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to schedule meeting (${res.status})`);
    return {
        series_id: data.series_id,
        events: Array.isArray(data.events) ? data.events.map(normalizeMeeting) : [],
    };
}

/** Remove every occurrence of a series starting at/after `from` (default: now). */
export async function deleteMeetingSeries(seriesId: string, from?: Date | string): Promise<{ deleted: number }> {
    const fromIso = from instanceof Date ? from.toISOString() : from;
    const qs = fromIso ? `?from=${encodeURIComponent(fromIso)}` : '';
    const res = await authFetch(`/api/calendar/series/${encodeURIComponent(seriesId)}${qs}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to delete meeting series (${res.status})`);
    return { deleted: Number(data.deleted ?? 0) };
}

/** Delete a single calendar event (one meeting occurrence). */
export async function deleteCalendarEvent(id: string): Promise<void> {
    const res = await authFetch(`/api/calendar/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to delete event (${res.status})`);
    }
}

// ─── Project Status Reports (Praxis, via the Nexus relay) ──────────────────

const STAKEHOLDER_REPORTS_URL = '/api/praxis/stakeholder-reports';

/** Reports Praxis has generated for a project, newest first. */
export async function listStakeholderReports(projectId: string): Promise<StakeholderReport[]> {
    const res = await authFetch(`${STAKEHOLDER_REPORTS_URL}?project_id=${encodeURIComponent(projectId)}`);
    if (!res.ok) throw new Error(`Reports API unavailable (${res.status})`);
    const data = await res.json();
    const reports: StakeholderReport[] = Array.isArray(data?.reports) ? data.reports : [];
    return [...reports].sort((a, b) => (b.generated_at ?? '').localeCompare(a.generated_at ?? ''));
}

/**
 * Ask Praxis to compose a report now. `dryRun` builds a preview (no send, no
 * HITL card) — it also makes Praxis create the project's branded template the
 * first time.
 */
export async function generateStakeholderReport(projectId: string, opts: { dryRun?: boolean } = {}): Promise<StakeholderReport> {
    const res = await authFetch(`${STAKEHOLDER_REPORTS_URL}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, trigger: 'manual', ...(opts.dryRun ? { dry_run: true } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Report generation failed (${res.status})`);
    if (!data?.report) throw new Error(data.detail || data.error || 'Praxis returned no report');
    return data.report as StakeholderReport;
}

/** Send a draft/review report to its recipients. */
export async function sendStakeholderReport(id: string): Promise<void> {
    const res = await authFetch(`${STAKEHOLDER_REPORTS_URL}/${encodeURIComponent(id)}/send`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) throw new Error(data.error || `Failed to send report (${res.status})`);
}

/** Dashboard-relative URL of a report's rendered HTML (served by the existing Praxis report proxy). */
export function stakeholderReportPreviewUrl(htmlFile?: string | null): string | null {
    if (!htmlFile) return null;
    const path = htmlFile.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    return `/api/praxis/report/${path}`;
}
