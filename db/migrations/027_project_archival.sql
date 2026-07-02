-- ============================================================================
-- Migration 027: Project Archival
--
-- Adds the columns needed to archive a project and its tasks reversibly.
-- Archiving is a soft, DB-only operation — project files on disk are never
-- touched. Archived projects/tasks drop out of the dashboard and out of the
-- context-retrieval paths that feed project data to the AI for analysis.
--
--   - projects.status = 'archived' already supported (migration 024). We add a
--     timestamp column to record when the project was archived.
--   - tasks.archived_at: when the task was archived (NULL = not archived).
--   - tasks.pre_archive_status: the task's status before archival, so it can be
--     restored on unarchive.
--
-- NOTE: db/index.js applies these same ALTERs idempotently on startup, so this
-- file is primarily documentation / for fresh manual migration runs.
-- ============================================================================

ALTER TABLE projects ADD COLUMN archived_at TEXT;
ALTER TABLE tasks ADD COLUMN archived_at TEXT;
ALTER TABLE tasks ADD COLUMN pre_archive_status TEXT;

-- Speed up "is this project archived" filtering already covered by idx_projects_status
-- (migration 024). Index archived tasks for the same reason suspended tasks are indexed.
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(status) WHERE status = 'archived';
