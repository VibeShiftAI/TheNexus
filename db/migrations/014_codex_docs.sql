-- Create codex_docs table
CREATE TABLE IF NOT EXISTS codex_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL, -- Markdown content
  category TEXT NOT NULL CHECK (category IN ('Protocol', 'Pattern', 'Workflow', 'Guide', 'API')),
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE codex_docs ENABLE ROW LEVEL SECURITY;

-- Create policy for public read access (for now, assuming internal dashboard usage)
CREATE POLICY "Enable read access for all users" ON codex_docs
    FOR SELECT
    USING (true);

-- Create policy for insert/update (restrict to service role or authenticated users if auth is set up)
-- For development simplicity we'll allow anon/all for now or rely on service role
CREATE POLICY "Enable write access for all users" ON codex_docs
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Insert seed data for existing sections
INSERT INTO codex_docs (slug, title, content, category, tags) VALUES
(
  'primary-vibecoding-workflow',
  'Primary Vibecoding Workflow',
  '# Primary Vibecoding Workflow\n\nThis workflow details the interaction between the User, Nexus Prime, and the specialized Agent Fleets.\n\n<VibecodingWorkflowDiagram />',
  'Workflow',
  ARRAY['architecture', 'core']
),
(
  'protocol-specs',
  'Nexus Agent Protocol',
  '# Nexus Agent Protocol\n\nThe Nexus Protocol defines how agents communicate, register capabilities, and handle state handoffs.\n\n## Core Concepts\n- **GraphEngine**: The execution runtime\n- **Registry**: Dynamic agent discovery\n- **ArtifactVault**: Shared persistent storage',
  'Protocol',
  ARRAY['api', 'spec']
),
(
  'pattern-library',
  'UI Pattern Library',
  '# UI Pattern Library\n\nReusable components and design tokens for the Nexus Dashboard.\n\n## Components\n- Glassmorphic Cards\n- Neon Badges\n- Terminal Interfaces',
  'Pattern',
  ARRAY['ui', 'design']
)
ON CONFLICT (slug) DO NOTHING;
