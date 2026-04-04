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
 * - idea/todo: Show overview (task hasn't started planning yet)
 * - planning: Show plan tab (in progress or pending approval)
 * - building: Show walkthrough tab (in progress)
 * - testing/ready_for_review: Show walkthrough tab (awaiting approval)
 * - complete: Show walkthrough tab (final state of the workflow)
 * - rejected/cancelled: Show overview (workflow ended early)
 */
const STATUS_TO_TAB_MAP: Record<string, TaskTab> = {
    idea: 'overview',
    todo: 'overview',
    planning: 'plan',
    building: 'walkthrough',
    testing: 'walkthrough',
    ready_for_review: 'walkthrough',
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
