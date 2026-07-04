-- Migration: Add artifact_comments table for human-in-the-loop review
-- This enables persistent storage of inline comments on artifacts during workflow review.

CREATE TABLE IF NOT EXISTS artifact_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id TEXT NOT NULL,
    line_number INTEGER NOT NULL DEFAULT 0,  -- 1-indexed, 0 = file-level comment
    content TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'user',
    parent_id UUID REFERENCES artifact_comments(id) ON DELETE CASCADE,  -- For threaded replies
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_artifact_comments_artifact_id ON artifact_comments(artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_parent_id ON artifact_comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_line_number ON artifact_comments(artifact_id, line_number);

-- Enable RLS
ALTER TABLE artifact_comments ENABLE ROW LEVEL SECURITY;

-- Allow all operations for authenticated users (adjust based on your auth setup)
CREATE POLICY "Allow all artifact_comments operations" ON artifact_comments
    FOR ALL USING (true) WITH CHECK (true);

-- Function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_artifact_comments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER artifact_comments_updated_at
    BEFORE UPDATE ON artifact_comments
    FOR EACH ROW
    EXECUTE FUNCTION update_artifact_comments_updated_at();

COMMENT ON TABLE artifact_comments IS 'Inline comments on artifacts during human-in-the-loop review';
COMMENT ON COLUMN artifact_comments.artifact_id IS 'The artifact this comment belongs to';
COMMENT ON COLUMN artifact_comments.line_number IS '1-indexed line number (0 = file-level comment)';
COMMENT ON COLUMN artifact_comments.parent_id IS 'Parent comment for threaded replies';
