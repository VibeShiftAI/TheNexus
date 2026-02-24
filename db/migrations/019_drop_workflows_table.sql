-- ============================================================================
-- Migration 019: Drop workflows table (consolidated into workflow_templates)
-- This will cause legacy code to fail immediately if it tries to access it
-- ============================================================================

-- First, drop the foreign key constraint from runs table
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_workflow_id_fkey;

-- Drop the column entirely since it's no longer meaningful
-- (workflow_templates uses a different approach)
ALTER TABLE runs DROP COLUMN IF EXISTS workflow_id;

-- Now drop the workflows table
DROP TABLE IF EXISTS workflows CASCADE;

-- ============================================================================
-- After this migration:
-- - Any code trying to access 'workflows' table will fail with "relation does not exist"
-- - All templates are now in 'workflow_templates' table
-- - Runs no longer reference workflows (they track state in 'context' JSONB)
-- ============================================================================
