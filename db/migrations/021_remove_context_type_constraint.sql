-- Remove the hardcoded check constraint on context_type
-- This allows dynamic context types (e.g. 'product-vision', 'architecture', etc.)
-- instead of requiring all types to be predefined.
ALTER TABLE project_contexts DROP CONSTRAINT IF EXISTS project_contexts_context_type_check;
