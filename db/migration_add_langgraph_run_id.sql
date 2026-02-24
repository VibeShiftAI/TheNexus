
-- Add langgraph_run_id column to features table
ALTER TABLE features 
ADD COLUMN IF NOT EXISTS langgraph_run_id UUID;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_features_langgraph_run_id ON features (langgraph_run_id);
