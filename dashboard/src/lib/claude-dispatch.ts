import { Task, getProject } from "./nexus";

/**
 * Build a self-contained dispatch brief for pasting into a Claude Code /
 * claude.ai session. Mirrors the prompt Praxis's claude-code executor sends,
 * including the completion protocol, so a manually-run task flows through the
 * same callback → QA → schedule-advance pipeline as an automated one.
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
    lines.push("When finished, notify Praxis so QA review and the day schedule advance automatically:");
    lines.push("");
    lines.push("```bash");
    lines.push(`curl -X POST http://127.0.0.1:54322/callback \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(
        `  -d '{"taskId": "${task.id}", "nexusTaskId": "${task.id}", "nexusProjectId": "${projectId}", ` +
        `"result": "<one-paragraph summary of what you did and how you verified it>", "failed": false}'`,
    );
    lines.push("```");
    lines.push("");
    lines.push('If you could NOT complete the task, send the same request with `"failed": true` and the blocker in `result`.');
    lines.push("");
    lines.push("If Praxis (port 54322) is unreachable, mark the task directly in The Nexus instead:");
    lines.push("");
    lines.push("```bash");
    lines.push(`curl -X PATCH http://localhost:4000/api/tasks/${task.id} \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '{"status": "completed", "status_message": "Completed manually via Claude dispatch"}'`);
    lines.push("```");
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
