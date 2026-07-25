/**
 * nexus.* tools — wrap Nexus's existing HTTP task API (1:1, per Wave 4 design).
 * Lets coding agents formally queue work into Praxis's execution pipeline
 * rather than just writing dead markdown.
 */
const { z } = require('zod');
const { checkPrivilege } = require('../lib/auth');
const { checkAndIncrement } = require('../lib/ratelimit');
const backends = require('../lib/backends');
const ledger = require('../lib/ledger');
const { executeTransaction, compareFields } = require('../lib/transactions');
const { classifySource, formatRetrieved } = require('../lib/provenance');

function withTransactionId(result, transactionId) {
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result, transaction_id: transactionId }
    : { result, transaction_id: transactionId };
}

function transactionFailure(tool, error) {
  const suffix = error.transactionId ? ` (transaction ${error.transactionId})` : '';
  return `${tool} failed${suffix}: ${error.message}`;
}

function register(server, ctx) {
  server.tool(
    'nexus_projects_list',
    'List all projects in The Nexus with their full project card: id, name, path, type, status (active/parked/paused/completed/archived), priority (0=normal, >0 elevated, <0 backburner), upgrade_posture (auto/propose/off — how much autonomous improvement work the project accepts), end_state (the evolving goal, with end_state_updated_at), tags, and open needs (what the project is missing). USE FIRST when you need a project_id, and to understand which projects are eligible for work.',
    {},
    async () => {
      const auth = checkPrivilege(ctx.caller, 'nexus.projects_list');
      if (auth) return auth;
      const started = Date.now();
      try {
        const data = await backends.nexusProjects();
        const trimmed = (Array.isArray(data) ? data : []).map((p) => {
          const needs = Array.isArray(p.needs) ? p.needs : [];
          const openNeeds = needs.filter((n) => n && n.status === 'open');
          return {
            id: p.id,
            name: p.name,
            path: p.path,
            type: p.type,
            status: p.status,
            priority: p.priority ?? 0,
            upgrade_posture: p.upgrade_posture || 'auto',
            description: p.description,
            end_state: p.end_state || null,
            end_state_updated_at: p.end_state_updated_at || null,
            tags: Array.isArray(p.tags) ? p.tags : [],
            open_needs: openNeeds.map((n) => ({ id: n.id, kind: n.kind, description: n.description })),
            end_state_criteria: Array.isArray(p.end_state_criteria)
              ? p.end_state_criteria.map((c) => ({ id: c.id, kind: c.kind, description: c.description, enabled: c.enabled !== false }))
              : [],
          };
        });
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_projects_list', success: true, latency_ms: Date.now() - started });
        return { content: [{ type: 'text', text: JSON.stringify(trimmed, null, 2) }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_projects_list', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `nexus_projects_list failed: ${e.message}` }], isError: true };
      }
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
      // Project data writes ride the same trust tier as task writes: accept
      // the dedicated privilege when provisioned, else fall back to the
      // board-writer privilege existing keys already hold.
      let auth = checkPrivilege(ctx.caller, 'nexus.project_update');
      if (auth) auth = checkPrivilege(ctx.caller, 'nexus.task_update');
      if (auth) return auth;
      const rl = checkAndIncrement(ctx.caller.identity, 'nexus_project_update', ctx.caller.rate_limits_per_hour?.['nexus.project_update']);
      if (!rl.allowed) {
        return { content: [{ type: 'text', text: `Rate limit exceeded for nexus_project_update: ${rl.count}/${rl.limit} this hour.` }], isError: true };
      }

      const patch = {};
      if (status !== undefined) patch.status = status;
      if (priority !== undefined) patch.priority = priority;
      if (description !== undefined) patch.description = description;
      if (upgrade_posture !== undefined) patch.upgrade_posture = upgrade_posture;
      if (end_state !== undefined) {
        patch.end_state = end_state;
        patch.end_state_source = `coding-agents-${ctx.caller.identity}`;
        if (end_state_reason) patch.end_state_reason = end_state_reason;
      }
      if (Object.keys(patch).length === 0 && !add_need && !resolve_need) {
        return { content: [{ type: 'text', text: 'No fields to update. Specify at least one of: status, priority, description, end_state, upgrade_posture, add_need, resolve_need.' }], isError: true };
      }

      const started = Date.now();
      try {
        const expected = {};
        if (expected_status !== undefined) expected.status = expected_status;
        if (expected_end_state_updated_at !== undefined) expected.end_state_updated_at = expected_end_state_updated_at;
        const target = { project_id };
        const tx = await executeTransaction({
          tool: 'nexus_project_update',
          caller: ctx.caller,
          target,
          intent: { patch, add_need, resolve_need, expected },
          captureBefore: () => backends.nexusProjectById(project_id),
          validatePreconditions: ({ before }) => compareFields(before, expected),
          apply: async () => {
            const result = {};
            if (Object.keys(patch).length > 0) {
              const updated = await backends.nexusProjectUpdate(project_id, patch);
              result.project = {
                id: updated.id,
                name: updated.name,
                status: updated.status,
                priority: updated.priority,
                upgrade_posture: updated.upgrade_posture,
                end_state: updated.end_state,
                end_state_updated_at: updated.end_state_updated_at,
              };
            }
            if (add_need) {
              const added = await backends.nexusProjectAddNeed(project_id, {
                ...add_need,
                source: `coding-agents-${ctx.caller.identity}`,
              });
              result.added_need = added.need;
            }
            if (resolve_need) {
              const resolved = await backends.nexusProjectUpdateNeed(project_id, resolve_need.id, {
                status: resolve_need.status,
                notes: resolve_need.notes,
              });
              result.resolved_need = resolved.need;
            }
            return result;
          },
          readAfter: () => backends.nexusProjectById(project_id),
          verify: ({ after, applyResult }) => {
            const intendedPatch = { ...patch };
            delete intendedPatch.end_state_source;
            delete intendedPatch.end_state_reason;
            const mismatches = compareFields(after, intendedPatch);
            if (add_need) {
              const added = (after?.needs || []).find((need) => need.id === applyResult?.added_need?.id);
              if (!added) {
                mismatches.push({ field: 'add_need', expected: applyResult?.added_need?.id, actual: null });
              } else {
                mismatches.push(...compareFields(added, add_need).map((m) => ({ ...m, field: `add_need.${m.field}` })));
              }
            }
            if (resolve_need) {
              const resolved = (after?.needs || []).find((need) => need.id === resolve_need.id);
              const expectedNeed = { status: resolve_need.status };
              if (resolve_need.notes !== undefined) expectedNeed.notes = resolve_need.notes;
              if (!resolved) {
                mismatches.push({ field: 'resolve_need.id', expected: resolve_need.id, actual: null });
              } else {
                mismatches.push(...compareFields(resolved, expectedNeed).map((m) => ({ ...m, field: `resolve_need.${m.field}` })));
              }
            }
            return { ok: mismatches.length === 0, mismatches };
          },
        });
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_project_update', success: true, latency_ms: Date.now() - started });
        return { content: [{ type: 'text', text: JSON.stringify(withTransactionId(tx.result, tx.transactionId), null, 2) }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_project_update', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: transactionFailure('nexus_project_update', e) }], isError: true };
      }
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
      const auth = checkPrivilege(ctx.caller, 'nexus.tasks_read');
      if (auth) return auth;
      const started = Date.now();
      try {
        const data = await backends.nexusTasksByProject(project_id);
        let tasks = data.tasks || data || [];
        if (status) tasks = tasks.filter((t) => t.status === status);
        const trimmed = tasks.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          priority: t.priority,
          has_antigravity_payload: !!t.antigravity_payload,
          dependencies: t.dependencies,
          successor_id: t.successor_id || null,
          updated_at: t.updated_at,
        }));
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_tasks_read', success: true, latency_ms: Date.now() - started });
        return { content: [{ type: 'text', text: JSON.stringify(trimmed, null, 2) }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_tasks_read', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `nexus_tasks_read failed: ${e.message}` }], isError: true };
      }
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
      const auth = checkPrivilege(ctx.caller, 'nexus.task_create');
      if (auth) return auth;
      const rl = checkAndIncrement(ctx.caller.identity, 'nexus_task_create', ctx.caller.rate_limits_per_hour?.['nexus.task_create']);
      if (!rl.allowed) {
        return { content: [{ type: 'text', text: `Rate limit exceeded for nexus_task_create: ${rl.count}/${rl.limit} this hour.` }], isError: true };
      }
      const started = Date.now();
      try {
        const target = { project_id };
        const createIntent = {
          project_id,
          title,
          description,
          priority,
          antigravity_payload,
          dependencies,
          successor_id,
        };
        const tx = await executeTransaction({
          tool: 'nexus_task_create',
          caller: ctx.caller,
          target,
          intent: createIntent,
          captureBefore: async () => null,
          apply: () => backends.nexusTaskCreate({
            project_id,
            name: title,
            description,
            priority,
            antigravity_payload,
            dependencies,
            successor_id,
            source: `coding-agents-${ctx.caller.identity}`,
          }),
          readAfter: async ({ applyResult }) => {
            const taskId = applyResult?.tasks?.[0]?.id;
            if (!taskId) throw new Error('Create response did not include a task id.');
            target.task_id = taskId;
            return backends.nexusTaskById(taskId);
          },
          verify: ({ after }) => {
            const expectedTask = {
              project_id,
              name: title,
              description,
              priority,
              dependencies,
              successor_id: successor_id || null,
            };
            if (antigravity_payload !== undefined) expectedTask.antigravity_payload = antigravity_payload;
            const mismatches = compareFields(after, expectedTask);
            return { ok: mismatches.length === 0, mismatches };
          },
        });
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_task_create', success: true, latency_ms: Date.now() - started });
        return { content: [{ type: 'text', text: JSON.stringify(withTransactionId(tx.result, tx.transactionId), null, 2) }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_task_create', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: transactionFailure('nexus_task_create', e) }], isError: true };
      }
    },
  );

  server.tool(
    'nexus_task_update',
    'Update an existing Nexus task by id. Supply only the fields you want to change. USE FOR: changing status (e.g. retiring/cancelling a task), repointing dependencies, adjusting priority, editing the human description, or backfilling/replacing the machine antigravity_payload (the "instructions" layer). Does NOT create tasks — use nexus_task_create for that.',
    {
      task_id: z.string().describe('Task UUID (from nexus_tasks_read / nexus_task_status).'),
      expected_status: z.string().optional()
        .describe('Optimistic concurrency guard: reject unless the current task status exactly matches.'),
      expected_updated_at: z.string().optional()
        .describe('Optimistic concurrency guard: reject unless the current task updated_at exactly matches.'),
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
    async ({ task_id, status, priority, description, dependencies, successor_id, antigravity_payload, expected_status, expected_updated_at }) => {
      const auth = checkPrivilege(ctx.caller, 'nexus.task_update');
      if (auth) return auth;
      const rl = checkAndIncrement(ctx.caller.identity, 'nexus_task_update', ctx.caller.rate_limits_per_hour?.['nexus.task_update']);
      if (!rl.allowed) {
        return { content: [{ type: 'text', text: `Rate limit exceeded for nexus_task_update: ${rl.count}/${rl.limit} this hour.` }], isError: true };
      }
      const patch = {};
      if (status !== undefined) patch.status = status;
      if (priority !== undefined) patch.priority = priority;
      if (description !== undefined) patch.description = description;
      if (dependencies !== undefined) patch.dependencies = dependencies;
      if (successor_id !== undefined) patch.successor_id = successor_id || null;
      if (antigravity_payload !== undefined) patch.antigravity_payload = antigravity_payload;
      if (Object.keys(patch).length === 0) {
        return { content: [{ type: 'text', text: 'No fields to update. Specify at least one of: status, priority, description, dependencies, successor_id, antigravity_payload.' }], isError: true };
      }
      const started = Date.now();
      try {
        const expected = {};
        if (expected_status !== undefined) expected.status = expected_status;
        if (expected_updated_at !== undefined) expected.updated_at = expected_updated_at;
        const tx = await executeTransaction({
          tool: 'nexus_task_update',
          caller: ctx.caller,
          target: { task_id },
          intent: { patch, expected },
          captureBefore: () => backends.nexusTaskById(task_id),
          validatePreconditions: ({ before }) => compareFields(before, expected),
          apply: () => backends.nexusTaskUpdate(task_id, patch),
          readAfter: () => backends.nexusTaskById(task_id),
          verify: ({ after }) => {
            const mismatches = compareFields(after, patch);
            return { ok: mismatches.length === 0, mismatches };
          },
        });
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_task_update', success: true, latency_ms: Date.now() - started });
        return { content: [{ type: 'text', text: JSON.stringify(withTransactionId(tx.result, tx.transactionId), null, 2) }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_task_update', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: transactionFailure('nexus_task_update', e) }], isError: true };
      }
    },
  );

  server.tool(
    'nexus_task_status',
    'Read full status of one task by id (all phase outputs, supervisor status, antigravity_payload).',
    { task_id: z.string().describe('Task UUID.') },
    async ({ task_id }) => {
      const auth = checkPrivilege(ctx.caller, 'nexus.task_status');
      if (auth) return auth;
      const started = Date.now();
      try {
        const data = await backends.nexusTaskById(task_id);
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_task_status', success: true, latency_ms: Date.now() - started });
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
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_task_status', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `nexus_task_status failed: ${e.message}` }], isError: true };
      }
    },
  );
}

module.exports = { register };
