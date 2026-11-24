import { Task, getProject } from "./nexus";

/**
 * Build a self-contained dispatch brief for pasting into a Claude Code /
 * claude.ai session. Copying a brief does not register a Praxis execution.
 *
 * This is the manual fallback for when automated dispatch isn't possible —
 * e.g. the executor subscriptions are usage-limited and Robert wants to run
 * the task in a chat session he's already paying for.
 */
export function buildClaudeDispatchBrief(
    task: Task,
    projectId: string,
    workspace: string | null,
): string {
    const lines: string[] = [];
    lines.push(`# Nexus Task ${task.id}: ${task.title}`);
    lines.push("");
    lines.push("## Description");
    lines.push(task.description?.trim() || "(no description — judge scope from the title and spec)");
    lines.push("");
    if (task.spec_output?.trim()) {
        lines.push("## Spec");
        lines.push(task.spec_output.trim());
        lines.push("");
    }
    lines.push("## Workspace");
    lines.push(workspace || "(project path unavailable — ask Robert before editing files)");
    lines.push("");
    lines.push("## Expectations");
    lines.push("- Implement the work directly in the workspace above.");
    lines.push("- You have full local autonomy for filesystem edits, terminal commands, and verification.");
    lines.push("- Verify your changes with the narrowest reliable build, test, or hand-execution command.");
    lines.push("");
    lines.push("## Completion Protocol (required)");
    lines.push(`Return your result and verification evidence for Nexus task ${task.id} in project ${projectId}. Include any failure or partial work.`);
    lines.push("Copying this brief does not start a tracked execution. For work done in this standalone session, give Robert the summary for review and leave the task status to Praxis.");
    lines.push("If you are the executor of a registered Praxis dispatch, finish through that dispatch’s completion protocol. Its runner sends the callback.");
    lines.push("If that callback was lost, tell Praxis the original execution_id and the evidence for that run. Praxis can verify the diff and use antigravity_control with action=complete, task_id, execution_id and result. Report its receipt or refusal reason.");
    return lines.join("\n");
}

/**
 * Copy the dispatch brief for a task to the clipboard. Fetches the project
 * for its workspace path; the brief is still usable if that lookup fails.
 */
export async function copyClaudeDispatch(task: Task, projectId: string): Promise<void> {
    let workspace: string | null = null;
    try {
        workspace = (await getProject(projectId))?.path || null;
    } catch {
        // Brief still works without the path — it tells Claude to ask first.
    }
    await navigator.clipboard.writeText(buildClaudeDispatchBrief(task, projectId, workspace));
}
