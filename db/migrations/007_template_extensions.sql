-- ============================================================================
-- Migration: Nexus Protocol Template Extensions
-- Created: 2025-12-29
-- Description: Adds additional queryable columns to agent_templates table
--              to support efficient filtering and searching
-- ============================================================================

-- First ensure the agent_templates table exists (from migration 006)
CREATE TABLE IF NOT EXISTS agent_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    domain TEXT NOT NULL CHECK (domain IN ('business', 'creative', 'productivity', 'coding', 'hr', 'legal', 'finance', 'travel')),
    graph_pattern TEXT,
    config JSONB NOT NULL DEFAULT '{}',
    preview_image TEXT,
    is_featured BOOLEAN DEFAULT FALSE,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add icon column for display
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'agent_templates' AND column_name = 'icon') THEN
        ALTER TABLE agent_templates ADD COLUMN icon TEXT DEFAULT '🤖';
    END IF;
END $$;

-- Add autonomy_level for filtering by control level
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'agent_templates' AND column_name = 'autonomy_level') THEN
        ALTER TABLE agent_templates ADD COLUMN autonomy_level TEXT DEFAULT 'supervised'
            CHECK (autonomy_level IN ('copilot', 'supervised', 'autonomous', 'autopilot'));
    END IF;
END $$;

-- Add mcp_servers as array for filtering by required tools
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'agent_templates' AND column_name = 'mcp_servers') THEN
        ALTER TABLE agent_templates ADD COLUMN mcp_servers TEXT[] DEFAULT '{}';
    END IF;
END $$;

-- Add recursion_limit for safety configuration
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'agent_templates' AND column_name = 'recursion_limit') THEN
        ALTER TABLE agent_templates ADD COLUMN recursion_limit INTEGER DEFAULT 25;
    END IF;
END $$;

-- Add checkpointer type configuration
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'agent_templates' AND column_name = 'checkpointer') THEN
        ALTER TABLE agent_templates ADD COLUMN checkpointer TEXT DEFAULT 'memory'
            CHECK (checkpointer IN ('memory', 'sqlite', 'postgres'));
    END IF;
END $$;

-- Add interrupt_nodes for human-in-the-loop configuration
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'agent_templates' AND column_name = 'interrupt_nodes') THEN
        ALTER TABLE agent_templates ADD COLUMN interrupt_nodes TEXT[] DEFAULT '{}';
    END IF;
END $$;

-- Add system_prompt for direct access (also in config, but useful for search)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'agent_templates' AND column_name = 'system_prompt') THEN
        ALTER TABLE agent_templates ADD COLUMN system_prompt TEXT;
    END IF;
END $$;

-- Add negative_constraints array for guardrails
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'agent_templates' AND column_name = 'negative_constraints') THEN
        ALTER TABLE agent_templates ADD COLUMN negative_constraints TEXT[] DEFAULT '{}';
    END IF;
END $$;

-- Add output_format for filtering by deliverable type
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'agent_templates' AND column_name = 'output_format') THEN
        ALTER TABLE agent_templates ADD COLUMN output_format TEXT DEFAULT 'json'
            CHECK (output_format IN ('json', 'markdown', 'csv', 'slack', 'email', 'pdf'));
    END IF;
END $$;

-- Create indexes for common filter patterns
CREATE INDEX IF NOT EXISTS idx_agent_templates_autonomy ON agent_templates(autonomy_level);
CREATE INDEX IF NOT EXISTS idx_agent_templates_pattern ON agent_templates(graph_pattern);
CREATE INDEX IF NOT EXISTS idx_agent_templates_output ON agent_templates(output_format);

-- GIN index for array containment queries (e.g., finding templates that use 'github' MCP)
CREATE INDEX IF NOT EXISTS idx_agent_templates_mcp_gin ON agent_templates USING GIN (mcp_servers);

-- ============================================================================
-- Migration Complete
-- ============================================================================
