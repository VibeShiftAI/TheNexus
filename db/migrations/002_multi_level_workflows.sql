-- ============================================================================
-- Migration: Multi-Level Workflow System
-- Created: 2025-12-26
-- Description: Adds tables for Dashboard Initiatives and Project Workflows
-- ============================================================================

-- Dashboard-level initiatives (cross-project workflows)
CREATE TABLE IF NOT EXISTS dashboard_initiatives (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    description TEXT,
    workflow_type TEXT NOT NULL CHECK (workflow_type IN (
        'security-sweep', 'dependency-audit', 'readme-update', 'api-migration', 
        'health-check', 'custom'
    )),
    status TEXT DEFAULT 'idea' CHECK (status IN (
        'idea', 'planning', 'in_progress', 'paused', 'complete', 'cancelled'
    )),
    configuration JSONB DEFAULT '{}', -- Workflow-specific settings
    target_projects UUID[], -- Array of project IDs this initiative targets
    progress JSONB DEFAULT '{}', -- Aggregate progress tracking
    supervisor_status TEXT, -- Current supervisor state
    supervisor_details JSONB, -- Supervisor metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project-level workflows (project-wide, not tied to features)
CREATE TABLE IF NOT EXISTS project_workflows (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    workflow_type TEXT NOT NULL CHECK (workflow_type IN (
        'brand-development', 'logo-development', 'documentation', 
        'release', 'custom'
    )),
    status TEXT DEFAULT 'idea' CHECK (status IN (
        'idea', 'planning', 'in_progress', 'review', 'complete', 'cancelled'
    )),
    current_stage TEXT, -- Current stage in the workflow
    stages JSONB DEFAULT '[]', -- Array of stage definitions
    template_id UUID, -- Optional reference to workflow template (FK added after workflow_templates table creation)
    configuration JSONB DEFAULT '{}', -- Workflow-specific config
    outputs JSONB DEFAULT '{}', -- Store workflow outputs (logos, brand assets, etc.)
    supervisor_status TEXT,
    supervisor_details JSONB,
    parent_initiative_id UUID REFERENCES dashboard_initiatives(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Link table for initiative-to-project relationship (detailed progress tracking)
CREATE TABLE IF NOT EXISTS initiative_project_status (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    initiative_id UUID REFERENCES dashboard_initiatives(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending' CHECK (status IN (
        'pending', 'in_progress', 'complete', 'skipped', 'failed'
    )),
    spawned_workflow_id UUID REFERENCES project_workflows(id) ON DELETE SET NULL,
    spawned_feature_ids UUID[], -- Features created by this initiative in this project
    result JSONB DEFAULT '{}', -- Results from the initiative run
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    UNIQUE(initiative_id, project_id)
);

-- Workflow templates (predefined workflow patterns)
CREATE TABLE IF NOT EXISTS workflow_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    level TEXT NOT NULL CHECK (level IN ('dashboard', 'project', 'feature')),
    workflow_type TEXT NOT NULL,
    stages JSONB NOT NULL DEFAULT '[]', -- Array of {id, name, description, agentId, order}
    default_configuration JSONB DEFAULT '{}',
    is_system BOOLEAN DEFAULT FALSE, -- System templates can't be deleted
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_dashboard_initiatives_status ON dashboard_initiatives(status);
CREATE INDEX IF NOT EXISTS idx_project_workflows_project ON project_workflows(project_id);
CREATE INDEX IF NOT EXISTS idx_project_workflows_status ON project_workflows(status);
CREATE INDEX IF NOT EXISTS idx_project_workflows_parent ON project_workflows(parent_initiative_id);
CREATE INDEX IF NOT EXISTS idx_initiative_project_status_initiative ON initiative_project_status(initiative_id);
CREATE INDEX IF NOT EXISTS idx_initiative_project_status_project ON initiative_project_status(project_id);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_level ON workflow_templates(level);

-- Triggers for auto-updating timestamps
DROP TRIGGER IF EXISTS tr_dashboard_initiatives_updated_at ON dashboard_initiatives;
CREATE TRIGGER tr_dashboard_initiatives_updated_at
    BEFORE UPDATE ON dashboard_initiatives FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS tr_project_workflows_updated_at ON project_workflows;
CREATE TRIGGER tr_project_workflows_updated_at
    BEFORE UPDATE ON project_workflows FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS tr_workflow_templates_updated_at ON workflow_templates;
CREATE TRIGGER tr_workflow_templates_updated_at
    BEFORE UPDATE ON workflow_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Enable RLS
ALTER TABLE dashboard_initiatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE initiative_project_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_templates ENABLE ROW LEVEL SECURITY;

-- Policies (allow all for service role - same as other tables)
CREATE POLICY "Allow all for service role" ON dashboard_initiatives FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON project_workflows FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON initiative_project_status FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON workflow_templates FOR ALL USING (true);

-- Insert system workflow templates
INSERT INTO workflow_templates (name, description, level, workflow_type, stages, is_system) VALUES
-- Dashboard-level templates
('Security Sweep', 'Run security audits across all targeted projects', 'dashboard', 'security-sweep', 
 '[{"id": "audit-deps", "name": "Audit Dependencies", "description": "Run npm audit on all projects", "order": 1},
   {"id": "check-secrets", "name": "Check Secrets", "description": "Scan for exposed secrets or API keys", "order": 2},
   {"id": "review-perms", "name": "Review Permissions", "description": "Check file and API permissions", "order": 3},
   {"id": "generate-report", "name": "Generate Report", "description": "Compile security report", "order": 4}]'::jsonb, true),

('Dependency Audit', 'Check for outdated and vulnerable dependencies', 'dashboard', 'dependency-audit',
 '[{"id": "npm-audit", "name": "NPM Audit", "description": "Run npm audit for vulnerabilities", "order": 1},
   {"id": "check-outdated", "name": "Check Outdated", "description": "Find outdated packages", "order": 2},
   {"id": "propose-updates", "name": "Propose Updates", "description": "Generate update plan", "order": 3},
   {"id": "apply-updates", "name": "Apply Updates", "description": "Apply approved updates", "order": 4}]'::jsonb, true),

('README Update', 'Update README files across all projects', 'dashboard', 'readme-update',
 '[{"id": "analyze", "name": "Analyze READMEs", "description": "Check current README status", "order": 1},
   {"id": "generate", "name": "Generate Updates", "description": "AI-generate README improvements", "order": 2},
   {"id": "review", "name": "Review Changes", "description": "Human review of proposed changes", "order": 3},
   {"id": "apply", "name": "Apply Changes", "description": "Commit README updates", "order": 4}]'::jsonb, true),

('Monthly Health Check', 'Regular maintenance check across projects', 'dashboard', 'health-check',
 '[{"id": "check-tests", "name": "Check Tests", "description": "Verify test suites are passing", "order": 1},
   {"id": "check-coverage", "name": "Check Coverage", "description": "Review code coverage", "order": 2},
   {"id": "check-docs", "name": "Check Docs", "description": "Verify documentation is current", "order": 3},
   {"id": "summarize", "name": "Summarize", "description": "Generate health report", "order": 4}]'::jsonb, true),

-- Project-level templates
('Brand Development', 'Develop project branding from concept to guidelines', 'project', 'brand-development',
 '[{"id": "discover", "name": "Discovery", "description": "Define brand values and target audience", "order": 1},
   {"id": "concepts", "name": "Concepts", "description": "Generate initial brand concepts", "order": 2},
   {"id": "logo-design", "name": "Logo Design", "description": "Design and refine logo", "order": 3},
   {"id": "color-palette", "name": "Color Palette", "description": "Define brand colors", "order": 4},
   {"id": "typography", "name": "Typography", "description": "Select brand fonts", "order": 5},
   {"id": "guidelines", "name": "Brand Guidelines", "description": "Compile brand guidelines document", "order": 6}]'::jsonb, true),

('Logo Development', 'Design and refine project logo', 'project', 'logo-development',
 '[{"id": "brief", "name": "Creative Brief", "description": "Define logo requirements", "order": 1},
   {"id": "concepts", "name": "Concepts", "description": "Generate logo concepts", "order": 2},
   {"id": "refinement", "name": "Refinement", "description": "Refine selected concept", "order": 3},
   {"id": "finalization", "name": "Finalization", "description": "Finalize logo design", "order": 4},
   {"id": "export", "name": "Export Assets", "description": "Export logo in all required formats", "order": 5}]'::jsonb, true),

('Documentation', 'Create comprehensive project documentation', 'project', 'documentation',
 '[{"id": "readme", "name": "README", "description": "Create or update README", "order": 1},
   {"id": "api-docs", "name": "API Docs", "description": "Generate API documentation", "order": 2},
   {"id": "user-guide", "name": "User Guide", "description": "Create user guide", "order": 3},
   {"id": "contributing", "name": "Contributing", "description": "Write contributing guidelines", "order": 4}]'::jsonb, true),

('Release Workflow', 'Prepare and execute a release', 'project', 'release',
 '[{"id": "changelog", "name": "Changelog", "description": "Generate changelog from commits", "order": 1},
   {"id": "version-bump", "name": "Version Bump", "description": "Update version numbers", "order": 2},
   {"id": "build", "name": "Build", "description": "Create production build", "order": 3},
   {"id": "deploy", "name": "Deploy", "description": "Deploy to production", "order": 4},
   {"id": "announce", "name": "Announce", "description": "Announce release", "order": 5}]'::jsonb, true)

ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- Migration Complete
-- ============================================================================
