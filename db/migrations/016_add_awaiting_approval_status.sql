-- ============================================================================
-- Migration 016: Add awaiting_approval status to tasks
-- Fixes: "new row for relation 'tasks' violates check constraint 'features_status_check'"
-- ============================================================================

-- Drop the old constraint (might be named features_status_check or tasks_status_check)
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS features_status_check;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;

-- Add updated constraint with awaiting_approval status
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN (
    'idea', 
    'researching', 
    'researched', 
    'awaiting_approval',  -- NEW: For human-in-the-loop approval gates
    'planning', 
    'planned',
    'implementing', 
    'testing', 
    'complete', 
    'rejected', 
    'cancelled'
));
