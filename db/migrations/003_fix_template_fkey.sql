-- ============================================================================
-- Migration: Fix template_id foreign key in project_workflows
-- Created: 2025-12-26
-- Description: Corrects the foreign key reference from workflows to workflow_templates
-- ============================================================================

-- Drop the incorrect foreign key constraint
ALTER TABLE project_workflows 
DROP CONSTRAINT IF EXISTS project_workflows_template_id_fkey;

-- Add the correct foreign key constraint referencing workflow_templates
ALTER TABLE project_workflows
ADD CONSTRAINT project_workflows_template_id_fkey 
FOREIGN KEY (template_id) REFERENCES workflow_templates(id) ON DELETE SET NULL;

-- ============================================================================
-- Migration Complete
-- ============================================================================
