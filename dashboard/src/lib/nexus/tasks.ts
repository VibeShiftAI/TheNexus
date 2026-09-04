import type { InitiativeValidation } from './initiatives';
import type { TaskBoardStatus } from '@praxis/contract';
import { TaskBoardStatusSchema } from '@praxis/contract';
import { API_URL, authFetch } from './shared';
import type { BoardProject } from '../task-board';

// ═══════════════════════════════════════════════════════════════
// TASK MANAGER API
// ═══════════════════════════════════════════════════════════════

/** Standard task lifecycle stages — the canonical enum from @praxis/contract
 *  (TaskBoardStatusSchema). Projects may define additional ad-hoc stages. */
export const STANDARD_STATUSES = TaskBoardStatusSchema.options;
export type StandardTaskStatus = TaskBoardStatus;

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


