-- ============================================================================
-- Migration: Add 'task' level to workflow_templates
-- Created: 2026-01-03
-- Description: Adds 'task' as an alias for 'feature' level in workflow_templates
-- ============================================================================

-- Drop the existing check constraint
ALTER TABLE workflow_templates DROP CONSTRAINT IF EXISTS workflow_templates_level_check;

-- Add new check constraint that includes 'task'
ALTER TABLE workflow_templates ADD CONSTRAINT workflow_templates_level_check 
    CHECK (level IN ('dashboard', 'project', 'feature', 'task'));

-- Update any existing 'feature' level templates to 'task' for consistency
-- (Optional - uncomment if you want to migrate existing templates)
-- UPDATE workflow_templates SET level = 'task' WHERE level = 'feature';

-- ============================================================================
-- Migration Complete
-- ============================================================================
