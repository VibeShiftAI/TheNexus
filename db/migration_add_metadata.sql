-- Add feedback and metadata columns to features table
-- Run this in the Supabase SQL Editor

ALTER TABLE features 
ADD COLUMN IF NOT EXISTS feedback JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Optional: Create index for JSONB columns if frequent querying is expected inside them
-- CREATE INDEX IF NOT EXISTS idx_features_feedback ON features USING GIN (feedback);
