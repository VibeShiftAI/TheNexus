/**
 * nexus.* tools — wrap Nexus's existing HTTP task API (1:1, per Wave 4 design).
 * Lets coding agents formally queue work into Praxis's execution pipeline
 * rather than just writing dead markdown.
 *
 * This file owns tool names, descriptions, schemas and response formatting
 * only. The governed implementation (privilege gate, hourly rate limit,
 * transaction envelope over the Nexus HTTP API, cost ledger, optimistic-lock
 * retry + lock-health gauge) lives in ../lib/board-ops.js and is shared with
 * the (since retired, M-1) server/mcp.js, so there is exactly one write path
 * onto the board (P1-15).
 */
const { z } = require('zod');
const boardOps = require('../lib/board-ops');
const { classifySource, formatRetrieved } = require('../lib/provenance');

const { withTransactionId } = boardOps;

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function register(server, ctx) {
  server.tool(
    'nexus_projects_list',
    'List all projects in The Nexus with their full project card: id, name, path, type, status (active/parked/paused/completed/archived), priority (0=normal, >0 elevated, <0 backburner), upgrade_posture (auto/propose/off — how much autonomous improvement work the project accepts), end_state (the evolving goal, with end_state_updated_at), tags, and open needs (what the project is missing). USE FIRST when you need a project_id, and to understand which projects are eligible for work.',
    {},
    async () => {
      const r = await boardOps.listProjects(ctx, { tool: 'nexus_projects_list' });
      return r.ok ? text(r.value) : r.result;
    },
  );

  server.tool(
    'nexus_project_update',
    'Update project-level data in The Nexus. USE FOR: setting status (parked = dormant, excluded from all autonomous work; active = full participation), priority (0=normal, >0 elevated, <0 backburner), upgrade_posture (auto = system may file+schedule improvement tasks; propose = file but never auto-schedule; off = no autonomous filings), evolving the end_state (every change is versioned into end_state_history — pass end_state_reason to say why the goal moved), editing the description, and maintaining the needs registry (add_need to declare something the project is missing; resolve_need to mark it met/dropped). Does NOT touch tasks — use nexus_task_update for those.',
    {
      project_id: z.string().describe('Project UUID (from nexus_projects_list).'),
      status: z.enum(['active', 'parked', 'paused', 'completed', 'archived']).optional()
        .describe('Lifecycle status. "parked" keeps all data but removes the project from scheduling, goal regression, tagging, and council filings.'),
      priority: z.number().int().min(-100).max(100).optional()
        .describe('Attention priority: 0 normal (default), higher = more council/scheduling attention, negative = backburner.'),
      description: z.string().optional().describe('Replacement project description.'),
      end_state: z.string().optional()
        .describe('New/evolved end state (the goal the system works toward). Every change is appended to end_state_history automatically.'),
      end_state_reason: z.string().optional()
        .describe('Why the end state changed (e.g. "previous horizon reached", "scope pivot"). Stored on the revision.'),
      upgrade_posture: z.enum(['auto', 'propose', 'off']).optional()
        .describe('How much autonomous improvement work this project accepts.'),
      expected_status: z.enum(['active', 'parked', 'paused', 'completed', 'archived']).optional()
        .describe('Optimistic concurrency guard: reject unless the current project status exactly matches.'),
      expected_end_state_updated_at: z.string().optional()
        .describe('Optimistic concurrency guard: reject unless the current end-state revision timestamp exactly matches.'),
      add_need: z.object({
        kind: z.enum(['capability', 'resource', 'credential', 'decision', 'information'])
          .describe('capability = missing component/ability, resource = compute/money/hardware, credential = key/account Robert must provision, decision = human call needed, information = knowledge to hunt first.'),
        description: z.string().describe('What is missing, concretely.'),
        notes: z.string().optional(),
      }).optional().describe('Declare one thing the project is missing on the way to its end state.'),
      resolve_need: z.object({
        id: z.string().describe('Need id (from nexus_projects_list open_needs).'),
        status: z.enum(['met', 'dropped', 'open']).describe('met = satisfied, dropped = no longer relevant, open = reopen.'),
        notes: z.string().optional().describe('How it was met / why dropped.'),
      }).optional().describe('Close out (or reopen) one existing need.'),
    },
    async ({ project_id, status, priority, description, end_state, end_state_reason, upgrade_posture, add_need, resolve_need, expected_status, expected_end_state_updated_at }) => {
      const expected = {};
      if (expected_status !== undefined) expected.status = expected_status;
      if (expected_end_state_updated_at !== undefined) expected.end_state_updated_at = expected_end_state_updated_at;
      const r = await boardOps.updateProject(ctx, {
        tool: 'nexus_project_update',
        project_id,
        patch: { status, priority, description, upgrade_posture, end_state },
        end_state_reason,
        add_need,
        resolve_need,
        expected,
      });
      if (!r.ok) return r.result;
      return text(withTransactionId(r.value.result, r.value.transactionId));
    },
  );

  server.tool(
    'nexus_tasks_read',
    'List tasks for a project. Returns name, status, priority, antigravity_payload presence, dependencies for each.',
    {
      project_id: z.string().describe('Project UUID (from nexus_projects_list).'),
      status: z.string().optional().describe('Optional status filter (idea, planning, todo, in-progress, completed, etc.)'),
    },
    async ({ project_id, status }) => {
      const r = await boardOps.listTasks(ctx, { tool: 'nexus_tasks_read', project_id, status });
      return r.ok ? text(r.value) : r.result;
    },
  );

  server.tool(
    'nexus_task_create',
    'Create a task in The Nexus (becomes executable work for Praxis + Antigravity). USE THIS to queue real work rather than just writing markdown notes. The antigravity_payload makes the task machine-executable.',
    {
      project_id: z.string().describe('Project UUID.'),
      title: z.string().describe('Short human-readable task title.'),
      description: z.string().default('').describe('Longer description / context.'),
      priority: z.number().int().min(0).max(2).default(1).describe('0=low, 1=normal, 2=high'),
      antigravity_payload: z
        .object({
          prompt: z.string().describe('Exact prompt Antigravity will receive.'),
          workspace: z.string().optional().describe('Target workspace path.'),
          target_files: z.array(z.string()).optional(),
          context_files: z.array(z.string()).optional(),
          commands: z.array(z.string()).optional(),
          acceptance_criteria: z.array(z.string()).optional(),
        })
        .optional()
        .describe('Optional machine-execution payload. Include when the task is ready for Antigravity to run.'),
      dependencies: z.array(z.string()).default([]).describe('Predecessor task IDs — ALL must be completed before this task may start.'),
      successor_id: z.string().optional().describe('The single task to auto-start immediately after this task completes. Chain tasks with this; there is only ever one successor per task.'),
    },
    async ({ project_id, title, description, priority, antigravity_payload, dependencies, successor_id }) => {
      const r = await boardOps.createTasks(ctx, {
        tool: 'nexus_task_create',
        project_id,
        tasks: [{ name: title, description, priority, antigravity_payload, dependencies, successor_id }],
      });
      if (!r.ok) return r.result;
      return text(withTransactionId(r.value.result, r.value.transactionId));
    },
  );

  server.tool(
    'nexus_task_update',
    'Update an existing Nexus task by id. Supply only the fields you want to change. USE FOR: changing status (e.g. retiring/cancelling a task), repointing dependencies, adjusting priority, editing the human description, or backfilling/replacing the machine antigravity_payload (the "instructions" layer). Does NOT create tasks — use nexus_task_create for that. Concurrency: the write runs under a bounded optimistic-lock retry, so an unrelated writer bumping the row between your read and your write no longer fails the call; expected_status is still a hard guard that is never retried past. The response carries lock_health, a contention gauge for this tool.',
    {
      task_id: z.string().describe('Task UUID (from nexus_tasks_read / nexus_task_status).'),
      expected_status: z.string().optional()
        .describe('Optimistic concurrency guard: reject unless the current task status exactly matches. Never auto-refreshed — a mismatch always fails, because it means the premise of your update is gone.'),
      expected_updated_at: z.string().optional()
        .describe('Optimistic concurrency freshness guard: the update is rejected if the row moved, then re-anchored to the current row and retried (bounded). Set on_conflict="fail" for the strict compare-and-set behaviour.'),
      on_conflict: z.enum(['retry', 'fail']).optional()
        .describe('retry (default): re-anchor a timestamp-only conflict and retry, and treat "another writer already applied this exact patch" as success. fail: reject on any guard mismatch, no retry.'),
      status: z.string().optional().describe('New status, e.g. "todo", "in-progress", "completed", "blocked", "cancelled".'),
      priority: z.number().int().min(0).max(2).optional().describe('0=low, 1=normal, 2=high.'),
      description: z.string().optional().describe('Replacement description / context.'),
      dependencies: z.array(z.string()).optional().describe('Replacement list of predecessor task IDs (all must complete before this task starts). Replaces the existing list entirely.'),
      successor_id: z.string().nullable().optional().describe('The single task to auto-start when this task completes. Pass null (or empty string) to clear.'),
      antigravity_payload: z
        .object({
          prompt: z.string().describe('Use case / intended outcome + areas of the project impacted, as intent (not prescriptive code steps).'),
          workspace: z.string().optional(),
          target_files: z.array(z.string()).optional(),
          context_files: z.array(z.string()).optional(),
          commands: z.array(z.string()).optional(),
          acceptance_criteria: z.array(z.string()).optional(),
        })
        .nullable()
        .optional()
        .describe('Replacement machine-execution payload (the "instructions" layer). Replaces the existing payload entirely; pass null to clear it.'),
    },
    async ({ task_id, status, priority, description, dependencies, successor_id, antigravity_payload, expected_status, expected_updated_at, on_conflict }) => {
      const expected = {};
      if (expected_status !== undefined) expected.status = expected_status;
      if (expected_updated_at !== undefined) expected.updated_at = expected_updated_at;
      const r = await boardOps.updateTask(ctx, {
        tool: 'nexus_task_update',
        task_id,
        patch: {
          status,
          priority,
          description,
          dependencies,
          successor_id: successor_id !== undefined ? (successor_id || null) : undefined,
          antigravity_payload,
        },
        expected,
        on_conflict,
      });
      return r.ok ? text(r.value.envelope) : r.result;
    },
  );

  server.tool(
    'nexus_task_status',
    'Read full status of one task by id (all phase outputs, supervisor status, antigravity_payload).',
    { task_id: z.string().describe('Task UUID.') },
    async ({ task_id }) => {
      const r = await boardOps.getTask(ctx, { tool: 'nexus_task_status', task_id });
      if (!r.ok) return r.result;
      const data = r.value;
      // antigravity_payload is the machine-executable instruction layer. Its
      // authority is whatever the task's recorded provenance says — an
      // agent-filed payload does not become an operator directive by being read.
      return {
        content: [{
          type: 'text',
          text: formatRetrieved(
            { origin: `nexus:task:${task_id}`, tier: classifySource(data?.source) },
            JSON.stringify(data, null, 2),
          ),
        }],
      };
    },
  );
}

module.exports = { register };
