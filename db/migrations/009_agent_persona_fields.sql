-- ============================================================================
-- Migration: Extend agent_configs for Nexus Protocol Persona Forge
-- Created: 2025-12-29
-- Description: Adds new columns to agent_configs to support fields from
--              Persona Forge wizard while maintaining backward compatibility
-- ============================================================================

-- Domain (business, creative, productivity, coding, hr, legal, finance, travel)
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS domain TEXT;

-- Autonomy level determines interrupt behavior
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS autonomy_level TEXT 
CHECK (autonomy_level IN ('copilot', 'supervised', 'autonomous', 'autopilot'));

-- Primary goal/objective
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS primary_goal TEXT;

-- Secondary goals array
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS secondary_goals TEXT[];

-- Personality description and tone
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS personality_description TEXT;

ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS tone_of_voice TEXT;

-- Output format preference
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS output_format TEXT
CHECK (output_format IN ('markdown', 'json', 'yaml', 'xml', 'plain', 'structured'));

-- Output schema (for structured outputs)
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS output_schema JSONB;

-- Negative constraints (guardrails)
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS negative_constraints TEXT[];

-- MCP servers this agent can use
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS mcp_servers TEXT[];

-- Extended config blob for future fields (catch-all)
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}';

-- Is this agent a user-created agent vs system agent?
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS is_custom BOOLEAN DEFAULT FALSE;

-- Created timestamp (for user agents)
ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- ============================================================================
-- Create indexes for efficient filtering
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_agent_configs_domain ON agent_configs(domain);
CREATE INDEX IF NOT EXISTS idx_agent_configs_autonomy ON agent_configs(autonomy_level);
CREATE INDEX IF NOT EXISTS idx_agent_configs_custom ON agent_configs(is_custom);

-- ============================================================================
-- Migration Complete
-- ============================================================================
