-- ============================================================================
-- Migration: Nexus Protocol Schema Extensions
-- Created: 2025-12-29
-- Description: Adds tables and columns to support The Nexus Protocol
--              Agent Designer with MCP tool binding and enhanced workflows
-- ============================================================================

-- MCP Server configurations for dynamic tool discovery
CREATE TABLE IF NOT EXISTS mcp_servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    url TEXT NOT NULL,
    transport TEXT NOT NULL CHECK (transport IN ('stdio', 'sse')),
    command TEXT,  -- For stdio: command to run
    args JSONB DEFAULT '[]',  -- Command arguments
    env_vars JSONB DEFAULT '{}',  -- Environment variables (secrets resolved at runtime)
    capabilities JSONB DEFAULT '[]',  -- Cached tool list from server
    status TEXT DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected', 'error')),
    last_connected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent templates for the Template Gallery
CREATE TABLE IF NOT EXISTS agent_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    domain TEXT NOT NULL CHECK (domain IN ('business', 'creative', 'productivity', 'coding', 'hr', 'legal', 'finance', 'travel')),
    graph_pattern TEXT,  -- e.g., 'evaluator-optimizer', 'human-in-the-loop', 'router-fan-out'
    config JSONB NOT NULL,  -- The complete nexus_agent.json content
    preview_image TEXT,  -- URL to template preview image
    is_featured BOOLEAN DEFAULT FALSE,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Extend workflow_templates with Nexus Protocol fields
DO $$ 
BEGIN
    -- Recursion limit for safety valves
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'workflow_templates' AND column_name = 'recursion_limit') THEN
        ALTER TABLE workflow_templates ADD COLUMN recursion_limit INTEGER DEFAULT 25;
    END IF;
    
    -- Interrupt nodes for human-in-the-loop approval
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'workflow_templates' AND column_name = 'interrupt_nodes') THEN
        ALTER TABLE workflow_templates ADD COLUMN interrupt_nodes TEXT[] DEFAULT '{}';
    END IF;
    
    -- Checkpointer type for persistence
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'workflow_templates' AND column_name = 'checkpointer') THEN
        ALTER TABLE workflow_templates ADD COLUMN checkpointer TEXT DEFAULT 'memory'
            CHECK (checkpointer IN ('memory', 'sqlite', 'postgres'));
    END IF;
    
    -- Custom state schema fields
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'workflow_templates' AND column_name = 'custom_state_schema') THEN
        ALTER TABLE workflow_templates ADD COLUMN custom_state_schema JSONB DEFAULT '{}';
    END IF;
    
    -- Output schema for structured deliverables
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'workflow_templates' AND column_name = 'output_schema') THEN
        ALTER TABLE workflow_templates ADD COLUMN output_schema JSONB;
    END IF;
    
    -- Negative constraints (guardrails)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'workflow_templates' AND column_name = 'negative_constraints') THEN
        ALTER TABLE workflow_templates ADD COLUMN negative_constraints TEXT[] DEFAULT '{}';
    END IF;
    
    -- MCP server bindings
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'workflow_templates' AND column_name = 'mcp_servers') THEN
        ALTER TABLE workflow_templates ADD COLUMN mcp_servers JSONB DEFAULT '{}';
    END IF;
    
    -- Autonomy level
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'workflow_templates' AND column_name = 'autonomy_level') THEN
        ALTER TABLE workflow_templates ADD COLUMN autonomy_level TEXT DEFAULT 'supervised'
            CHECK (autonomy_level IN ('copilot', 'supervised', 'autonomous', 'autopilot'));
    END IF;
    
    -- Domain categorization
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'workflow_templates' AND column_name = 'domain') THEN
        ALTER TABLE workflow_templates ADD COLUMN domain TEXT DEFAULT 'productivity';
    END IF;
END $$;

-- Create index for domain filtering in template gallery
CREATE INDEX IF NOT EXISTS idx_agent_templates_domain ON agent_templates(domain);
CREATE INDEX IF NOT EXISTS idx_agent_templates_featured ON agent_templates(is_featured) WHERE is_featured = TRUE;

-- ============================================================================
-- Migration Complete
-- ============================================================================
