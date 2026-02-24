-- Drop the existing check constraint
ALTER TABLE project_contexts DROP CONSTRAINT IF EXISTS project_contexts_context_type_check;

-- Add the new check constraint with all allowed types
ALTER TABLE project_contexts ADD CONSTRAINT project_contexts_context_type_check 
CHECK (context_type IN (
    'product', 
    'product-guidelines', 
    'tech-stack', 
    'workflow', 
    'other',
    'context_map',
    'database-schema',
    'dashboard-workflow-map',
    'project-workflow-map',
    'task-pipeline-map',
    'function_map'
));
