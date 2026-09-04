import type { TaskStatus } from './tasks';
import { API_URL, authFetch } from './shared';

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



