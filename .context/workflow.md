---
context_type: workflow
status: active
updated_at: 2026-03-10T13:01:32.706Z
---

# Workflow Architecture

The Nexus utilizes a sophisticated workflow engine built on **LangGraph** to orchestrate AI agents, manage project state, and execute complex development tasks. This architecture separates control flow from agent logic, allowing for deterministic and resumable execution.

## Agent Architecture

The system has evolved from monolithic, multi-purpose agents to a modular architecture based on **Atomic Nodes**.

### Atomic Nodes
Instead of large "Coder" or "Planner" agents that handle end-to-end logic, workflows are composed of granular, atomic nodes (e.g., `analyze_requirements`, `generate_code_snippet`, `run_linter`).
- **Composability**: Nodes can be reused across different workflow types.
- **State Isolation**: Each node receives a strictly typed state and returns specific updates.
- **Error Handling**: Failures are isolated to specific nodes, allowing for targeted retries.

## Workflow Types

The engine supports specialized workflows tailored to specific operational contexts.

| Workflow | File | Description |
| :--- | :--- | :--- |
| **Task Execution** | `architect_workflow.py` | The standard development loop (Plan → Code → Test) for implementing project features. |
| **Dashboard Initiative** | `dashboard_supervisor.py` | High-level orchestration for cross-project operations (e.g., "Update dependencies across all apps"). |
| **Documentation** | `doc_workflow.py` | **(New)** A specialized lightweight workflow for context and documentation updates. It bypasses the heavy architect fleet to directly manipulate the `ArtifactStore` and context files. |

## Artifact Management

To ensure data consistency and thread safety during parallel execution, the system employs a dedicated **Artifact Store**.

### `ArtifactStore`
The `ArtifactStore` serves as the central repository for all data generated during a workflow run.
- **Thread-Safety**: Implements locking mechanisms to safely handle concurrent writes from parallel nodes.
- **Versioning**: Maintains version history for artifacts, allowing workflows to rollback or reference previous states.
- **Persistence**: Decouples transient workflow state from persistent project data.

## Real-time Streaming (SSE)

User experience is enhanced through real-time feedback managed by the **StreamManager**.

### `StreamManager`
This component bridges the Python execution engine with the frontend via Server-Sent Events (SSE).
- **Token Streaming**: Streams LLM output tokens immediately as they are generated.
- **Lifecycle Events**: Broadcasts `node_start` and `node_end` events to visualize graph progress.
- **Artifact Updates**: Notifies the UI when new artifacts (code, plans, files) are created or updated in the `ArtifactStore`.

## Execution Flow

1. **Initialization**: The API triggers a workflow run via `POST /api/run`.
2. **Graph Compilation**: The Python engine compiles the requested workflow template into a `StateGraph`.
3. **Streaming**: The `StreamManager` establishes an SSE channel.
4. **Execution**: Nodes execute atomically, reading/writing to the `ArtifactStore`.
5. **Completion**: Final artifacts are synced to the database and the run concludes.