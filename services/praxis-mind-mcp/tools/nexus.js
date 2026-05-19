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

function register(server, ctx) {
  server.tool(
    'nexus_projects_list',
    'List all projects in The Nexus. Returns id, name, path, type, status for each. USE FIRST when you need a project_id for nexus_task_create.',
    {},
    async () => {
      const auth = checkPrivilege(ctx.caller, 'nexus.projects_list');
      if (auth) return auth;
      const started = Date.now();
      try {
        const data = await backends.nexusProjects();
        const trimmed = (Array.isArray(data) ? data : []).map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
          type: p.type,
          status: p.status,
          description: p.description,
        }));
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_projects_list', success: true, latency_ms: Date.now() - started });
        return { content: [{ type: 'text', text: JSON.stringify(trimmed, null, 2) }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_projects_list', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `nexus_projects_list failed: ${e.message}` }], isError: true };
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
      dependencies: z.array(z.string()).default([]).describe('Task IDs that must complete first.'),
    },
    async ({ project_id, title, description, priority, antigravity_payload, dependencies }) => {
      const auth = checkPrivilege(ctx.caller, 'nexus.task_create');
      if (auth) return auth;
      const rl = checkAndIncrement(ctx.caller.identity, 'nexus_task_create', ctx.caller.rate_limits_per_hour?.['nexus.task_create']);
      if (!rl.allowed) {
        return { content: [{ type: 'text', text: `Rate limit exceeded for nexus_task_create: ${rl.count}/${rl.limit} this hour.` }], isError: true };
      }
      const started = Date.now();
      try {
        const data = await backends.nexusTaskCreate({
          project_id,
          name: title,
          description,
          priority,
          antigravity_payload,
          dependencies,
          source: `coding-agents-${ctx.caller.identity}`,
        });
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_task_create', success: true, latency_ms: Date.now() - started });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_task_create', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `nexus_task_create failed: ${e.message}` }], isError: true };
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
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'nexus_task_status', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `nexus_task_status failed: ${e.message}` }], isError: true };
      }
    },
  );
}

module.exports = { register };
