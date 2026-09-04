import { API_URL, authFetch } from './shared';

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

