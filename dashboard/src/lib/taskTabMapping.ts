/**
 * Maps task workflow status to the appropriate tab to display
 * Based on the workflow: Idea -> Research -> Plan -> Implement -> Complete
 * 
 * This provides a single source of truth for determining which tab to show
 * when opening a task based on its current status.
 */

import { TaskStatus } from './nexus';

export type TaskTab = 'overview' | 'spec' | 'research' | 'plan' | 'walkthrough';

/**
 * Maps each task status to the appropriate tab to display.
 * 
 * Logic:
 * - idea: Show overview (task hasn't started workflow yet)
 * - researching: Show research tab (in progress)
 * - researched: Show research tab (awaiting approval)
 * - planning: Show plan tab (in progress)
 * - planned: Show plan tab (awaiting approval)
 * - implementing: Show walkthrough tab (in progress)
 * - testing: Show walkthrough tab (awaiting approval)
 * - complete: Show walkthrough tab (final state of the workflow)
 * - rejected/cancelled: Show overview (workflow ended early)
 */
const STATUS_TO_TAB_MAP: Record<TaskStatus, TaskTab> = {
    idea: 'overview',
    researching: 'research',
    researched: 'research',
    planning: 'plan',
    planned: 'plan',
    awaiting_approval: 'overview',  // Generic approval state
    implementing: 'walkthrough',
    testing: 'walkthrough',
    complete: 'walkthrough',
    rejected: 'overview',
    cancelled: 'overview',
};

/**
 * Returns the appropriate tab to display based on task status
 * @param status - The current status of the task
 * @returns The tab identifier to open
 */
export function getTabForTaskStatus(status: TaskStatus | string): TaskTab {
    const normalizedStatus = status?.toLowerCase() as TaskStatus;
    return STATUS_TO_TAB_MAP[normalizedStatus] ?? 'overview';
}

/**
 * Returns the tab index for array-based tab systems
 * @param status - The current status of the task
 * @returns The numeric index of the tab
 */
export function getTabIndexForTaskStatus(status: TaskStatus | string): number {
    const TAB_ORDER: TaskTab[] = ['overview', 'research', 'plan', 'walkthrough'];
    const tab = getTabForTaskStatus(status);
    return TAB_ORDER.indexOf(tab);
}
