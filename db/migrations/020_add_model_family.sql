-- ============================================================================
-- Migration 020: Add Family Column to Models
-- Groups models by product family (e.g., Gemini, Claude, GPT, Grok)
-- ============================================================================

ALTER TABLE models ADD COLUMN IF NOT EXISTS family TEXT;

-- Backfill existing rows based on provider
UPDATE models SET family = 'Gemini'  WHERE provider = 'google'    AND family IS NULL;
UPDATE models SET family = 'Claude'  WHERE provider = 'anthropic' AND family IS NULL;
UPDATE models SET family = 'GPT'     WHERE provider = 'openai'    AND family IS NULL;
UPDATE models SET family = 'Grok'    WHERE provider = 'xai'       AND family IS NULL;

-- Index for filtering/grouping by family
CREATE INDEX IF NOT EXISTS idx_models_family ON models(family);
