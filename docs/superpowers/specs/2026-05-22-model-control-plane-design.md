# Nexus Model Control Plane Design

## Purpose

The Nexus should let the operator control which model is responsible for every executable surface: workflow nodes, scheduled calendar activity, project tasks, and Praxis terminal commands. The selected model may be a concrete model or a role alias. The selected assignment must affect the actual API call, not only the UI display.

## Scope

This design covers the first implementation slice for end-to-end model control. It includes persistence, model discovery, alias/default resolution, execution routing, UI display, fallback logging, and audit snapshots.

The first implementation must control:

- Praxis terminal commands.
- Task execution, including LangGraph dispatch, task resume, and Praxis task redispatch.
- Calendar events and scheduled activities.
- Workflow builder nodes and saved workflow graph configuration.

## Core Concepts

### Model Registry

The existing `models` table becomes the durable registry for cloud and local models. Discovery upserts registry records instead of only producing UI options.

Each model record should include:

- `id`: stable Nexus model id.
- `provider`: `google`, `anthropic`, `openai`, `xai`, or `local`.
- `api_model_id`: exact provider API model id.
- `display_name`: user-facing name.
- `family`: release family, such as `gemini-pro`, `claude-sonnet`, `gpt-codex`, or `local-default`.
- `version_sort`: sortable release/version key for latest-family resolution.
- `capabilities`: JSON capabilities such as `fast`, `deep_reasoning`, `coding`, `vision`, `tool_use`, and `local`.
- `default_parameters`: provider-specific defaults.
- `discovered_at`, `last_seen_at`, `availability_status`, and `is_active`.

### Model Assignment

Executable records store a `model_assignment` string:

- `model:<id>` pins an exact registry model.
- `alias:<name>` resolves a policy alias such as `coder`, `reviewer`, `fast_cloud`, `deep_reasoning`, or `local_default`.

Workflow node assignments live in `node.data.config.model_assignment`. For node badges, the resolved preview can also be mirrored into `node.data.model`, but the config field is the source of truth.

### Aliases

Global aliases and project aliases define reusable policies. Project aliases override global aliases with the same name.

Alias target types:

- `model:<id>`: exact pinned model.
- `family_latest:<provider>/<family>`: newest active model in a family.
- `capability_best:<capability>`: best active model with a capability, ranked by policy.
- `fallback_chain:[...]`: explicit ordered targets.

Example: `alias:coder` may prefer latest Claude Sonnet, then latest GPT coding model, then `alias:local_default`.

### Resolution Order

Every execution route resolves assignment with the same order:

1. Item override.
2. Workflow or template default.
3. Project alias/default.
4. Global role alias/default.
5. Local fallback.

The resolver returns a complete execution object, not only a display label:

```ts
interface ResolvedModelAssignment {
  requestedAssignment: string;
  resolvedModelId: string;
  provider: "google" | "anthropic" | "openai" | "xai" | "local";
  apiModelId: string;
  parameters: Record<string, unknown>;
  source: "item" | "workflow" | "project" | "global" | "fallback";
  fallbackUsed: boolean;
  fallbackReason?: string;
}
```

## Execution Routing

The assignment must control the actual outbound provider call.

The Node.js central caller is `server/services/ai-service.js`. The resolver output is converted into the direct `callAI` config:

```js
await callAI(
  {
    provider: resolved.provider,
    apiModelId: resolved.apiModelId,
    parameters: resolved.parameters
  },
  prompt,
  systemPrompt,
  history,
  { returnFullResult: true }
);
```

Inside `callAI`, `provider` selects the actual API branch:

- `google` calls Gemini.
- `anthropic` calls Claude.
- `openai` calls OpenAI.
- `xai` calls Grok.
- `local` calls the local OpenAI-compatible endpoint.

Changing from Gemini to Claude means the resolver emits `provider: "anthropic"` and `apiModelId` for Claude, causing `callAI` to use the Anthropic branch.

### Existing Bypass Paths

`server/agent/index.js` currently accepts `provider` and `model` but directly constructs a Gemini client. It must be changed to call the shared AI caller or a shared provider-adapter layer. Otherwise agent model selection would remain decorative.

Python/LangGraph code, including `nexus-builder/node_registry.py`, currently infers provider from model strings. It must receive normalized `provider`, `api_model_id`, and `parameters` for each node. Python execution may use equivalent provider adapters, but it must consume resolver output rather than guessing from a display model name.

## Controlled Surfaces

### Praxis Terminal

`AITerminal` sends `model_assignment` with each command. The terminal UI displays the selected assignment and resolved preview near the input.

`/api/ai/chat` resolves the assignment before execution:

- For direct chat mode, it calls `callAI` with the resolved provider config.
- For Praxis mode, it sends `modelAssignment`, `resolvedModel`, and snapshot metadata to Praxis so Praxis can route intentionally.

The saved chat message metadata records requested assignment, resolved model, provider, source, and fallback status.

### Tasks

Tasks store `model_assignment`. Task cards and task detail views display assignment and resolved preview.

Task execution paths resolve before dispatch:

- `runTaskWithLangGraph`.
- Task resume.
- Batch-created tasks when dispatched later.
- Praxis task redispatch.

The resolved config is passed as `modelOverride` or the equivalent structured payload to LangGraph/Praxis. Task reset to idea may clear execution state, but should not clear the selected model assignment unless the operator explicitly changes it.

### Workflow Nodes

The workflow builder exposes a model assignment control in node configuration. Node cards show the assignment and resolved preview.

Saved graph config stores `data.config.model_assignment`. When a workflow runs, each LLM-capable node receives its own resolved config. If a node has no override, it inherits workflow, project, global, then fallback defaults.

### Calendar And Scheduled Activity

Calendar events store `model_assignment`. The create/edit modal and event block display assignment and resolved preview.

`calendar-scheduler` resolves each due event immediately before dispatch to Praxis. The dispatched event payload includes `modelAssignment`, `resolvedModel`, and model snapshot metadata.

The existing `scheduled_tasks.agent_configuration` should support `model_assignment` for future schedule views beyond calendar events. When scheduled tasks run, they use the same resolver.

## Fallback And Terminal Logging

If the requested model or alias target is unavailable, the resolver auto-falls back through the policy chain. It records `fallbackUsed: true` and `fallbackReason`.

Fallback must write a visible system message into Praxis terminal history, for example:

```text
Model fallback: requested alias:coder -> claude-sonnet-4-6, but Anthropic API key is unavailable. Ran local-default instead.
```

This message should be saved as a `system` chat message and emitted through the existing chat live-update path when available.

## Execution Snapshots

Every real model run appends an execution snapshot. Snapshots preserve the exact runtime model even when aliases later move to newer releases.

Snapshot fields:

- `id`.
- `requested_assignment`.
- `resolved_model_id`.
- `provider`.
- `api_model_id`.
- `parameters_summary`.
- `source`.
- `fallback_used`.
- `fallback_reason`.
- Entity links when known: `project_id`, `task_id`, `calendar_event_id`, `workflow_id`, `workflow_run_id`, `node_id`, `conversation_id`, `message_id`, and `command_id`.
- `created_at`.

## API Shape

New model control endpoints:

- `GET /api/model-control/options`: active models, aliases, project overrides when scoped, and resolved defaults.
- `POST /api/model-control/resolve`: previews a requested assignment with context.
- `PUT /api/model-control/aliases/:alias`: creates or updates a global alias.
- `PUT /api/projects/:id/model-aliases/:alias`: creates or updates a project override.

Existing APIs accept and return `model_assignment` where relevant:

- Task create/update/list/detail.
- Calendar create/update/list.
- Workflow template save/load/run.
- AI chat request and response metadata.

## User Interface

Controls should appear near the thing they affect:

- Terminal input: compact model selector with alias/model options and resolved preview.
- Task cards and detail modal: model badge plus editable assignment control.
- Calendar events and edit modal: model badge plus selector.
- Workflow nodes: node badge and node config selector.
- Project settings: project alias overrides and project default.
- Global settings or Agent Manager: global alias definitions and model registry status.

Display format should make provenance clear:

```text
alias:coder -> Claude Sonnet 4.6
Project override
```

When using defaults:

```text
alias:fast_cloud -> Gemini Flash
Global default
```

When fallback occurred:

```text
alias:deep_reasoning -> local-default
Fallback from OpenAI: missing API key
```

## Testing Requirements

Tests must prove behavior at the API-call boundary, not only persistence.

Required tests:

- Resolver picks item, workflow, project, global, then local fallback in order.
- `model:<id>` returns the provider and API id from the registry.
- `family_latest` changes resolution when discovery upserts a newer active model.
- `capability_best` ignores inactive or unavailable models.
- Direct chat selecting Claude invokes the Anthropic branch of `callAI`.
- Direct chat selecting Gemini invokes the Google branch of `callAI`.
- Local selection invokes the local OpenAI-compatible branch.
- Unavailable selected model falls back and writes a Praxis terminal system message.
- Calendar dispatch resolves the event model before notifying Praxis.
- Task LangGraph dispatch passes resolved provider config.
- Workflow node config persists `model_assignment` and node execution receives the resolved config.

## Rollout Notes

Existing records with no `model_assignment` should continue to work through default resolution. Existing node `data.model` values may be migrated into `data.config.model_assignment` when possible, but the system should tolerate older graphs.

The implementation should keep unrelated dashboard and context changes untouched.
