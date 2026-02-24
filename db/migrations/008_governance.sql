-- ============================================================================
-- Migration: Governance & Audit Tables
-- Created: 2025-12-29
-- Description: Adds tables for rate limiting, usage quotas, and audit logging
-- ============================================================================

-- Usage quotas per user/project for rate limiting
CREATE TABLE IF NOT EXISTS usage_quotas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Can be scoped to user, project, or global
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    project_id UUID,
    
    -- Daily/monthly limits
    daily_token_limit INTEGER DEFAULT 100000,
    monthly_token_limit INTEGER DEFAULT 3000000,
    daily_request_limit INTEGER DEFAULT 500,
    monthly_request_limit INTEGER DEFAULT 15000,
    
    -- Current usage (reset by cron job)
    daily_tokens_used INTEGER DEFAULT 0,
    monthly_tokens_used INTEGER DEFAULT 0,
    daily_requests_used INTEGER DEFAULT 0,
    monthly_requests_used INTEGER DEFAULT 0,
    
    -- Cost limits
    daily_cost_limit DECIMAL(10,4) DEFAULT 10.00,
    monthly_cost_limit DECIMAL(10,4) DEFAULT 100.00,
    daily_cost_used DECIMAL(10,4) DEFAULT 0,
    monthly_cost_used DECIMAL(10,4) DEFAULT 0,
    
    -- Reset timestamps
    daily_reset_at TIMESTAMPTZ DEFAULT NOW(),
    monthly_reset_at TIMESTAMPTZ DEFAULT NOW(),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- MCP server OAuth scopes and permissions
CREATE TABLE IF NOT EXISTS mcp_server_scopes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mcp_server_id UUID NOT NULL,
    
    -- Scope definitions
    scope_name TEXT NOT NULL,  -- e.g., 'github:read', 'gmail:send'
    description TEXT,
    is_dangerous BOOLEAN DEFAULT FALSE,  -- Requires extra approval
    requires_confirmation BOOLEAN DEFAULT FALSE,  -- Per-action confirmation
    
    -- Rate limits specific to this scope
    max_calls_per_minute INTEGER DEFAULT 60,
    max_calls_per_hour INTEGER DEFAULT 1000,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit log for all agent actions
CREATE TABLE IF NOT EXISTS agent_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Context
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    project_id UUID,
    workflow_id UUID,
    agent_id TEXT,
    
    -- Action details
    action_type TEXT NOT NULL,  -- 'tool_call', 'llm_request', 'state_change', 'error'
    action_name TEXT,           -- e.g., 'github_create_issue', 'gemini-2.5-flash'
    mcp_server TEXT,
    
    -- Request/Response
    input_summary TEXT,         -- Truncated input for privacy
    output_summary TEXT,        -- Truncated output
    
    -- Metrics
    tokens_used INTEGER DEFAULT 0,
    cost DECIMAL(10,6) DEFAULT 0,
    duration_ms INTEGER,
    
    -- Status
    status TEXT DEFAULT 'success' CHECK (status IN ('success', 'error', 'blocked', 'rate_limited')),
    error_message TEXT,
    
    -- Flags
    was_human_approved BOOLEAN DEFAULT FALSE,
    was_rate_limited BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_usage_quotas_user ON usage_quotas(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_quotas_project ON usage_quotas(project_id);
CREATE INDEX IF NOT EXISTS idx_mcp_scopes_server ON mcp_server_scopes(mcp_server_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON agent_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_project ON agent_audit_log(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON agent_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON agent_audit_log(action_type, action_name);

-- ============================================================================
-- Migration Complete
-- ============================================================================
