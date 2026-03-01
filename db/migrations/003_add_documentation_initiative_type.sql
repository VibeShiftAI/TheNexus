-- Migration: Remove restrictive CHECK constraints
-- Allow any workflow_type string so new types don't require migrations.

ALTER TABLE dashboard_initiatives 
    DROP CONSTRAINT IF EXISTS dashboard_initiatives_workflow_type_check;

ALTER TABLE project_workflows 
    DROP CONSTRAINT IF EXISTS project_workflows_workflow_type_check;
