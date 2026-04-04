-- Migration 025: Push Notification Tokens
-- Stores device push tokens for Expo Push Notifications

CREATE TABLE IF NOT EXISTS push_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,            -- Expo Push Token (ExponentPushToken[xxx])
    device_id TEXT,                        -- Optional device identifier for dedup
    platform TEXT DEFAULT 'android',       -- 'android' | 'ios' | 'web'
    label TEXT,                            -- Human-readable label (e.g. "Robert's Pixel")
    enabled INTEGER DEFAULT 1,            -- 1 = active, 0 = disabled by user or server
    last_success_at TEXT,                  -- Last successful push delivery
    last_error TEXT,                       -- Last delivery error message
    error_count INTEGER DEFAULT 0,         -- Consecutive error count (for auto-disable)
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Index for fast lookup and cleanup
CREATE INDEX IF NOT EXISTS idx_push_tokens_enabled ON push_tokens(enabled);
CREATE INDEX IF NOT EXISTS idx_push_tokens_token ON push_tokens(token);
