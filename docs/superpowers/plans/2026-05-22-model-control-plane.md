# Nexus Model Control Plane Implementation Plan

> **Status: ✅ SHIPPED — verified against the codebase 2026-07-02.** The unchecked boxes below were never ticked during execution and are NOT open work. Canonical open-items list: shared-mind vault → `projects/Open Items Board.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an end-to-end model control plane so model assignments on terminal commands, tasks, calendar events, and workflow nodes change the actual provider API call.

**Architecture:** Add a model-control service that resolves `model:<id>` and `alias:<name>` assignments into full provider call configs, including local-only override handling and fallback provenance. All execution doorways must call the resolver before dispatch and record snapshots of the actual model used.

**Tech Stack:** Node.js/Express, SQLite/better-sqlite3, Jest, Next.js/React/TypeScript, existing `callAI` provider router, Python/LangGraph payload handoff.

---

## File Structure

- Modify `db/schema-sqlite.sql`: add model registry columns, alias tables, project alias table, local-only setting, model assignment columns, and execution snapshots table.
- Modify `db/index.js`: add JSON parsing columns and CRUD helpers for model control.
- Create `server/services/model-control.js`: central resolver, alias expansion, model availability, local-only short-circuit, snapshot persistence, and terminal system-message logging helper.
- Create `server/routes/model-control.js`: API endpoints for options, resolution preview, alias updates, and local-only mode.
- Modify `server/server.js`: mount the model-control router and pass `db`/`io`.
- Modify `server/services/model-discovery.js`: upsert discovery results into the database with release metadata while preserving the existing in-memory list.
- Modify `server/services/ai-service.js`: normalize provider names, accept resolved model-control config, and expose test seams proving provider branch selection.
- Modify `server/routes/ai-chat.js`: resolve terminal assignments before direct calls or Praxis proxy, save metadata, and log local-only/fallback system messages.
- Modify `server/routes/tasks.js`: persist task `model_assignment` and resolve it for LangGraph run/resume dispatches.
- Modify `server/services/calendar-scheduler.js`: resolve calendar event assignments before Praxis dispatch.
- Modify `server/routes/calendar.js`: persist and return calendar `model_assignment`.
- Modify `server/services/langgraph-supervisor.js`: include resolved model config in LangGraph request payloads and legacy agent runs.
- Modify `server/agent/index.js`: stop treating `provider` as decorative by delegating text/model calls to the shared AI caller or explicit provider adapter.
- Modify `dashboard/src/lib/nexus.ts`: expose `model_assignment` on tasks and model-control API client helpers.
- Modify `dashboard/src/lib/calendar.ts`: expose `model_assignment` on calendar events/forms.
- Create `dashboard/src/lib/model-control.ts`: shared client helpers and formatting utilities.
- Create `dashboard/src/components/model-assignment-control.tsx`: reusable selector/badge for aliases and concrete models.
- Modify `dashboard/src/components/ai-terminal.tsx`: terminal model selector, request payload, and metadata display.
- Modify `dashboard/src/components/task-manager.tsx` and `dashboard/src/components/task-detail-modal.tsx`: task model badges/editing.
- Modify `dashboard/src/app/calendar/page.tsx`: calendar model selector and event display.
- Modify `dashboard/src/components/workflow-builder.tsx`, `dashboard/src/components/workflow-nodes/base-node.tsx`, and `dashboard/src/components/workflow-nodes/node-config-panel.tsx`: node assignment persistence and resolved model display.
- Add Jest tests under `server/__tests__/model-control*.test.js`, plus targeted updates to chat/task/calendar tests.
- Add frontend unit tests where existing test tooling can render the new shared control without a full browser.

---

### Task 1: Database Contract And Model-Control Persistence

**Files:**
- Modify: `db/schema-sqlite.sql`
- Modify: `db/index.js`
- Test: `server/__tests__/model-control-db.test.js`

- [ ] **Step 1: Write failing DB tests**

Create `server/__tests__/model-control-db.test.js` with a temporary database path and module reset:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadFreshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-control-'));
  process.env.NEXUS_DB_PATH = path.join(dir, 'nexus.db');
  jest.resetModules();
  return require('../../db');
}

describe('model control database contract', () => {
  afterEach(() => {
    delete process.env.NEXUS_DB_PATH;
    jest.resetModules();
  });

  test('stores aliases, project overrides, local-only state, assignments, and snapshots', async () => {
    const db = loadFreshDb();
    const project = await db.upsertProject({ name: 'ModelControlTest', path: '/tmp/model-control-test', type: 'app' });
    await db.upsertModel({
      id: 'anthropic-claude-sonnet',
      provider: 'anthropic',
      api_model_id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet',
      display_name: 'Claude Sonnet',
      family: 'claude-sonnet',
      capabilities: { coding: true },
      default_parameters: { max_tokens: 8192 },
      availability_status: 'available',
      is_active: 1
    });

    await db.upsertModelAlias({ alias: 'coder', target: 'model:anthropic-claude-sonnet', description: 'Coding model' });
    await db.upsertProjectModelAlias(project.id, { alias: 'coder', target: 'model:anthropic-claude-sonnet' });
    await db.setModelControlSetting('local_only', { enabled: true, reason: 'budget_limit' });

    const created = await db.createTask({
      project_id: project.id,
      name: 'Use model control',
      status: 'idea',
      model_assignment: 'alias:coder'
    });
    const snapshot = await db.createModelExecutionSnapshot({
      requested_assignment: 'alias:coder',
      resolved_model_id: 'anthropic-claude-sonnet',
      provider: 'anthropic',
      api_model_id: 'claude-sonnet-4-6',
      source: 'project',
      local_only_active: false,
      fallback_used: false,
      project_id: project.id,
      task_id: created.id
    });

    expect((await db.getModelAliases()).find(a => a.alias === 'coder').target).toBe('model:anthropic-claude-sonnet');
    expect((await db.getProjectModelAliases(project.id)).find(a => a.alias === 'coder').target).toBe('model:anthropic-claude-sonnet');
    expect(await db.getModelControlSetting('local_only')).toEqual({ enabled: true, reason: 'budget_limit' });
    expect((await db.getTask(created.id)).model_assignment).toBe('alias:coder');
    expect(snapshot.provider).toBe('anthropic');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- server/__tests__/model-control-db.test.js --runInBand`

Expected: FAIL because alias/settings/snapshot DB helpers and columns do not exist.

- [ ] **Step 3: Implement schema additions**

Add columns/tables in `db/schema-sqlite.sql`:

```sql
ALTER TABLE models ADD COLUMN api_model_id TEXT;
ALTER TABLE models ADD COLUMN display_name TEXT;
ALTER TABLE models ADD COLUMN version_sort TEXT;
ALTER TABLE models ADD COLUMN default_parameters TEXT DEFAULT '{}';
ALTER TABLE models ADD COLUMN discovered_at TEXT;
ALTER TABLE models ADD COLUMN last_seen_at TEXT;
ALTER TABLE models ADD COLUMN availability_status TEXT DEFAULT 'unknown';

ALTER TABLE tasks ADD COLUMN model_assignment TEXT;
ALTER TABLE calendar_events ADD COLUMN model_assignment TEXT;
ALTER TABLE project_workflows ADD COLUMN model_assignment TEXT;
ALTER TABLE workflow_templates ADD COLUMN model_assignment TEXT;

CREATE TABLE IF NOT EXISTS model_aliases (
  alias TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_model_aliases (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  target TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, alias)
);

CREATE TABLE IF NOT EXISTS model_control_settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_execution_snapshots (
  id TEXT PRIMARY KEY,
  requested_assignment TEXT,
  resolved_model_id TEXT,
  provider TEXT,
  api_model_id TEXT,
  parameters_summary TEXT DEFAULT '{}',
  source TEXT,
  local_only_active INTEGER DEFAULT 0,
  local_only_reason TEXT,
  fallback_used INTEGER DEFAULT 0,
  fallback_reason TEXT,
  project_id TEXT,
  task_id TEXT,
  calendar_event_id TEXT,
  workflow_id TEXT,
  workflow_run_id TEXT,
  node_id TEXT,
  conversation_id TEXT,
  message_id TEXT,
  command_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

Because SQLite cannot add duplicate columns, implement startup migrations in `db/index.js` that check `PRAGMA table_info` before each `ALTER TABLE`.

- [ ] **Step 4: Implement DB helpers**

In `db/index.js`, add JSON columns to `JSON_COLS`: `capabilities`, `parameters`, `default_parameters`, `parameters_summary`, and `value`.

Add helpers:

```js
async function upsertModelAlias(aliasRecord) {
  const record = {
    alias: aliasRecord.alias,
    target: aliasRecord.target,
    description: aliasRecord.description || null,
    is_active: aliasRecord.is_active === undefined ? 1 : aliasRecord.is_active,
    updated_at: now(),
    created_at: aliasRecord.created_at || now()
  };
  const { sql, values } = buildInsert('model_aliases', record, 'alias');
  db.prepare(sql).run(...values);
  return deserRow(db.prepare('SELECT * FROM model_aliases WHERE alias = ?').get(record.alias));
}

async function getModelAliases(activeOnly = true) {
  const sql = activeOnly ? 'SELECT * FROM model_aliases WHERE is_active = 1 ORDER BY alias' : 'SELECT * FROM model_aliases ORDER BY alias';
  return deserRows(db.prepare(sql).all());
}

async function upsertProjectModelAlias(projectId, aliasRecord) {
  const record = {
    project_id: projectId,
    alias: aliasRecord.alias,
    target: aliasRecord.target,
    description: aliasRecord.description || null,
    updated_at: now(),
    created_at: aliasRecord.created_at || now()
  };
  const { sql, values } = buildInsert('project_model_aliases', record, 'project_id, alias');
  db.prepare(sql).run(...values);
  return deserRow(db.prepare('SELECT * FROM project_model_aliases WHERE project_id = ? AND alias = ?').get(projectId, record.alias));
}

async function getProjectModelAliases(projectId) {
  return deserRows(db.prepare('SELECT * FROM project_model_aliases WHERE project_id = ? ORDER BY alias').all(projectId));
}

async function setModelControlSetting(key, value) {
  const record = { key, value, updated_at: now() };
  const { sql, values } = buildInsert('model_control_settings', record, 'key');
  db.prepare(sql).run(...values);
  return getModelControlSetting(key);
}

async function getModelControlSetting(key) {
  const row = deserRow(db.prepare('SELECT * FROM model_control_settings WHERE key = ?').get(key));
  return row ? row.value : null;
}

async function createModelExecutionSnapshot(snapshot) {
  const record = { id: snapshot.id || uuid(), ...snapshot, created_at: snapshot.created_at || now() };
  const { sql, values } = buildInsert('model_execution_snapshots', record);
  db.prepare(sql).run(...values);
  return deserRow(db.prepare('SELECT * FROM model_execution_snapshots WHERE id = ?').get(record.id));
}
```

Export all helpers.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- server/__tests__/model-control-db.test.js --runInBand`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db/schema-sqlite.sql db/index.js server/__tests__/model-control-db.test.js
git commit -m "feat(model-control): add persistence contract"
```

---

### Task 2: Resolver, Local-Only Override, And Snapshot Service

**Files:**
- Create: `server/services/model-control.js`
- Modify: `server/server.js`
- Create: `server/routes/model-control.js`
- Test: `server/__tests__/model-control-resolver.test.js`
- Test: `server/__tests__/model-control-route.test.js`

- [ ] **Step 1: Write failing resolver tests**

Create tests covering:

```js
test('resolves item model assignment to provider call config');
test('uses project alias before global alias');
test('uses family_latest newest active model by version_sort');
test('global local-only mode forces local model and preserves requested assignment');
test('unavailable target falls through fallback chain');
```

Use an in-memory stub DB object with methods from Task 1.

- [ ] **Step 2: Run resolver tests to verify failure**

Run: `npm test -- server/__tests__/model-control-resolver.test.js --runInBand`

Expected: FAIL because `server/services/model-control.js` does not exist.

- [ ] **Step 3: Implement resolver service**

Create `server/services/model-control.js` exporting:

```js
async function resolveModelAssignment(db, context = {}) {
  const settings = await db.getModelControlSetting('local_only');
  const requestedAssignment = pickRequestedAssignment(context);
  if (settings?.enabled) {
    return resolveLocalOnly(db, requestedAssignment, settings.reason);
  }
  return resolveNormal(db, requestedAssignment, context);
}

async function recordModelExecutionSnapshot(db, resolved, links = {}) {
  return db.createModelExecutionSnapshot({
    requested_assignment: resolved.requestedAssignment,
    resolved_model_id: resolved.resolvedModelId,
    provider: resolved.provider,
    api_model_id: resolved.apiModelId,
    parameters_summary: summarizeParameters(resolved.parameters),
    source: resolved.source,
    local_only_active: resolved.localOnlyActive ? 1 : 0,
    local_only_reason: resolved.localOnlyReason || null,
    fallback_used: resolved.fallbackUsed ? 1 : 0,
    fallback_reason: resolved.fallbackReason || null,
    ...links
  });
}

async function writeModelSystemMessage(db, io, message, metadata = {}) {
  const conversation = await db.getActiveConversation?.('praxis');
  if (!conversation) return null;
  const saved = await db.saveChatMessage({ conversation_id: conversation.id, role: 'system', content: message, mode: 'praxis', metadata });
  if (saved && io) io.emit('chat-message', require('../chat-message-format').buildChatMessageEvent(saved));
  return saved;
}
```

Resolution must:

- Parse `model:<id>` directly from `db.getModel(id)`.
- Parse `alias:<name>` from project aliases before global aliases.
- Resolve `family_latest:<provider>/<family>` by active, available models sorted by `version_sort`.
- Resolve `capability_best:<capability>` by active, available models with capability truthy.
- Resolve `fallback_chain:[...]` as a JSON array or simple comma-delimited bracket content.
- Treat missing API keys for non-local providers as unavailable.
- Always fall back to `alias:local_default` or the first active local model.

- [ ] **Step 4: Implement API routes**

Create `server/routes/model-control.js` with:

```js
router.get('/options', async (req, res) => {
  const projectId = req.query.projectId || null;
  res.json({
    models: await db.getModels(true),
    aliases: await db.getModelAliases(true),
    projectAliases: projectId ? await db.getProjectModelAliases(projectId) : [],
    localOnly: await db.getModelControlSetting('local_only')
  });
});

router.post('/resolve', async (req, res) => {
  res.json(await resolveModelAssignment(db, req.body || {}));
});

router.put('/aliases/:alias', async (req, res) => {
  res.json(await db.upsertModelAlias({ alias: req.params.alias, target: req.body.target, description: req.body.description, is_active: req.body.is_active }));
});

router.put('/local-only', async (req, res) => {
  res.json(await db.setModelControlSetting('local_only', { enabled: !!req.body.enabled, reason: req.body.reason || null }));
});

router.put('/projects/:id/aliases/:alias', async (req, res) => {
  res.json(await db.upsertProjectModelAlias(req.params.id, { alias: req.params.alias, target: req.body.target, description: req.body.description }));
});
```

Mount in `server/server.js` at `/api/model-control`.

- [ ] **Step 5: Run resolver and route tests**

Run: `npm test -- server/__tests__/model-control-resolver.test.js server/__tests__/model-control-route.test.js --runInBand`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/model-control.js server/routes/model-control.js server/server.js server/__tests__/model-control-resolver.test.js server/__tests__/model-control-route.test.js
git commit -m "feat(model-control): resolve model assignments"
```

---

### Task 3: Discovery Upserts And Provider Call Boundary

**Files:**
- Modify: `server/services/model-discovery.js`
- Modify: `server/services/ai-service.js`
- Test: `server/__tests__/model-discovery-registry.test.js`
- Test: `server/__tests__/ai-service-routing.test.js`

- [ ] **Step 1: Write failing tests**

Add tests that:

- Mock provider discovery results and assert `db.upsertModel` receives `api_model_id`, `family`, `capabilities`, `discovered_at`, `last_seen_at`, and `availability_status`.
- Mock `fetch` and Google SDK seams to prove `callAI({ provider: 'anthropic' })` calls Anthropic URL, `callAI({ provider: 'openai' })` calls OpenAI URL, and `callAI({ provider: 'local' })` calls local URL.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- server/__tests__/model-discovery-registry.test.js server/__tests__/ai-service-routing.test.js --runInBand`

Expected: FAIL until discovery accepts DB upsert and `callAI` exposes testable routing.

- [ ] **Step 3: Implement discovery registry upsert**

Update `discoverModels` to accept optional `{ db }`, or require DB lazily, then upsert each discovered model:

```js
await db.upsertModel({
  id: m.id,
  provider: normalizeProvider(m.provider),
  api_model_id: m.apiModelId,
  name: m.name,
  display_name: m.name,
  family: m.family,
  version_sort: m.versionSort,
  capabilities: inferCapabilities(m),
  default_parameters: inferDefaultParameters(m),
  availability_status: 'available',
  is_active: 1,
  discovered_at: existing?.discovered_at || now,
  last_seen_at: now
});
```

- [ ] **Step 4: Harden provider config in `callAI`**

Normalize provider casing and support either `apiModelId` or `api_model_id`. Return usage plus `provider` and `model` in full result mode:

```js
if (options.returnFullResult) {
  return { ...result, provider, model: modelId };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- server/__tests__/model-discovery-registry.test.js server/__tests__/ai-service-routing.test.js --runInBand`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/model-discovery.js server/services/ai-service.js server/__tests__/model-discovery-registry.test.js server/__tests__/ai-service-routing.test.js
git commit -m "feat(model-control): sync discovery and provider routing"
```

---

### Task 4: Terminal And Praxis Chat Integration

**Files:**
- Modify: `server/routes/ai-chat.js`
- Modify: `dashboard/src/components/ai-terminal.tsx`
- Create: `dashboard/src/lib/model-control.ts`
- Create: `dashboard/src/components/model-assignment-control.tsx`
- Test: `server/__tests__/ai-chat-model-control.test.js`

- [ ] **Step 1: Write failing server tests**

Test direct chat:

```js
it('resolves model assignment and calls callAI with resolved provider config');
it('persists fallback/local-only system message when resolver redirects');
it('passes resolved model metadata to Praxis proxy payload');
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- server/__tests__/ai-chat-model-control.test.js --runInBand`

Expected: FAIL because `/api/ai/chat` ignores `model_assignment`.

- [ ] **Step 3: Implement chat route resolution**

In `server/routes/ai-chat.js`, destructure `model_assignment`. Before direct or Praxis execution:

```js
const resolved = await resolveModelAssignment(db, {
  requestedAssignment: model_assignment,
  projectId,
  role: mode === 'praxis' ? 'praxis' : 'chat'
});
```

For direct chat, call `callAI` with resolved config. For Praxis, include:

```js
modelAssignment: model_assignment,
resolvedModel: resolved,
modelOverride: {
  provider: resolved.provider,
  apiModelId: resolved.apiModelId,
  parameters: resolved.parameters
}
```

Record snapshots and save metadata on user/assistant messages.

- [ ] **Step 4: Implement frontend helpers and control**

Create `dashboard/src/lib/model-control.ts`:

```ts
export interface ModelControlOption { value: string; label: string; description?: string; resolvedLabel?: string; source?: string; }
export async function getModelControlOptions(projectId?: string): Promise<ModelControlOption[]>;
export async function resolveModelAssignment(input: { model_assignment?: string; projectId?: string; role?: string }): Promise<any>;
export function formatResolvedModel(resolved: any): string;
```

Create `ModelAssignmentControl` with a compact select, resolved preview text, and `onChange`.

In `AITerminal`, keep `selectedModelAssignment`, render the control near settings/input, and include `model_assignment` in the POST body.

- [ ] **Step 5: Run server tests and dashboard type check**

Run:

```bash
npm test -- server/__tests__/ai-chat-model-control.test.js --runInBand
cd dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routes/ai-chat.js server/__tests__/ai-chat-model-control.test.js dashboard/src/lib/model-control.ts dashboard/src/components/model-assignment-control.tsx dashboard/src/components/ai-terminal.tsx
git commit -m "feat(model-control): route terminal model assignments"
```

---

### Task 5: Tasks, LangGraph Dispatch, And Agent Bypass Fix

**Files:**
- Modify: `server/routes/tasks.js`
- Modify: `server/services/langgraph-supervisor.js`
- Modify: `server/agent/index.js`
- Modify: `dashboard/src/lib/nexus.ts`
- Modify: `dashboard/src/components/task-manager.tsx`
- Modify: `dashboard/src/components/task-detail-modal.tsx`
- Test: `server/__tests__/tasks-model-control.test.js`
- Test: `server/__tests__/agent-provider-routing.test.js`

- [ ] **Step 1: Write failing tests**

Assert:

- Task create/update persists `model_assignment`.
- LangGraph run route resolves task assignment and passes provider config to supervisor.
- Resume redispatch includes resolved model override.
- `runAgent({ provider: 'anthropic', model: 'claude-sonnet-4-6' })` does not instantiate Gemini-only execution for the LLM call.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- server/__tests__/tasks-model-control.test.js server/__tests__/agent-provider-routing.test.js --runInBand`

Expected: FAIL.

- [ ] **Step 3: Implement task persistence**

In task create/update routes accept `model_assignment`. Include it in task responses. In `dashboard/src/lib/nexus.ts`, add `model_assignment?: string | null` to `Task`, `addTask`, `updateTask`, and task detail update types.

- [ ] **Step 4: Resolve before LangGraph run/resume**

In `router.post('/:id/tasks/:taskId/langgraph/run')`, call resolver with task/project/template context and pass:

```js
resolvedModel,
modelOverride: {
  provider: resolved.provider,
  apiModelId: resolved.apiModelId,
  parameters: resolved.parameters
}
```

Record snapshot linked to task and project.

In resume route, resolve before `/resume-task` and include the same model override shape.

- [ ] **Step 5: Fix `runAgent` provider bypass**

Replace the Gemini-only text model call in `server/agent/index.js` for non-tool-call paths with a shared adapter path. If full tool calling remains Gemini-only for now, enforce a clear branch:

```js
if (provider !== 'google') {
  return runTextOnlyAgentWithCallAI({
    provider,
    model,
    task,
    systemPrompt,
    history,
    onProgress,
    maxIterations
  });
}
```

Do not silently accept Claude and call Gemini.

- [ ] **Step 6: Add task UI controls**

Show `ModelAssignmentControl` in task creation/editing and detail modal. Render compact badge on task cards.

- [ ] **Step 7: Run tests and type check**

Run:

```bash
npm test -- server/__tests__/tasks-model-control.test.js server/__tests__/agent-provider-routing.test.js --runInBand
cd dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/routes/tasks.js server/services/langgraph-supervisor.js server/agent/index.js server/__tests__/tasks-model-control.test.js server/__tests__/agent-provider-routing.test.js dashboard/src/lib/nexus.ts dashboard/src/components/task-manager.tsx dashboard/src/components/task-detail-modal.tsx
git commit -m "feat(model-control): enforce task model assignments"
```

---

### Task 6: Calendar, Scheduled Activity, And Local-Only UI

**Files:**
- Modify: `server/routes/calendar.js`
- Modify: `server/services/calendar-scheduler.js`
- Modify: `dashboard/src/lib/calendar.ts`
- Modify: `dashboard/src/app/calendar/page.tsx`
- Modify: `dashboard/src/components/nav-sidebar.tsx` or `dashboard/src/app/page.tsx`
- Test: `server/__tests__/calendar-model-control.test.js`

- [ ] **Step 1: Write failing tests**

Add tests proving:

- Calendar create/update persists `model_assignment`.
- Scheduler resolves model before `notifyPraxis`.
- Local-only mode redirects a calendar cloud assignment to local and logs a system message.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- server/__tests__/calendar-model-control.test.js --runInBand`

Expected: FAIL.

- [ ] **Step 3: Implement calendar route and scheduler changes**

Accept `model_assignment` in create/update. In scheduler, before dispatch:

```js
const resolved = await resolveModelAssignment(dbRef, {
  requestedAssignment: event.model_assignment,
  projectId: event.project_id,
  calendarEventId: event.id,
  role: 'scheduled_activity'
});
const eventWithModel = {
  ...event,
  modelAssignment: event.model_assignment,
  resolvedModel: resolved,
  modelOverride: {
    provider: resolved.provider,
    apiModelId: resolved.apiModelId,
    parameters: resolved.parameters
  }
};
```

Record snapshot and write local-only/fallback message when needed.

- [ ] **Step 4: Implement calendar UI**

Add `model_assignment` to `CalendarEvent` and `CalendarEventForm`. Render `ModelAssignmentControl` in modal and badge on event block.

- [ ] **Step 5: Implement global local-only toggle**

Add a compact global toggle in the dashboard shell or main dashboard page using `PUT /api/model-control/local-only`. It must display active reason and make active mode visually obvious.

- [ ] **Step 6: Run tests and type check**

Run:

```bash
npm test -- server/__tests__/calendar-model-control.test.js --runInBand
cd dashboard && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/routes/calendar.js server/services/calendar-scheduler.js server/__tests__/calendar-model-control.test.js dashboard/src/lib/calendar.ts dashboard/src/app/calendar/page.tsx dashboard/src/components/nav-sidebar.tsx dashboard/src/app/page.tsx
git commit -m "feat(model-control): enforce scheduled model assignments"
```

---

### Task 7: Workflow Nodes And Python/LangGraph Handoff

**Files:**
- Modify: `dashboard/src/components/workflow-builder.tsx`
- Modify: `dashboard/src/components/workflow-nodes/base-node.tsx`
- Modify: `dashboard/src/components/workflow-nodes/node-config-panel.tsx`
- Modify: `server/routes/workflows.js`
- Modify: `server/routes/langgraph.js`
- Modify: `nexus-builder/node_registry.py`
- Test: `server/__tests__/workflow-model-control.test.js`

- [ ] **Step 1: Write failing workflow tests**

Assert:

- Saved graph nodes preserve `data.config.model_assignment`.
- Node `data.model` badge mirrors resolved preview.
- LangGraph run payload includes per-node resolved model configs.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- server/__tests__/workflow-model-control.test.js --runInBand`

Expected: FAIL.

- [ ] **Step 3: Implement node model assignment UI**

Add `ModelAssignmentControl` to node config for LLM-capable nodes. Store source of truth in `data.config.model_assignment`; update `data.model` with resolved preview label.

- [ ] **Step 4: Resolve graph node assignments before run**

In the Node API layer that proxies/runs LangGraph, walk `graphConfig.nodes`, resolve each `node.data.config.model_assignment`, and attach:

```js
node.data.config.resolved_model = {
  provider,
  api_model_id: apiModelId,
  parameters,
  source,
  local_only_active
};
```

Record snapshots linked to workflow/node/run when run id is known.

- [ ] **Step 5: Consume normalized model config in Python**

In `nexus-builder/node_registry.py`, update `_get_llm` to prefer config shape:

```python
resolved = config.get("resolved_model") or {}
provider = resolved.get("provider")
model = resolved.get("api_model_id") or config.get("model")
```

Dispatch by provider rather than string guessing when provider is present.

- [ ] **Step 6: Run tests and Python smoke test**

Run:

```bash
npm test -- server/__tests__/workflow-model-control.test.js --runInBand
python -m pytest nexus-builder/tests -q
cd dashboard && npx tsc --noEmit
```

Expected: PASS or document pre-existing unrelated Python failures.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/components/workflow-builder.tsx dashboard/src/components/workflow-nodes/base-node.tsx dashboard/src/components/workflow-nodes/node-config-panel.tsx server/routes/workflows.js server/routes/langgraph.js nexus-builder/node_registry.py server/__tests__/workflow-model-control.test.js
git commit -m "feat(model-control): route workflow node assignments"
```

---

### Task 8: End-To-End Verification And Polish

**Files:**
- Modify only files needed for fixes found by tests or visual review.

- [ ] **Step 1: Run full targeted server suite**

Run:

```bash
npm test -- --runInBand
```

Expected: PASS or only documented pre-existing failures unrelated to model control.

- [ ] **Step 2: Run dashboard type check/build**

Run:

```bash
cd dashboard && npx tsc --noEmit && npm run build
```

Expected: PASS.

- [ ] **Step 3: Start local dev server**

Run:

```bash
cd dashboard && npm run dev
```

Expected: Next dev server starts. Use an available port if `3000` is occupied.

- [ ] **Step 4: Browser verification**

Open the dashboard and verify:

- Terminal selector is visible and payload changes.
- Task cards/details show model assignment.
- Calendar modal and event block show assignment.
- Workflow node config and node badge show assignment.
- Local-only toggle visibly changes model previews to local.

- [ ] **Step 5: Final git status and summary**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: Only intentional model-control changes are present in the worktree.

- [ ] **Step 6: Final commit if needed**

If verification fixes were made:

```bash
git add <changed-files>
git commit -m "fix(model-control): polish integration"
```
