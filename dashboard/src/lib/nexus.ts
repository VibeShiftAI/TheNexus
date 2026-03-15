// ═══════════════════════════════════════════════════════════════
// SYSTEM MONITORING TYPES
// ═══════════════════════════════════════════════════════════════

export interface PortInfo {
    port: number;
    pid: number;
    process: string;
    address: string;
    protocol: string;
    hint: string | null;
    type: 'node' | 'python' | 'java' | 'other';
}

export interface SystemInfo {
    cpu: {
        usage: number;
        cores: number;
    };
    memory: {
        total: number;
        used: number;
        free: number;
        usagePercent: number;
    };
}

export interface SystemStatus {
    timestamp: string;
    system: SystemInfo;
    ports: PortInfo[];
    portCount: number;
    error?: string;
}

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

// Use relative URL to allow Next.js rewrites to proxy requests to localhost:4000
// This is critical for production where the browser can't access localhost directly
import { getAuthHeader } from './auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL
    ? `${process.env.NEXT_PUBLIC_API_URL}/api/projects`
    : '/api/projects'; // Fallback to relative path which Netlify/Next proxies

const MEMORY_API = process.env.NEXT_PUBLIC_API_URL
    ? `${process.env.NEXT_PUBLIC_API_URL}/api/memory`
    : '/api/memory';

// Helper for authenticated fetch
async function authFetch(url: string, options: RequestInit = {}) {
    const headers = await getAuthHeader();
    // Use the native fetch here, avoiding recursion
    return fetch(url, {
        ...options,
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

// Note: approvePlan and rejectPlan removed - plan approval is now handled by the Live Workflow overlay via /graph/nexus/{runId}/resume
export async function approveWalkthrough(projectId: string, taskId: string, feedback?: string): Promise<{ success: boolean; task: Task; commitHash?: string }> {
    // Step 1: Update task status to complete
    const updateResult = await updateTask(projectId, taskId, {
        status: 'complete' as TaskStatus,
        langgraph_status: 'completed'
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

export type TaskStatus = 'idea' | 'researching' | 'researched' | 'planning' | 'planned' | 'awaiting_approval' | 'implementing' | 'testing' | 'complete' | 'rejected' | 'cancelled';

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

    // LangGraph integration
    langGraph?: {
        runId: string;
        status: string;
        templateId?: string;
        startedAt: string;
    };
    langgraph_template?: string | null;  // Flat DB column — auto-assigned by compiler or user

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

export async function addTask(id: string, title: string, description?: string, templateId?: string): Promise<{ success: boolean; task: Task }> {
    const res = await authFetch(`${API_URL}/${id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, templateId }),
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
export async function updateProject(id: string, updates: Partial<Project>): Promise<Project> {
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
        // LangGraph workflow fields
        langgraph_run_id?: string | null;
        langgraph_status?: string | null;
        langgraph_template?: string | null;
        langgraph_started_at?: string | null;
        // Artifact fields
        research_output?: string | null;
        plan_output?: string | null;
        walkthrough?: string | null;
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
}

export interface ReviewItem {
    type: 'task-research' | 'task-plan' | 'task-walkthrough' | 'project-workflow' | 'project-context';
    id: string;
    projectId: string;
    name: string;
    level: 'Task' | 'Project';
}

export interface DashboardStats {
    tasksByStatus: Record<string, number>;
    activeProjectWorkflows: number;
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
// GLOBAL CONTEXT MEMORY TYPES & API
// ═══════════════════════════════════════════════════════════════

export interface MemoryPreference {
    value: unknown;
    confidence: number;
    source: 'inferred' | 'user-explicit' | 'project-detected';
}

export interface MemoryRule {
    id: string;
    rule: string;
    addedAt: string;
    source: 'user-explicit';
    enabled: boolean;
}

export interface ScaffoldingHints {
    language?: string;
    packageManager?: string;
    styling?: string;
    testingFramework?: string;
    lintingTool?: string;
    framework?: string;
    formatting?: Record<string, unknown>;
    rules?: string[];
}

export interface MemoryStats {
    preferenceCount: number;
    ruleCount: number;
    patternCount: number;
    projectHistoryCount: number;
    lastUpdated: string;
}

// MEMORY_API is already defined at top scope, removing duplicate declaration if present
// const MEMORY_API = ... 


export async function getMemoryPreferences(): Promise<Record<string, Record<string, MemoryPreference>>> {
    const res = await authFetch(`${MEMORY_API}/preferences`);
    if (!res.ok) throw new Error('Failed to get memory preferences');
    return res.json();
}

export async function setMemoryPreference(category: string, key: string, value: unknown): Promise<void> {
    const res = await authFetch(`${MEMORY_API}/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, key, value })
    });
    if (!res.ok) throw new Error('Failed to set memory preference');
}

export async function deleteMemoryPreference(category: string, key: string): Promise<void> {
    const res = await authFetch(`${MEMORY_API}/preferences/${category}/${key}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete memory preference');
}

export async function getMemoryRules(): Promise<MemoryRule[]> {
    const res = await authFetch(`${MEMORY_API}/rules`);
    if (!res.ok) throw new Error('Failed to get memory rules');
    return res.json();
}

export async function addMemoryRule(rule: string): Promise<{ id: string }> {
    const res = await authFetch(`${MEMORY_API}/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule })
    });
    if (!res.ok) throw new Error('Failed to add memory rule');
    return res.json();
}

export async function deleteMemoryRule(id: string): Promise<void> {
    const res = await authFetch(`${MEMORY_API}/rules/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete memory rule');
}

export async function toggleMemoryRule(id: string, enabled: boolean): Promise<void> {
    const res = await authFetch(`${MEMORY_API}/rules/${id}/toggle`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
    });
    if (!res.ok) throw new Error('Failed to toggle memory rule');
}

export async function getMemoryContext(): Promise<string> {
    const res = await authFetch(`${MEMORY_API}/context`);
    if (!res.ok) throw new Error('Failed to get memory context');
    const data = await res.json();
    return data.context;
}

export async function getScaffoldingHints(): Promise<ScaffoldingHints> {
    const res = await authFetch(`${MEMORY_API}/hints`);
    if (!res.ok) throw new Error('Failed to get scaffolding hints');
    return res.json();
}

export async function getMemoryStats(): Promise<MemoryStats> {
    const res = await authFetch(`${MEMORY_API}/stats`);
    if (!res.ok) throw new Error('Failed to get memory stats');
    return res.json();
}

export async function learnFromProject(projectId: string): Promise<{ analysis: unknown }> {
    const res = await authFetch(`${MEMORY_API}/learn/${projectId}`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to learn from project');
    return res.json();
}

// ═══════════════════════════════════════════════════════════════
// LANGGRAPH WORKFLOW API
// ═══════════════════════════════════════════════════════════════

const LANGGRAPH_API = '/api/langgraph';

export interface LangGraphHealthStatus {
    status: 'healthy' | 'unavailable';
    database?: { connected: boolean; message?: string };
    node_types?: string[];
    error?: string;
}

export interface WorkflowNode {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
}

export interface WorkflowEdge {
    id: string;
    source: string;
    target: string;
    label?: string;
}

export interface WorkflowTemplate {
    id: string;
    name: string;
    description: string;
    category: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
}

export interface WorkflowRun {
    id: string;
    workflow_id?: string;
    project_id: string;
    task_id?: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    current_node?: string;
    context: Record<string, unknown>;
    started_at: string;
    completed_at?: string;
    error?: string;
}

export interface WorkflowCheckpoint {
    checkpoint_id: string;
    thread_id: string;
    created_at: string;
    step: number;
    node: string;
}

/**
 * Check LangGraph engine health
 */
export async function getLangGraphHealth(): Promise<LangGraphHealthStatus> {
    try {
        const res = await authFetch(`${LANGGRAPH_API}/health`);
        return res.json();
    } catch {
        return { status: 'unavailable', error: 'LangGraph engine not reachable' };
    }
}

/**
 * Get available workflow templates - SINGLE SOURCE OF TRUTH
 * 
 * This is the only function that should be used to fetch workflow templates.
 * Uses the LangGraph proxy which reads templates from Python backend JSON files.
 * 
 * @param level Optional filter: 'dashboard', 'project', or 'task'
 */
export async function getWorkflowTemplates(level?: 'dashboard' | 'project' | 'task'): Promise<WorkflowTemplate[]> {
    // Ensure we're in browser context
    if (typeof window === 'undefined') {
        return [];
    }
    try {
        const params = level ? `?level=${level}` : '';
        const res = await authFetch(`${LANGGRAPH_API}/templates${params}`);
        if (!res.ok) {
            throw new Error(`Failed to fetch workflow templates: ${res.status}`);
        }
        const data = await res.json();
        return data.templates || [];
    } catch (err) {
        console.error('[getWorkflowTemplates] Error:', err);
        return [];  // Gracefully degrade when LangGraph service is unavailable
    }
}


/**
 * Delete a workflow template by ID
 * @param templateId The ID of the template to delete
 */
export async function deleteWorkflowTemplate(templateId: string): Promise<{ success: boolean; message?: string }> {
    const res = await authFetch(`${LANGGRAPH_API}/templates/${templateId}`, {
        method: 'DELETE'
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || err.error || 'Failed to delete template');
    }

    return res.json();
}

/**
 * Get available node types from the registry
 */
export async function getNodeTypes(): Promise<Record<string, unknown>> {
    const res = await authFetch(`${LANGGRAPH_API}/node-types`);
    if (!res.ok) throw new Error('Failed to get node types');
    return res.json();
}

// ═══════════════════════════════════════════════════════════════
// ATOMIC NODE SCHEMA API (Phase 3.6 n8n-Inspired)
// ═══════════════════════════════════════════════════════════════

export interface AtomicNodeProperty {
    displayName: string;
    name: string;
    type: string;
    default: unknown;
    description?: string;
    hint?: string;
    placeholder?: string;
    required?: boolean;
    options?: Array<{ name: string; value: string | number | boolean; description?: string }>;
    typeOptions?: Record<string, unknown>;
    displayOptions?: { show?: Record<string, unknown[]>; hide?: Record<string, unknown[]> };
}

export interface AtomicNodeSchema {
    type_id: string;
    display_name: string;
    description: string;
    category: string;
    icon: string;
    properties: AtomicNodeProperty[];
}

/**
 * Get all atomic node types with full property schemas
 */
export async function getAtomicNodeTypes(): Promise<{
    success: boolean;
    node_types: AtomicNodeSchema[];
    count: number;
    error?: string;
}> {
    const res = await authFetch(`${LANGGRAPH_API}/node-types/atomic`);
    if (!res.ok) throw new Error('Failed to get atomic node types');
    return res.json();
}

/**
 * Get property schema for a specific atomic node type
 * Used by NodeConfigPanel and Agent Manager for dynamic UI generation
 */
export async function getAtomicNodeSchema(typeId: string): Promise<AtomicNodeSchema> {
    const res = await authFetch(`${LANGGRAPH_API}/node-types/atomic/${typeId}`);
    if (!res.ok) throw new Error(`Failed to get schema for node type '${typeId}'`);
    return res.json();
}

/**
 * Compile/validate a workflow graph
 */
export async function compileWorkflow(graphConfig: {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
}): Promise<{
    success: boolean;
    message?: string;
    node_count?: number;
    edge_count?: number;
    entry_points?: string[];
    detail?: string;
}> {
    const res = await authFetch(`${LANGGRAPH_API}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(graphConfig)
    });
    return res.json();
}

/**
 * Save workflow as template
 */
export async function saveTemplate(
    name: string,
    description: string,
    nodes: any[],
    edges: any[],
    level: 'dashboard' | 'project' | 'task' = 'task',
    overwrite: boolean = false
): Promise<{ success: boolean; message?: string }> {
    const res = await authFetch(`${LANGGRAPH_API}/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name,
            description,
            nodes,
            edges,
            level,
            overwrite
        })
    });

    if (!res.ok) {
        if (res.status === 409) {
            throw new Error('DUPLICATE_NAME');
        }
        const err = await res.json();
        throw new Error(err.detail || 'Failed to save template');
    }

    return res.json();
}

/**
 * Run a workflow for a task
 */
export async function runTaskWorkflow(
    projectId: string,
    taskId: string,
    templateId?: string,
    customGraph?: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
): Promise<{
    success: boolean;
    run_id?: string;
    status?: string;
    message?: string;
    error?: string;
}> {
    const body: Record<string, unknown> = {
        project_id: projectId,
        task_id: taskId,
        input_data: { project_id: projectId, task_id: taskId }
    };

    if (templateId) {
        // Load template and use its graph config
        const templates = await getWorkflowTemplates();
        const template = templates.find(t => t.id === templateId);
        if (template) {
            body.graph_config = { nodes: template.nodes, edges: template.edges };
        }
    } else if (customGraph) {
        body.graph_config = customGraph;
    }

    const res = await authFetch(`${LANGGRAPH_API}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    return res.json();
}

/**
 * Get workflow run status
 */
export async function getWorkflowRunStatus(runId: string): Promise<WorkflowRun | null> {
    const res = await authFetch(`${LANGGRAPH_API}/runs/${runId}`);
    if (!res.ok) return null;
    return res.json();
}

/**
 * Get checkpoints for a workflow run (for time-travel)
 */
export async function getWorkflowCheckpoints(runId: string): Promise<WorkflowCheckpoint[]> {
    const res = await authFetch(`${LANGGRAPH_API}/runs/${runId}/checkpoints`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.checkpoints || [];
}

/**
 * Cancel a running workflow
 */
export async function cancelWorkflowRun(runId: string): Promise<{ success: boolean; message?: string }> {
    const res = await authFetch(`${LANGGRAPH_API}/runs/${runId}/cancel`, {
        method: 'POST'
    });
    return res.json();
}

/**
 * Run a specific task through LangGraph (uses project/task context)
 * This is the main integration point for running task pipelines
 */
export async function runTaskWithLangGraph(
    projectId: string,
    taskId: string,
    options?: {
        templateId?: string;
        graphConfig?: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
    }
): Promise<{
    success: boolean;
    run_id?: string;
    status?: string;
    message?: string;
    error?: string;
}> {
    // Ensure we're in browser context
    if (typeof window === 'undefined') {
        return { success: false, error: 'Cannot run outside browser context' };
    }
    try {
        // Use relative URL - Next.js rewrites proxy to backend in dev,
        // and API URL is configured via NEXT_PUBLIC_API_URL in production
        const res = await authFetch(`/api/projects/${projectId}/tasks/${taskId}/langgraph/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                templateId: options?.templateId,
                graphConfig: options?.graphConfig
            })
        });
        return res.json();
    } catch (err) {
        console.error('runTaskWithLangGraph error:', err);
        return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
}

/**
 * Get LangGraph run status for a task
 */
export async function getTaskLangGraphStatus(
    projectId: string,
    taskId: string,
    runId: string
): Promise<WorkflowRun | null> {
    const res = await authFetch(`/api/projects/${projectId}/tasks/${taskId}/langgraph/status?runId=${runId}`);
    if (!res.ok) return null;
    return res.json();
}

/**
 * Rewind a workflow run to a specific checkpoint
 */
export async function rewindWorkflow(
    runId: string,
    checkpointId: string
): Promise<{
    success: boolean;
    new_run_id?: string;
    message?: string;
    error?: string;
}> {
    const res = await authFetch(`${LANGGRAPH_API}/runs/${runId}/rewind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkpoint_id: checkpointId })
    });
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

// Project Workflow Types
export type ProjectWorkflowStatus = 'idea' | 'planning' | 'in_progress' | 'review' | 'complete' | 'cancelled';
export type ProjectWorkflowType = 'brand-development' | 'logo-development' | 'documentation' | 'release' | 'custom';

export interface WorkflowStage {
    id: string;
    name: string;
    description: string;
    order: number;
    agentId?: string;
}

export interface ProjectWorkflow {
    id: string;
    project_id: string;
    name: string;
    description: string;
    workflow_type: ProjectWorkflowType;
    status: ProjectWorkflowStatus;
    current_stage?: string;
    stages: WorkflowStage[];
    template_id?: string;
    configuration: Record<string, unknown>;
    outputs: Record<string, unknown>;
    supervisor_status?: string;
    supervisor_details?: Record<string, unknown>;
    parent_initiative_id?: string;
    created_at: string;
    updated_at: string;
    project?: { id: string; name: string; path: string };
}

// Workflow Template Types
export type TemplateLevel = 'dashboard' | 'project' | 'task';

export interface WorkflowTemplate {
    id: string;
    name: string;
    description: string;
    level: TemplateLevel;
    workflow_type: string;
    stages: WorkflowStage[];
    default_configuration: Record<string, unknown>;
    is_system: boolean;
    created_at: string;
    updated_at: string;
}

// ─────────────────────────────────────────────────────────────────
// DASHBOARD INITIATIVES API
// ─────────────────────────────────────────────────────────────────

const INITIATIVES_API = process.env.NEXT_PUBLIC_API_URL
    ? `${process.env.NEXT_PUBLIC_API_URL}/api/initiatives`
    : '/api/initiatives';

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

// ─────────────────────────────────────────────────────────────────
// PROJECT WORKFLOWS API
// ─────────────────────────────────────────────────────────────────

/**
 * Get all workflows for a project
 */
export async function getProjectWorkflows(projectId: string, status?: ProjectWorkflowStatus): Promise<{ workflows: ProjectWorkflow[] }> {
    const params = status ? `?status=${status}` : '';
    const res = await authFetch(`${API_URL}/${projectId}/workflows${params}`);
    if (!res.ok) {
        throw new Error('Failed to fetch project workflows');
    }
    return res.json();
}

/**
 * Get a single project workflow
 */
export async function getProjectWorkflow(projectId: string, workflowId: string): Promise<{ workflow: ProjectWorkflow }> {
    const res = await authFetch(`${API_URL}/${projectId}/workflows/${workflowId}`);
    if (!res.ok) {
        throw new Error('Failed to fetch workflow');
    }
    return res.json();
}

/**
 * Create a new project workflow
 */
export async function createProjectWorkflow(
    projectId: string,
    data: {
        name: string;
        description?: string;
        workflow_type: ProjectWorkflowType;
        template_id?: string;
        configuration?: Record<string, unknown>;
        parent_initiative_id?: string;
    }
): Promise<{ success: boolean; workflow: ProjectWorkflow }> {
    const res = await authFetch(`${API_URL}/${projectId}/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to create workflow');
    }
    return res.json();
}

/**
 * Update a project workflow
 */
export async function updateProjectWorkflow(
    projectId: string,
    workflowId: string,
    updates: Partial<Pick<ProjectWorkflow, 'name' | 'description' | 'status' | 'current_stage' | 'stages' | 'configuration' | 'outputs'>>
): Promise<{ success: boolean; workflow: ProjectWorkflow }> {
    const res = await authFetch(`${API_URL}/${projectId}/workflows/${workflowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
    });
    if (!res.ok) {
        throw new Error('Failed to update workflow');
    }
    return res.json();
}

/**
 * Delete a project workflow
 */
export async function deleteProjectWorkflow(projectId: string, workflowId: string): Promise<{ success: boolean; message: string }> {
    const res = await authFetch(`${API_URL}/${projectId}/workflows/${workflowId}`, {
        method: 'DELETE'
    });
    if (!res.ok) {
        throw new Error('Failed to delete workflow');
    }
    return res.json();
}

/**
 * Run a project workflow
 */
export async function runProjectWorkflow(projectId: string, workflowId: string, context?: string): Promise<{
    success: boolean;
    message: string;
    workflow: ProjectWorkflow;
    tasksCreated: number;
}> {
    const res = await authFetch(`${API_URL}/${projectId}/workflows/${workflowId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context })
    });
    if (!res.ok) {
        throw new Error('Failed to run workflow');
    }
    return res.json();
}

/**
 * Workflow progress response
 */
export interface WorkflowProgressResponse {
    workflow: ProjectWorkflow;
    progress: {
        stagesCompleted: number;
        totalStages: number;
        percentComplete: number;
        currentStage: string | null;
        stageCompletion: {
            complete: boolean;
            tasks: Array<{ id: string; title: string; status: string }>;
            summary: {
                total: number;
                complete: number;
                inProgress: number;
            };
        } | null;
    };
    supervisorStatus: string | null;
    supervisorDetails: Record<string, unknown> | null;
}

/**
 * Get workflow progress
 */
export async function getWorkflowProgress(projectId: string, workflowId: string): Promise<WorkflowProgressResponse> {
    const res = await authFetch(`${API_URL}/${projectId}/workflows/${workflowId}/progress`);
    if (!res.ok) {
        throw new Error('Failed to get workflow progress');
    }
    return res.json();
}

/**
 * Advance workflow to next stage (human-triggered)
 */
export async function advanceWorkflow(projectId: string, workflowId: string): Promise<{
    success: boolean;
    message: string;
    workflow: ProjectWorkflow;
    workflowComplete: boolean;
    tasksCreated: number;
}> {
    const res = await authFetch(`${API_URL}/${projectId}/workflows/${workflowId}/advance`, {
        method: 'POST'
    });
    if (!res.ok) {
        throw new Error('Failed to advance workflow');
    }
    return res.json();
}

/**
 * Check workflow stage completion
 */
export async function checkWorkflowStage(projectId: string, workflowId: string): Promise<{
    success: boolean;
    stageComplete: boolean;
    stageName: string;
    readyToAdvance?: boolean;
    tasks: Array<{ id: string; title: string; status: string }>;
    summary: {
        total: number;
        complete: number;
        inProgress: number;
    };
}> {
    const res = await authFetch(`${API_URL}/${projectId}/workflows/${workflowId}/check`, {
        method: 'POST'
    });
    if (!res.ok) {
        throw new Error('Failed to check workflow stage');
    }
    return res.json();
}

// ─────────────────────────────────────────────────────────────────
// WORKFLOW TEMPLATES API - DEPRECATED
// ─────────────────────────────────────────────────────────────────
// REMOVED: getMultiLevelWorkflowTemplates, getWorkflowTemplate,
// createWorkflowTemplate, updateWorkflowTemplate, deleteWorkflowTemplate
//
// These functions used the Node.js /api/workflow-templates endpoint.
// All workflow template operations now use getWorkflowTemplates()
// which calls the Python /api/langgraph/templates endpoint -
// the SINGLE SOURCE OF TRUTH.
//
// The Python endpoint reads from workflow_templates.default_configuration
// which contains the correct visual layout (nodes, edges, positions).

