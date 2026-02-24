-- Rename features table to tasks
ALTER TABLE IF EXISTS features RENAME TO tasks;

-- Rename sequences if they exist (Postgres usually handles this, but good to be explicit if custom)
-- ALTER SEQUENCE IF EXISTS features_id_seq RENAME TO tasks_id_seq;

-- Rename indexes
ALTER INDEX IF EXISTS features_pkey RENAME TO tasks_pkey;
ALTER INDEX IF EXISTS idx_features_project RENAME TO idx_tasks_project;
ALTER INDEX IF EXISTS idx_features_status RENAME TO idx_tasks_status;

-- Rename foreign key constraints
-- Note: You might need to drop and re-create if your DB doesn't support renaming constraints easily, 
-- but Postgres often allows renaming or just works with the new table name. 
-- However, for clarity, let's try to rename if possible, or just leave them pointing to 'tasks'.
-- If you need to rename the constraint name explicitly:
-- ALTER TABLE tasks RENAME CONSTRAINT features_project_id_fkey TO tasks_project_id_fkey;

-- Rename columns in other tables that reference features
-- Table: works (or tracks, depending on schema version)
DO $$
BEGIN
    IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'tracks' AND column_name = 'feature_id') THEN
        ALTER TABLE tracks RENAME COLUMN feature_id TO task_id;
    END IF;
END $$;

-- Table: feature_runs / langgraph_runs
DO $$
BEGIN
    IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'feature_id') THEN
        ALTER TABLE runs RENAME COLUMN feature_id TO task_id;
    END IF;
END $$;

-- Update projects table column if it exists
DO $$
BEGIN
    IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'features_list') THEN
        ALTER TABLE projects RENAME COLUMN features_list TO tasks_list;
    END IF;
END $$;

-- Add a comment to the table
COMMENT ON TABLE tasks IS 'Stores project tasks (formerly features)';
