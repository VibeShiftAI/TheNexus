-- ============================================================================
-- Migration 015: Models Table
-- Makes the database the source of truth for available AI models
-- ============================================================================

CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,                    -- API model ID, e.g., 'gemini-3-flash-preview'
    name TEXT NOT NULL,                     -- Display name: 'Gemini 3 Flash'
    provider TEXT NOT NULL CHECK (provider IN ('google', 'anthropic', 'openai')),
    is_active BOOLEAN DEFAULT TRUE,         -- Toggle visibility without deletion
    is_default_for_task TEXT CHECK (is_default_for_task IN ('plan', 'research', 'implementation', 'quick', NULL)),
    capabilities JSONB DEFAULT '{}',        -- e.g., {"thinking": true, "vision": false}
    parameters JSONB DEFAULT '{}',          -- Default params: temperature, max_tokens, etc.
    sort_order INTEGER DEFAULT 0,           -- For UI ordering
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider);
CREATE INDEX IF NOT EXISTS idx_models_active ON models(is_active);
CREATE INDEX IF NOT EXISTS idx_models_default_task ON models(is_default_for_task);

-- Trigger for auto-updating timestamps
DROP TRIGGER IF EXISTS tr_models_updated_at ON models;
CREATE TRIGGER tr_models_updated_at
    BEFORE UPDATE ON models FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Enable RLS
ALTER TABLE models ENABLE ROW LEVEL SECURITY;

-- Policy (service role has full access)
CREATE POLICY "Allow all for service role" ON models FOR ALL USING (true);

-- ============================================================================
-- Seed initial models
-- ============================================================================

INSERT INTO models (id, name, provider, is_active, is_default_for_task, capabilities, sort_order) VALUES
    -- Google
    ('gemini-3-flash-preview', 'Gemini 3 Flash', 'google', TRUE, 'quick', '{}', 10),
    ('gemini-3-pro-preview', 'Gemini 3 Pro', 'google', TRUE, 'research', '{"thinking": true}', 20),
    -- Anthropic
    ('claude-opus-4-5-20251101', 'Claude Opus 4.5', 'anthropic', TRUE, 'implementation', '{}', 30),
    ('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 'anthropic', TRUE, 'plan', '{}', 40),
    -- OpenAI
    ('gpt-5.2', 'GPT-5.2', 'openai', TRUE, NULL, '{}', 50),
    ('gpt-4o', 'GPT-4o', 'openai', TRUE, NULL, '{}', 60)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    provider = EXCLUDED.provider,
    is_active = EXCLUDED.is_active,
    is_default_for_task = EXCLUDED.is_default_for_task,
    capabilities = EXCLUDED.capabilities,
    sort_order = EXCLUDED.sort_order,
    updated_at = NOW();
