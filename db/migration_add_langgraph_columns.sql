-- Add LangGraph tracking columns to features table
ALTER TABLE features 
ADD COLUMN IF NOT EXISTS langgraph_run_id TEXT,
ADD COLUMN IF NOT EXISTS langgraph_status TEXT,
ADD COLUMN IF NOT EXISTS langgraph_node TEXT,
ADD COLUMN IF NOT EXISTS langgraph_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS langgraph_updated_at TIMESTAMPTZ;

-- Add index for status polling
CREATE INDEX IF NOT EXISTS idx_features_langgraph_run_id ON features(langgraph_run_id);
