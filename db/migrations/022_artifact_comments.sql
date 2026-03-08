-- Create artifact_comments table for inline commenting on artifacts
-- Used by the CommentStore in nexus-builder/nodes/artifacts/comments.py
CREATE TABLE IF NOT EXISTS artifact_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL,
  line_number INTEGER NOT NULL DEFAULT 0,   -- 1-indexed, 0 = file-level comment
  content TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'user',
  parent_id UUID REFERENCES artifact_comments(id) ON DELETE CASCADE,
  resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by artifact
CREATE INDEX IF NOT EXISTS idx_artifact_comments_artifact_id ON artifact_comments(artifact_id);

-- Index for threading (parent lookup)
CREATE INDEX IF NOT EXISTS idx_artifact_comments_parent_id ON artifact_comments(parent_id);

-- Enable RLS
ALTER TABLE artifact_comments ENABLE ROW LEVEL SECURITY;

-- Allow all access (internal dashboard, no user auth required)
CREATE POLICY "Enable read access for all users" ON artifact_comments
    FOR SELECT USING (true);

CREATE POLICY "Enable write access for all users" ON artifact_comments
    FOR ALL USING (true) WITH CHECK (true);
