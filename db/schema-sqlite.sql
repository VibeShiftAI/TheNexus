-- ============================================================================
-- TheNexus Database Schema for SQLite
-- Migrated from Supabase/PostgreSQL to local SQLite
-- UUIDs generated in application code (crypto.randomUUID)
-- JSONB columns stored as TEXT (JSON.stringify / JSON.parse)
-- TIMESTAMPTZ stored as TEXT ISO-8601 strings
-- TEXT[] arrays stored as TEXT (JSON array strings)
-- updated_at set in application code (no triggers)
-- ============================================================================

-- ============================================================================
-- CORE TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    type TEXT,
    description TEXT,
    vibe TEXT,
    stack TEXT DEFAULT '{}',           -- JSON object
    urls TEXT DEFAULT '{}',            -- JSON object
    tasks_list TEXT DEFAULT '[]',      -- JSON array of strings
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'idea',
    priority INTEGER DEFAULT 0,
    analysis_output TEXT,
    spec_output TEXT,
    research_output TEXT,
    research_interaction_id TEXT,
    research_metadata TEXT,            -- JSON: { generatedAt, mode, feedback, ... }
    plan_output TEXT,
    plan_metadata TEXT,                -- JSON: { generatedAt, approvedAt, ... }
    walkthrough TEXT,
    task_ledger TEXT DEFAULT '[]',     -- JSON array
    langgraph_template TEXT,           -- LangGraph workflow template ID
    supervisor_status TEXT,
    supervisor_details TEXT,           -- JSON object
    reasoning_level TEXT DEFAULT 'vibe',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- ============================================================================
-- WORKFLOW ENGINE TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    graph_config TEXT NOT NULL,         -- JSON (React Flow nodes/edges)
    version INTEGER DEFAULT 1,
    is_template INTEGER DEFAULT 0,     -- boolean as 0/1
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    feature_id TEXT,
    status TEXT DEFAULT 'running',
    current_node TEXT,
    context TEXT DEFAULT '{}',         -- JSON object
    error_message TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- LangGraph checkpoints (compatibility with LangGraph's PostgresSaver)
CREATE TABLE IF NOT EXISTS checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    parent_id TEXT,
    checkpoint TEXT NOT NULL,           -- JSON
    metadata TEXT DEFAULT '{}',         -- JSON
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (thread_id, checkpoint_id)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_thread ON checkpoints(thread_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_parent ON checkpoints(parent_id);

-- ============================================================================
-- CONDUCTOR TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    feature_id TEXT,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracks_project ON tracks(project_id);

CREATE TABLE IF NOT EXISTS track_steps (
    id TEXT PRIMARY KEY,
    track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE NOT NULL,
    step_order INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    agent_id TEXT,
    run_id TEXT,
    output TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(track_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_track_steps_track ON track_steps(track_id);
CREATE INDEX IF NOT EXISTS idx_track_steps_status ON track_steps(status);

-- ============================================================================
-- SCHEDULER TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    cron_expression TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    agent_configuration TEXT DEFAULT '{}',  -- JSON
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'active',
    last_run_at TEXT,
    next_run_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_at);

CREATE TABLE IF NOT EXISTS execution_logs (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    output TEXT,
    error TEXT,
    duration_ms INTEGER,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_execution_logs_task ON execution_logs(task_id);

CREATE TABLE IF NOT EXISTS agent_memories (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    memory_type TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',          -- JSON
    importance REAL DEFAULT 0.5,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_memories_task ON agent_memories(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_type ON agent_memories(memory_type);

-- ============================================================================
-- AGENT CONFIGURATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    default_model TEXT NOT NULL,
    system_prompt TEXT,
    parameters TEXT DEFAULT '{}',        -- JSON
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- USAGE TRACKING
-- ============================================================================

CREATE TABLE IF NOT EXISTS usage_stats (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    request_count INTEGER DEFAULT 0,
    UNIQUE(date, model)
);

CREATE INDEX IF NOT EXISTS idx_usage_stats_date ON usage_stats(date);

-- ============================================================================
-- CONTEXT DOCUMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_contexts (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    context_type TEXT NOT NULL,
    content TEXT,
    status TEXT DEFAULT 'draft',
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(project_id, context_type)
);

CREATE INDEX IF NOT EXISTS idx_project_contexts_project ON project_contexts(project_id);

-- ============================================================================
-- PROJECT WORKFLOWS (visual workflow definitions per project)
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_workflows (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'draft',
    current_stage TEXT,
    trigger_type TEXT DEFAULT 'manual',
    trigger_config TEXT DEFAULT '{}',    -- JSON
    graph_config TEXT DEFAULT '{}',      -- JSON (React Flow nodes/edges)
    stages TEXT DEFAULT '[]',           -- JSON array of workflow stages
    outputs TEXT DEFAULT '{}',          -- JSON object of stage outputs
    is_active INTEGER DEFAULT 1,        -- boolean
    last_run_at TEXT,
    run_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_workflows_project ON project_workflows(project_id);

-- ============================================================================
-- DASHBOARD INITIATIVES
-- ============================================================================

CREATE TABLE IF NOT EXISTS dashboard_initiatives (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'planning',
    priority TEXT DEFAULT 'medium',
    target_date TEXT,
    workflow_type TEXT,
    configuration TEXT DEFAULT '{}',     -- JSON
    target_projects TEXT DEFAULT '[]',   -- JSON array
    progress TEXT DEFAULT '{}',          -- JSON
    supervisor_status TEXT,
    supervisor_details TEXT,             -- JSON
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS initiative_project_status (
    id TEXT PRIMARY KEY,
    initiative_id TEXT REFERENCES dashboard_initiatives(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'not_started',
    notes TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(initiative_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_ips_initiative ON initiative_project_status(initiative_id);
CREATE INDEX IF NOT EXISTS idx_ips_project ON initiative_project_status(project_id);

-- ============================================================================
-- MODELS (AI model configuration and defaults)
-- ============================================================================

CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,        -- boolean
    is_default_for_task TEXT,           -- 'plan', 'research', 'implementation', 'quick', or NULL
    capabilities TEXT DEFAULT '{}',     -- JSON
    parameters TEXT DEFAULT '{}',       -- JSON
    sort_order INTEGER DEFAULT 0,
    family TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- MCP SERVER SCOPES
-- ============================================================================

CREATE TABLE IF NOT EXISTS mcp_server_scopes (
    id TEXT PRIMARY KEY,
    server_name TEXT NOT NULL UNIQUE,
    allowed_tools TEXT DEFAULT '[]',    -- JSON array
    denied_tools TEXT DEFAULT '[]',     -- JSON array
    is_enabled INTEGER DEFAULT 1,      -- boolean
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- API RATE LIMITING / QUOTAS
-- ============================================================================

CREATE TABLE IF NOT EXISTS usage_quotas (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT 'daily',
    max_requests INTEGER NOT NULL DEFAULT 1000,
    current_count INTEGER DEFAULT 0,
    reset_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(endpoint, period)
);

-- ============================================================================
-- AUDIT LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_audit_log (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor TEXT,
    target_type TEXT,
    target_id TEXT,
    details TEXT DEFAULT '{}',          -- JSON
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_action ON agent_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON agent_audit_log(created_at);

-- ============================================================================
-- EXECUTION TIMELINE & INLINE COMMENTS (server.js direct queries)
-- ============================================================================

CREATE TABLE IF NOT EXISTS execution_steps (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    feature_id TEXT,
    stage TEXT,
    step_type TEXT,
    title TEXT,
    description TEXT,
    status TEXT DEFAULT 'pending',
    output TEXT,
    duration_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_execution_steps_project ON execution_steps(project_id);
CREATE INDEX IF NOT EXISTS idx_execution_steps_feature ON execution_steps(feature_id);

CREATE TABLE IF NOT EXISTS inline_comments (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    feature_id TEXT,
    stage TEXT,
    selection_text TEXT,
    selection_start INTEGER,
    selection_end INTEGER,
    comment TEXT NOT NULL,
    resolved INTEGER DEFAULT 0,        -- boolean
    resolved_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inline_comments_project ON inline_comments(project_id);
CREATE INDEX IF NOT EXISTS idx_inline_comments_feature ON inline_comments(feature_id);

-- ============================================================================
-- WORKFLOW STATIC DATA (polling cursor persistence)
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_static_data (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    scope_key TEXT NOT NULL DEFAULT 'global',
    data TEXT DEFAULT '{}',             -- JSON
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(workflow_id, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_wsd_workflow ON workflow_static_data(workflow_id);

-- ============================================================================
-- DONE! Local SQLite database is ready.
-- ============================================================================
