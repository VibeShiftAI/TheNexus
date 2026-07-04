-- TheNexus Execution History & Inline Comments
-- Migration 002: Add tables for workflow timeline and inline comments
-- Run this migration in Supabase SQL Editor

-- ═══════════════════════════════════════════════════════════════
-- EXECUTION STEPS TABLE
-- Stores step-by-step execution history for workflow timeline
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS execution_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID REFERENCES runs(id) ON DELETE CASCADE,
    feature_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    node TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('research', 'plan', 'implement')),
    step INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    input JSONB,
    output JSONB,
    messages JSONB,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for execution_steps
CREATE INDEX IF NOT EXISTS idx_execution_steps_feature ON execution_steps(project_id, feature_id);
CREATE INDEX IF NOT EXISTS idx_execution_steps_run ON execution_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_execution_steps_stage ON execution_steps(feature_id, stage);

-- ═══════════════════════════════════════════════════════════════
-- INLINE COMMENTS TABLE
-- Stores contextual comments on artifact content
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS inline_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feature_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('research', 'plan', 'walkthrough')),
    selection_text TEXT NOT NULL,
    selection_start INTEGER,
    selection_end INTEGER,
    comment TEXT NOT NULL,
    resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for inline_comments
CREATE INDEX IF NOT EXISTS idx_inline_comments_feature ON inline_comments(project_id, feature_id);
CREATE INDEX IF NOT EXISTS idx_inline_comments_stage ON inline_comments(feature_id, stage);
CREATE INDEX IF NOT EXISTS idx_inline_comments_unresolved ON inline_comments(feature_id, resolved) WHERE NOT resolved;

-- Trigger for updated_at on inline_comments
DROP TRIGGER IF EXISTS update_inline_comments_updated_at ON inline_comments;
CREATE TRIGGER update_inline_comments_updated_at
    BEFORE UPDATE ON inline_comments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ═══════════════════════════════════════════════════════════════
-- SUCCESS MESSAGE
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
    RAISE NOTICE 'Migration 002 completed: execution_steps and inline_comments tables created!';
END $$;
