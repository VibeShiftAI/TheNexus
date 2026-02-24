-- Migration: Add sandbox_sessions table
-- For persistent session state across API restarts

CREATE TABLE IF NOT EXISTS sandbox_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT,
    language TEXT DEFAULT 'python',
    containers JSONB DEFAULT '{}',
    workspace_path TEXT,
    installed_packages JSONB DEFAULT '[]',
    status TEXT DEFAULT 'idle',
    created_at TIMESTAMPTZ DEFAULT now(),
    last_activity TIMESTAMPTZ DEFAULT now(),
    metadata JSONB DEFAULT '{}'
);

-- Index for status queries
CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_status 
ON sandbox_sessions(status);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_last_activity 
ON sandbox_sessions(last_activity);

-- Function to update last_activity on any update
CREATE OR REPLACE FUNCTION update_sandbox_session_activity()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_activity = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for auto-updating last_activity
DROP TRIGGER IF EXISTS sandbox_session_activity_trigger ON sandbox_sessions;
CREATE TRIGGER sandbox_session_activity_trigger
BEFORE UPDATE ON sandbox_sessions
FOR EACH ROW
EXECUTE FUNCTION update_sandbox_session_activity();
