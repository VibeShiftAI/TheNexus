-- ============================================================================
-- Migration 023: Dual-Payload Task Structure
-- Adds antigravity_payload and dependencies columns to the tasks table.
-- Enables Praxis to generate machine-readable execution payloads alongside
-- human-readable task descriptions, and to define task sequencing.
-- ============================================================================

-- The machine layer: hyper-specific prompt, target files, context, commands,
-- and acceptance criteria that AntiGravity needs to execute the task safely.
-- Stored as JSON TEXT.
ALTER TABLE tasks ADD COLUMN antigravity_payload TEXT;

-- Task dependency graph: JSON array of task IDs that must have status='complete'
-- before this task is considered unblocked.
-- Example: ["task-uuid-1", "task-uuid-2"]
ALTER TABLE tasks ADD COLUMN dependencies TEXT DEFAULT '[]';

-- Index for efficient board state queries (unblocked task lookups)
CREATE INDEX IF NOT EXISTS idx_tasks_dependencies ON tasks(dependencies);
