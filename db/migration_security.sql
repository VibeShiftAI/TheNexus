-- ============================================================================
-- MIGRATION: SECURITY & RLS
-- Purpose: Add ownership to data and secure the database for specific users.
-- ============================================================================

-- 1. Add user_id to all main tables
DO $$ 
BEGIN
    -- Projects
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'user_id') THEN
        ALTER TABLE projects ADD COLUMN user_id UUID REFERENCES auth.users(id);
        CREATE INDEX idx_projects_user_id ON projects(user_id);
    END IF;

    -- Features
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'features' AND column_name = 'user_id') THEN
        ALTER TABLE features ADD COLUMN user_id UUID REFERENCES auth.users(id);
        CREATE INDEX idx_features_user_id ON features(user_id);
    END IF;

    -- Workflows
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workflows' AND column_name = 'user_id') THEN
        ALTER TABLE workflows ADD COLUMN user_id UUID REFERENCES auth.users(id);
        CREATE INDEX idx_workflows_user_id ON workflows(user_id);
    END IF;

    -- Runs
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'user_id') THEN
        ALTER TABLE runs ADD COLUMN user_id UUID REFERENCES auth.users(id);
        CREATE INDEX idx_runs_user_id ON runs(user_id);
    END IF;

    -- Scheduled Tasks
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scheduled_tasks' AND column_name = 'user_id') THEN
        ALTER TABLE scheduled_tasks ADD COLUMN user_id UUID REFERENCES auth.users(id);
        CREATE INDEX idx_scheduled_tasks_user_id ON scheduled_tasks(user_id);
    END IF;

    -- Agent Configs (Optional - mostly system, but good to have)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_configs' AND column_name = 'user_id') THEN
        ALTER TABLE agent_configs ADD COLUMN user_id UUID REFERENCES auth.users(id);
    END IF;
END $$;

-- 2. Drop existing "allow all" policies to clean up
DROP POLICY IF EXISTS "Allow all for service role" ON projects;
DROP POLICY IF EXISTS "Allow all for service role" ON features;
DROP POLICY IF EXISTS "Allow all for service role" ON workflows;
DROP POLICY IF EXISTS "Allow all for service role" ON runs;
DROP POLICY IF EXISTS "Allow all for service role" ON scheduled_tasks;
DROP POLICY IF EXISTS "Allow all for service role" ON execution_logs;
DROP POLICY IF EXISTS "Allow all for service role" ON agent_memories;
DROP POLICY IF EXISTS "Allow all for service role" ON checkpoints;
DROP POLICY IF EXISTS "Allow all for service role" ON usage_stats;

-- 3. Create RLS Policies
-- Strategy:
--  A. Service Role (backend/agents) has FULL ACCESS.
--  B. Authenticated Users can CRUD their OWN data (user_id = auth.uid()).
--  C. Authenticated Users can READ data where user_id IS NULL (Legacy/System data).

-- PROJECTS
CREATE POLICY "Users can manage their own projects" ON projects
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id OR user_id IS NULL)
    WITH CHECK (auth.uid() = user_id);

-- FEATURES
CREATE POLICY "Users can manage their own features" ON features
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id OR user_id IS NULL)
    WITH CHECK (auth.uid() = user_id);

-- WORKFLOWS
CREATE POLICY "Users can manage their own workflows" ON workflows
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id OR user_id IS NULL)
    WITH CHECK (auth.uid() = user_id);

-- RUNS
CREATE POLICY "Users can manage their own runs" ON runs
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id OR user_id IS NULL)
    WITH CHECK (auth.uid() = user_id);

-- CHECKPOINTS (System data, usually linked to runs, but lacks direct ownership often)
-- We'll allow authenticated users to read/write all checkpoints for now since they are granular machinery
CREATE POLICY "Authenticated users access checkpoints" ON checkpoints
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- SCHEDULED TASKS
CREATE POLICY "Users manage scheduled tasks" ON scheduled_tasks
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id OR user_id IS NULL)
    WITH CHECK (auth.uid() = user_id);

-- EXECUTION LOGS
CREATE POLICY "Users read execution logs" ON execution_logs
    FOR ALL
    TO authenticated
    USING (true) -- Logs are generally safe/system-wide for this single-tenant style app
    WITH CHECK (true);

-- AGENT MEMORIES
CREATE POLICY "Users read agent memories" ON agent_memories
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- AGENT CONFIGS
CREATE POLICY "Users read agent configs" ON agent_configs
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Users update agent configs" ON agent_configs
    FOR UPDATE
    TO authenticated
    USING (true);

-- USAGE STATS
CREATE POLICY "Users read usage stats" ON usage_stats
    FOR SELECT
    TO authenticated
    USING (true);

-- 4. Enable RLS (Redundant if already enabled, but safe)
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE features ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_stats ENABLE ROW LEVEL SECURITY;
