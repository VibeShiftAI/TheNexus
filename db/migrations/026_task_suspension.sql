-- Migration 026: Task Suspension State
-- Adds support for suspending tasks to await human input.
-- 'suspended' is a non-failure pause state — it does NOT trigger error
-- notifications, retry logic, or QA rejection flows.

-- When the task was suspended (ISO 8601)
ALTER TABLE tasks ADD COLUMN suspended_at TEXT;

-- Human-readable explanation: "SELFDOUBT confidence 42%", "Need API design clarification"
ALTER TABLE tasks ADD COLUMN suspended_reason TEXT;

-- JSON: serialized context needed to resume
-- Schema: { conversationId?, workspace, partialResult?, question, options?, workingBranch?, confidenceScore?, originalPayload? }
ALTER TABLE tasks ADD COLUMN suspended_context TEXT;

-- JSON: what to do on resume
-- Schema: { type: "redispatch" | "status_only" | "custom", workspace?, instructions?, nexusTaskId?, modelOverride? }
ALTER TABLE tasks ADD COLUMN resume_action TEXT;

-- Index for dashboard queries ("show all tasks needing my input")
CREATE INDEX IF NOT EXISTS idx_tasks_suspended ON tasks(status) WHERE status = 'suspended';
