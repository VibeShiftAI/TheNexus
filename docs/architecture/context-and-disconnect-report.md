# Architectural Disconnect Report & Context Audit

## 1. Context Management Audit
**Status:** Functional but Data-Dependent.

- **Mechanism:** `src/services/conductor.js` correctly queries the `project_contexts` and `tracks` tables in Supabase.
- **Verification:** `tests/test-context-injection.js` confirmed that if data exists (e.g., Tracks), it is successfully loaded and formatted for the agent.
- **Issue:** Many projects (like "Adventures of Dean") lack entries in `project_contexts`, causing them to run without global context.
- **Action Item:** Need a migration script to scrape existing `.conductor/*.md` files and populate `project_contexts`.

## 2. The Feature Pipeline Disconnect
**Status:** **Confirmed.** The Feature Pipeline is architecturally isolated from the LangGraph engine used by higher levels.

### Architecture Comparison

| Level | Orchestrator | Execution Engine | Protocol |
|-------|--------------|------------------|----------|
| **Dashboard** | `dashboard-initiative-supervisor.js` | **Python LangGraph** (`graph_engine.py`) | HTTP (`POST /graph/run`) |
| **Project** | `project-workflow-supervisor.js` | **Python LangGraph** (`graph_engine.py`) | HTTP (`POST /graph/run`) |
| **Feature** | `supervisor.js` | **Node.js Loop** (`src/agent/index.js`) | Direct Function Call |

### Implications
1.  **Inconsistent Behavior:** Feature implementation uses a hardcoded Node.js loop (`src/agent/index.js`), missing out on LangGraph's advanced capabilities (checkpointing, time-travel, complex conditional routing).
2.  **Duplicated Logic:** We are maintaining two agent runtimes: the Python one (robust, graph-based) and the Node.js one (legacy, loop-based).
3.  **Context Fragmentation:** While `src/agent/index.js` *tries* to load context, the Python engine has its own context loading logic in `graph_engine.py`.

### Recommendation: Unification Strategy
To fix this "problem area," we should refactor `src/services/supervisor.js` to stop calling `src/agent/index.js` directly. Instead, it should:
1.  Select a "Feature Implementation" workflow template (to be created).
2.  Delegate execution to the Python LangGraph engine via `POST /graph/run`, passing the `featureId`.
3.  Retire `src/agent/index.js` or repurpose it strictly as a wrapper for the Python engine.

This will unify the entire system under the Nexus Protocol and LangGraph architecture.
