# Architectural Disconnect Report & Context Audit

> Historical note: this report predates the 2026-07-02 workflow orchestration decommission. The Python workflow service it recommends is retired; see `../decommission/langgraph-2026-07-02.md`.

## 1. Context Management Audit
**Status:** Functional but Data-Dependent.

- **Mechanism:** `src/services/conductor.js` correctly queries the `project_contexts` and `tracks` tables in Supabase.
- **Verification:** `tests/test-context-injection.js` confirmed that if data exists (e.g., Tracks), it is successfully loaded and formatted for the agent.
- **Issue:** Many projects (like "Adventures of Dean") lack entries in `project_contexts`, causing them to run without global context.
- **Action Item:** Need a migration script to scrape existing `.conductor/*.md` files and populate `project_contexts`.

## 2. The Feature Pipeline Disconnect
**Status:** Historical. The higher-level Python workflow engine discussed here is no longer a live target.

### Architecture Comparison

| Level | Orchestrator | Execution Engine | Protocol |
|-------|--------------|------------------|----------|
| **Dashboard** | `dashboard-initiative-supervisor.js` | Retired Python workflow path | Removed |
| **Project** | `project-workflow-supervisor.js` | Retired Python workflow path | Removed |
| **Feature** | `supervisor.js` | **Node.js Loop** (`src/agent/index.js`) | Direct Function Call |

### Implications
1.  **Inconsistent Behavior:** Feature implementation uses a hardcoded Node.js loop (`src/agent/index.js`), missing out on LangGraph's advanced capabilities (checkpointing, time-travel, complex conditional routing).
2.  **Duplicated Logic:** We are maintaining two agent runtimes: the Python one (robust, graph-based) and the Node.js one (legacy, loop-based).
3.  **Context Fragmentation:** While `src/agent/index.js` *tries* to load context, the Python engine has its own context loading logic in `graph_engine.py`.

### Recommendation Status
The unification strategy below was rejected by later operational evidence. Do not implement new work against the retired Python workflow service.
