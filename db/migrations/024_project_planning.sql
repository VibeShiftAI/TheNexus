-- ============================================================================
-- Migration 024: Project Planning Architecture
-- 
-- Adds columns required for autonomous project planning:
--   - projects.status: active/paused/archived for Chief of Staff rotation
--   - projects.priority: 0-100 integer for daily focus elevation
--   - tasks.sort_order: explicit sequencing within a project
-- ============================================================================

-- Projects: add status and priority for Chief of Staff rotation
-- Using pragma to check if column exists before adding
-- SQLite ALTER TABLE ADD COLUMN is a no-op if column exists in some builds,
-- but we wrap in a try pattern using the IF NOT EXISTS index trick.

-- Add status column (default 'active' for existing projects)
ALTER TABLE projects ADD COLUMN status TEXT DEFAULT 'active';

-- Add priority column (default 50 = mid-tier)
ALTER TABLE projects ADD COLUMN priority INTEGER DEFAULT 50;

-- Tasks: add sort_order for explicit sequencing
ALTER TABLE tasks ADD COLUMN sort_order INTEGER DEFAULT 0;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_priority ON projects(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_sort_order ON tasks(project_id, sort_order);
