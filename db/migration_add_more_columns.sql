-- Add remaining missing columns to features table
ALTER TABLE features 
ADD COLUMN IF NOT EXISTS langgraph_template TEXT,
ADD COLUMN IF NOT EXISTS critic_feedback TEXT;
