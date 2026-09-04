/**
 * Governed board operations — the ONE write path onto The Nexus board that
 * both MCP surfaces share (ticket P1-15):
 *
 *   services/praxis-mind-mcp/tools/nexus.js   praxis-mind (stdio, live clients)
 *   server/mcp.js                              "Local Nexus" (retired 2026-09-04, M-1)
 *
 * Before this module each surface carried its own implementation: praxis-mind
 * went through the Nexus HTTP API behind a privilege gate, an hourly rate
 * limit, the transaction envelope (transition log) and the cost ledger, while
 * server/mcp.js wrote straight into sqlite with none of that. Now every op
 * here is the sequence
 *
 *   privilege gate -> per-identity hourly rate limit -> transaction envelope
 *   over the Nexus HTTP API (capture / apply / read-back / verify, transition
 *   log) -> cost ledger
 *
 * and task updates add the bounded optimistic-lock retry plus the lock-health
 * gauge. The surfaces own only their tool names, schemas and response
 * formatting, which is why nothing here builds a success result — ops return
 *
 *   { ok: true,  value, ... }          the surface formats `value`
 *   { ok: false, result, error? }      `result` is a ready MCP error result
 *
 * Naming: the ledger records the tool name the client actually called
 * (attribution per surface); the rate-limit counter, the transition log and
 * the lock gauge are keyed by the canonical operation (OPS.*) so both surfaces
 * draw on one quota, one audit vocabulary (transition-log compensation keys on
 * it) and one contention gauge.
 *
 * Identity is whatever `ctx.caller` the surface resolved for this process —
 * never read from the environment here (MG-1).
 */
const { checkPrivilege } = require('./auth');
const { guardDispatchPayload } = require('../../../server/lib/provenance');
const { checkAndIncrement } = require('./ratelimit');
const backends = require('./backends');
const ledger = require('./ledger');
const { executeTransaction, executeOptimisticTransaction, compareFields } = require('./transactions');
const lockHealth = require('./lock-health');

/** Canonical operation names (rate-limit counter, transition log, lock gauge). */
const OPS = Object.freeze({
  PROJECTS_LIST: 'nexus_projects_list',
  PROJECT_UPDATE: 'nexus_project_update',
  TASKS_READ: 'nexus_tasks_read',
  TASK_CREATE: 'nexus_task_create',
  TASK_UPDATE: 'nexus_task_update',
  TASK_STATUS: 'nexus_task_status',
  BOARD_STATE: 'nexus_board_state',
});

/** Privilege gates per operation. `fallback` is checked when the first fails. */
const GATES = Object.freeze({
  [OPS.PROJECTS_LIST]: { privilege: 'nexus.projects_list' },
  // Project data writes ride the same trust tier as task writes: accept the
  // dedicated privilege when provisioned, else the board-writer privilege
  // existing keys already hold (the refusal names the fallback).
  [OPS.PROJECT_UPDATE]: { privilege: 'nexus.project_update', fallback: 'nexus.task_update', limitKey: 'nexus.project_update' },
  [OPS.TASKS_READ]: { privilege: 'nexus.tasks_read' },
  [OPS.TASK_CREATE]: { privilege: 'nexus.task_create', limitKey: 'nexus.task_create' },
  [OPS.TASK_UPDATE]: { privilege: 'nexus.task_update', limitKey: 'nexus.task_update' },
  [OPS.TASK_STATUS]: { privilege: 'nexus.task_status' },
  // Board state is projects + their tasks in one read: both read grants apply.
  [OPS.BOARD_STATE]: { privileges: ['nexus.projects_list', 'nexus.tasks_read'] },
});

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function withTransactionId(result, transactionId) {
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result, transaction_id: transactionId }
    : { result, transaction_id: transactionId };
}

function transactionFailure(tool, error) {
  const suffix = error.transactionId ? ` (transaction ${error.transactionId})` : '';
  return `${tool} failed${suffix}: ${error.message}`;
}

function sourceFor(caller) {
  return `coding-agents-${caller.identity}`;
}

function authorize(caller, gate) {
  if (gate.privileges) {
    for (const privilege of gate.privileges) {
      const refusal = checkPrivilege(caller, privilege);
      if (refusal) return refusal;
    }
    return null;
  }
  let refusal = checkPrivilege(caller, gate.privilege);
  if (refusal && gate.fallback) refusal = checkPrivilege(caller, gate.fallback);
  return refusal;
}

/**
 * Gate, throttle, time and ledger one operation. `run` produces the value;
 * a throw is recorded as a ledger failure and turned into an error result
 * (`formatError` may replace the default text, e.g. to append the lock gauge).
 */
async function govern(ctx, { tool, op, formatError }, run) {
  const caller = ctx ? ctx.caller : null;
  const gate = GATES[op];
  const refusal = authorize(caller, gate);
  if (refusal) return { ok: false, refused: 'privilege', result: refusal };

  if (gate.limitKey) {
    const rl = checkAndIncrement(caller.identity, op, caller.rate_limits_per_hour?.[gate.limitKey]);
    if (!rl.allowed) {
      return {
        ok: false,
        refused: 'rate_limit',
        result: errorResult(`Rate limit exceeded for ${op}: ${rl.count}/${rl.limit} this hour.`),
      };
    }
  }

  const started = Date.now();
  try {
    const value = await run();
    if (value && value.__refusal) {
      // Input-level refusal decided after the gates (e.g. empty patch): no
      // backend was touched, so it is not a ledger failure.
      return { ok: false, refused: 'input', result: errorResult(value.__refusal) };
    }
    ledger.record({ caller: caller.identity, tool, success: true, latency_ms: Date.now() - started });
    return { ok: true, value };
  } catch (error) {
    ledger.record({ caller: caller.identity, tool, success: false, latency_ms: Date.now() - started, error: error.message });
    const text = formatError ? formatError(error) : transactionFailure(tool, error);
    return { ok: false, error, result: errorResult(text) };
  }
}

// ─────────────────────────── reads ───────────────────────────

/** Trimmed project cards (the praxis-mind nexus_projects_list shape). */
async function listProjects(ctx, { tool = OPS.PROJECTS_LIST } = {}) {
  return govern(ctx, { tool, op: OPS.PROJECTS_LIST }, async () => {
    const data = await backends.nexusProjects();
    return (Array.isArray(data) ? data : []).map((p) => {
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
  });
}

/**
 * Projects with their tasks (GET /api/board-state). The route already gates
 * external-tier dispatch payloads on the way out (server/lib/provenance.js).
 */
async function boardState(ctx, { tool = OPS.BOARD_STATE, project_id } = {}) {
  return govern(ctx, { tool, op: OPS.BOARD_STATE }, async () => {
    const data = await backends.nexusBoardState(project_id || undefined);
    if (!Array.isArray(data)) return [];
    // Defense in depth: the HTTP route already withholds external-tier
    // commands, but this governed op must not depend on which backend served
    // it. guardDispatchPayload is idempotent, so double application is safe.
    return data.map((project) => ({
      ...project,
      tasks: (project && Array.isArray(project.tasks) ? project.tasks : []).map((t) =>
        t && t.antigravity_payload ? { ...t, antigravity_payload: guardDispatchPayload(t) } : t,
      ),
    }));
  });
}

/** Trimmed task rows for one project, optionally filtered by status. */
async function listTasks(ctx, { tool = OPS.TASKS_READ, project_id, status } = {}) {
  return govern(ctx, { tool, op: OPS.TASKS_READ }, async () => {
    const data = await backends.nexusTasksByProject(project_id);
    let tasks = data.tasks || data || [];
    if (status) tasks = tasks.filter((t) => t.status === status);
    return tasks.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      priority: t.priority,
      has_antigravity_payload: !!t.antigravity_payload,
      dependencies: t.dependencies,
      successor_id: t.successor_id || null,
      updated_at: t.updated_at,
    }));
  });
}

/** One task, untrimmed — the surface decides how to label its payload. */
async function getTask(ctx, { tool = OPS.TASK_STATUS, task_id } = {}) {
  return govern(ctx, { tool, op: OPS.TASK_STATUS }, () => backends.nexusTaskById(task_id));
}

// ─────────────────────────── writes ───────────────────────────

/**
 * PATCH one project (+ optional need add/resolve) under the transaction
 * envelope. `patch` holds only the fields to change; `expected` is the
 * optimistic-concurrency guard. Returns the committed transaction.
 */
async function updateProject(ctx, {
  tool = OPS.PROJECT_UPDATE,
  project_id,
  patch: requested = {},
  end_state_reason,
  add_need,
  resolve_need,
  expected = {},
  fields = ['status', 'priority', 'description', 'end_state', 'upgrade_posture', 'add_need', 'resolve_need'],
}) {
  return govern(ctx, { tool, op: OPS.PROJECT_UPDATE }, async () => {
    const caller = ctx.caller;
    const patch = {};
    for (const [key, value] of Object.entries(requested)) {
      if (value !== undefined) patch[key] = value;
    }
    if (patch.end_state !== undefined) {
      patch.end_state_source = sourceFor(caller);
      if (end_state_reason) patch.end_state_reason = end_state_reason;
    }
    if (Object.keys(patch).length === 0 && !add_need && !resolve_need) {
      return { __refusal: `No fields to update. Specify at least one of: ${fields.join(', ')}.` };
    }

    const target = { project_id };
    return executeTransaction({
      tool: OPS.PROJECT_UPDATE,
      caller,
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
          const added = await backends.nexusProjectAddNeed(project_id, { ...add_need, source: sourceFor(caller) });
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
  });
}

const TASK_FIELDS = ['name', 'description', 'status', 'priority', 'antigravity_payload', 'dependencies', 'successor_id', 'stable_id'];

function normalizeTask(task) {
  const out = {};
  for (const key of TASK_FIELDS) {
    if (task[key] !== undefined) out[key] = task[key];
  }
  if (out.name === undefined && task.title !== undefined) out.name = task.title;
  return out;
}

/** Fields a created task must read back with (undefined = not asserted). */
function expectedCreated(task, project_id) {
  const expected = { project_id, name: task.name };
  if (task.description !== undefined) expected.description = task.description;
  if (task.priority !== undefined) expected.priority = task.priority;
  if (task.dependencies !== undefined) expected.dependencies = task.dependencies;
  if (task.successor_id !== undefined) expected.successor_id = task.successor_id || null;
  if (task.antigravity_payload !== undefined) expected.antigravity_payload = task.antigravity_payload;
  return expected;
}

/**
 * Create tasks in a project. Both forms POST /api/tasks/batch:
 *
 *  - default (`batch: false`): exactly one task — the praxis-mind
 *    nexus_task_create contract (backends.nexusTaskCreate, single-task
 *    transition record with target.task_id).
 *  - `batch: true`: 1..50 tasks — server/mcp.js's nexus_batch_create_tasks
 *    semantics (backends.nexusTasksBatchCreate; stable_id placeholders
 *    resolved server-side; one atomic insert; one transition-log record
 *    carrying every created id in target.task_ids).
 */
async function createTasks(ctx, { tool = OPS.TASK_CREATE, project_id, tasks: requested, batch = false }) {
  return govern(ctx, { tool, op: OPS.TASK_CREATE }, async () => {
    const caller = ctx.caller;
    const tasks = (requested || []).map(normalizeTask);
    if (tasks.length === 0) return { __refusal: 'No tasks to create.' };
    if (tasks.length > 50) return { __refusal: `Batch too large (${tasks.length}). Max 50 tasks per batch.` };
    if (!batch && tasks.length !== 1) return { __refusal: 'Single-task create received more than one task.' };

    const single = batch ? null : tasks[0];
    const source = sourceFor(caller);
    const target = { project_id };
    const intent = single
      ? {
        project_id,
        title: single.name,
        description: single.description,
        status: single.status,
        priority: single.priority,
        antigravity_payload: single.antigravity_payload,
        dependencies: single.dependencies,
        successor_id: single.successor_id,
      }
      : { project_id, tasks };

    // Placeholder references are rewritten to real ids by the server, so a
    // task that depends on a sibling's stable_id cannot have its dependency
    // list asserted verbatim on read-back.
    const stableIds = new Set(tasks.map((t) => t.stable_id).filter(Boolean));
    const dependsOnPlaceholder = (t) => (t.dependencies || []).some((d) => stableIds.has(d))
      || (t.successor_id && stableIds.has(t.successor_id));

    return executeTransaction({
      tool: OPS.TASK_CREATE,
      caller,
      target,
      intent,
      captureBefore: async () => null,
      apply: () => (single
        ? backends.nexusTaskCreate({
          project_id,
          name: single.name,
          description: single.description,
          status: single.status,
          priority: single.priority,
          antigravity_payload: single.antigravity_payload,
          dependencies: single.dependencies,
          successor_id: single.successor_id,
          source,
        })
        : backends.nexusTasksBatchCreate({
          project_id,
          tasks: tasks.map((t) => ({ ...t, source })),
        })),
      readAfter: async ({ applyResult }) => {
        const ids = (applyResult?.tasks || []).map((t) => t && t.id).filter(Boolean);
        if (ids.length === 0) throw new Error('Create response did not include a task id.');
        if (single) {
          target.task_id = ids[0];
          return backends.nexusTaskById(ids[0]);
        }
        target.task_ids = ids;
        return Promise.all(ids.map((id) => backends.nexusTaskById(id)));
      },
      verify: ({ after }) => {
        if (single) {
          const mismatches = compareFields(after, expectedCreated(single, project_id));
          return { ok: mismatches.length === 0, mismatches };
        }
        const mismatches = [];
        const rows = Array.isArray(after) ? after : [];
        if (rows.length !== tasks.length) {
          mismatches.push({ field: 'created_count', expected: tasks.length, actual: rows.length });
        }
        tasks.forEach((task, i) => {
          const expected = expectedCreated(task, project_id);
          if (dependsOnPlaceholder(task)) {
            delete expected.dependencies;
            delete expected.successor_id;
          }
          mismatches.push(...compareFields(rows[i], expected).map((m) => ({ ...m, field: `tasks[${i}].${m.field}` })));
        });
        return { ok: mismatches.length === 0, mismatches };
      },
    });
  });
}

/**
 * PATCH one task under the optimistic-lock envelope. `patch` holds the fields
 * to change; `appendNote` appends a timestamped status note to the current
 * description (resolved against the captured before-image, so it is correct
 * across retries). Returns { tx, envelope } where `envelope` is the
 * praxis-mind response body (transaction_id, optimistic_lock, verdict,
 * lock_health) and `tx` carries before/after for surfaces that format their
 * own summary.
 */
async function updateTask(ctx, {
  tool = OPS.TASK_UPDATE,
  task_id,
  patch: requested = {},
  appendNote,
  expected = {},
  on_conflict,
  fields = ['status', 'priority', 'description', 'dependencies', 'successor_id', 'antigravity_payload'],
}) {
  const caller = ctx ? ctx.caller : null;
  const identity = caller ? caller.identity : null;
  return govern(ctx, {
    tool,
    op: OPS.TASK_UPDATE,
    formatError: (error) => {
      const gaugeLine = lockHealth.formatGauge(lockHealth.gauge(OPS.TASK_UPDATE));
      return `${transactionFailure(tool, error)}\nLock health — ${gaugeLine}`;
    },
  }, async () => {
    const patch = {};
    for (const [key, value] of Object.entries(requested)) {
      if (value !== undefined) patch[key] = value;
    }
    if (Object.keys(patch).length === 0 && !appendNote) {
      return { __refusal: `No fields to update. Specify at least one of: ${fields.join(', ')}.` };
    }

    // The note rides on the description, which is only known once the row is
    // captured — so the effective patch is derived from the before-image.
    const notedAt = new Date().toISOString();
    const resolvePatch = (before) => {
      if (!appendNote) return patch;
      const existingDesc = (before && before.description) || '';
      return {
        ...patch,
        description: `${existingDesc}\n\n---\n**[${notedAt}]** Status → ${patch.status}: ${appendNote}`,
      };
    };

    const spec = {
      tool: OPS.TASK_UPDATE,
      caller,
      target: { task_id },
      intent: { patch, ...(appendNote ? { note: appendNote } : {}), expected },
      captureBefore: () => backends.nexusTaskById(task_id),
      validatePreconditions: ({ before, intent }) => compareFields(before, intent.expected),
      apply: ({ before }) => backends.nexusTaskUpdate(task_id, resolvePatch(before)),
      readAfter: () => backends.nexusTaskById(task_id),
      verify: ({ before, after }) => {
        const mismatches = compareFields(after, resolvePatch(before));
        return { ok: mismatches.length === 0, mismatches };
      },
    };

    try {
      const tx = on_conflict === 'fail'
        ? await executeTransaction(spec)
        : await executeOptimisticTransaction(spec, {
          // Only the row timestamp is re-anchored; expected_status stays hard.
          refreshableFields: ['updated_at'],
          // A concurrent writer that already produced exactly this patch has
          // done our work — converge instead of failing the lifecycle flow.
          // (A note append never converges: its target text is never present.)
          isSatisfied: (current) => !appendNote && compareFields(current, patch).length === 0,
        });
      lockHealth.record({
        tool: OPS.TASK_UPDATE,
        caller: identity,
        target: task_id,
        outcome: tx.lock?.outcome || 'committed',
        lock: tx.lock,
      });
      const envelope = withTransactionId(tx.result, tx.transactionId);
      if (tx.lock) envelope.optimistic_lock = tx.lock;
      if (tx.verdict === 'converged_noop') envelope.verdict = tx.verdict;
      const health = lockHealth.gauge(OPS.TASK_UPDATE);
      if (health) envelope.lock_health = health;
      return { tx, envelope };
    } catch (e) {
      // executeTransaction (the strict on_conflict:"fail" path) has no lock
      // trace of its own — build one from the TransactionError's mismatches
      // so a strict-mode stale conflict is counted as contended+unresolved,
      // not silently folded into an uncontended failure.
      const lock = e.lock || (e.verdict === 'stale_precondition'
        ? {
          attempts: 1,
          outcome: 'conflict_unresolved',
          conflicts: [{ attempt: 1, fields: (e.mismatches || []).map((m) => m.field) }],
          blocking_fields: (e.mismatches || []).map((m) => m.field),
        }
        : null);
      lockHealth.record({
        tool: OPS.TASK_UPDATE,
        caller: identity,
        target: task_id,
        outcome: lock?.outcome || 'error',
        lock,
      });
      throw e;
    }
  });
}

module.exports = {
  OPS,
  GATES,
  errorResult,
  withTransactionId,
  transactionFailure,
  listProjects,
  boardState,
  listTasks,
  getTask,
  updateProject,
  createTasks,
  updateTask,
};
