-- ============================================================================
-- Migration 018: Consolidate workflows into workflow_templates
-- Migrates all template workflows from 'workflows' table into 'workflow_templates'
-- ============================================================================

-- Insert workflows (is_template=true) into workflow_templates
-- Mapping:
--   workflows.id -> workflow_templates.id
--   workflows.name -> workflow_templates.name
--   workflows.description -> workflow_templates.description
--   workflows.graph_config->>'category' -> workflow_templates.level (default 'task')
--   workflows.graph_config->>'templateId' -> workflow_templates.workflow_type (or derive from name)
--   workflows.graph_config (nodes/edges) -> workflow_templates.default_configuration
--   workflows.is_template -> workflow_templates.is_system (true for all)
--   workflows.created_at -> workflow_templates.created_at
--   workflows.updated_at -> workflow_templates.updated_at

INSERT INTO workflow_templates (
    id,
    name,
    description,
    level,
    workflow_type,
    stages,
    default_configuration,
    is_system,
    created_at,
    updated_at
)
SELECT 
    w.id,
    w.name,
    w.description,
    -- Map category to allowed level values: dashboard, project, feature, task
    CASE 
        WHEN w.graph_config->>'level' IN ('dashboard', 'project', 'feature', 'task') THEN w.graph_config->>'level'
        WHEN w.graph_config->>'category' IN ('dashboard', 'project', 'feature', 'task') THEN w.graph_config->>'category'
        ELSE 'task'  -- Default to 'task' for unknown categories like 'standard', 'fast', 'research', etc.
    END as level,
    COALESCE(
        w.graph_config->>'templateId',
        w.graph_config->>'workflow_type',
        LOWER(REPLACE(w.name, ' ', '-'))
    ) as workflow_type,
    -- Convert nodes array to stages format if present
    COALESCE(
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', node->>'id',
                    'name', COALESCE(node->'data'->>'label', node->>'type'),
                    'description', '',
                    'agentId', node->>'type',
                    'order', row_number
                )
            )
            FROM (
                SELECT node, ROW_NUMBER() OVER () as row_number
                FROM jsonb_array_elements(w.graph_config->'nodes') as node
            ) numbered_nodes
        ),
        '[]'::jsonb
    ) as stages,
    -- Store full graph config as default_configuration for reference
    jsonb_build_object(
        'nodes', COALESCE(w.graph_config->'nodes', '[]'::jsonb),
        'edges', COALESCE(w.graph_config->'edges', '[]'::jsonb),
        'conditionalEdges', COALESCE(w.graph_config->'conditionalEdges', '[]'::jsonb)
    ) as default_configuration,
    true as is_system,
    COALESCE(w.created_at, NOW()) as created_at,
    COALESCE(w.updated_at, NOW()) as updated_at
FROM workflows w
WHERE w.is_template = true
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    level = EXCLUDED.level,
    workflow_type = EXCLUDED.workflow_type,
    stages = EXCLUDED.stages,
    default_configuration = EXCLUDED.default_configuration,
    is_system = EXCLUDED.is_system,
    updated_at = NOW();

-- Verify migration
-- SELECT id, name, workflow_type, level FROM workflow_templates ORDER BY name;

-- ============================================================================
-- After verifying the migration worked, you can optionally:
-- 1. Delete templates from workflows table:
--    DELETE FROM workflows WHERE is_template = true;
-- 2. Or drop is_template column entirely if no longer needed
-- ============================================================================
