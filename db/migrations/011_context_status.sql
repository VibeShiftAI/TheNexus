-- Add status column to project_contexts table
ALTER TABLE project_contexts ADD COLUMN status TEXT DEFAULT 'draft';

-- Update existing records to have a default status
UPDATE project_contexts SET status = 'draft' WHERE status IS NULL;
