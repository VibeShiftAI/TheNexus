-- Add max_turns and thinking_budget columns to agent_configs table
-- Run this in the Supabase SQL Editor

ALTER TABLE agent_configs
ADD COLUMN IF NOT EXISTS max_turns INTEGER DEFAULT 50,
ADD COLUMN IF NOT EXISTS thinking_budget INTEGER DEFAULT 0;
