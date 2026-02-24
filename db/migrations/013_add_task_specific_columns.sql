-- Add specific columns to tasks table for better data organization
-- Replaces generic 'metadata' usage with structured columns

-- 1. initiative_validation: Stores JSON result from validateInitiative
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS initiative_validation JSONB DEFAULT NULL;

-- 2. research_metadata: Stores auxiliary research data (timestamps, mode, etc.)
-- Content still goes in 'research_output'
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS research_metadata JSONB DEFAULT NULL;

-- 3. plan_metadata: Stores auxiliary plan data (timestamps, approval info)
-- Content still goes in 'plan_output' (or 'spec_output' depending on usage, usually plan_output for implementation plan)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_metadata JSONB DEFAULT NULL;

-- 4. source: Where did this task come from? (e.g. 'user', 'failure_analysis', 'auto_research')
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'user';

-- 5. metadata: Fallback for any other dynamic data
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Add comment explaining the columns
COMMENT ON COLUMN tasks.initiative_validation IS 'JSON: { classification, confidence, reasoning, requiresClarification }';
COMMENT ON COLUMN tasks.research_metadata IS 'JSON: { generatedAt, mode, feedback, ... }';
COMMENT ON COLUMN tasks.plan_metadata IS 'JSON: { generatedAt, feedback, approvedAt, ... }';
