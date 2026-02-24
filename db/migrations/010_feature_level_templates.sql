-- ============================================================================
-- Migration: Feature-Level Workflow Templates
-- Created: 2025-12-29
-- Description: Adds standard feature-level workflow templates for unified orchestration
-- ============================================================================

INSERT INTO workflow_templates (name, description, level, workflow_type, stages, is_system) VALUES
-- Standard Feature Development
('Standard Feature', 'Full development lifecycle: Research -> Plan -> Implement -> Walkthrough', 'feature', 'standard-feature', 
 '[{"id": "research", "name": "Research", "description": "Perform deep research and feasibility analysis", "agentId": "deep-research", "order": 1},
   {"id": "plan", "name": "Planning", "description": "Generate a detailed technical implementation plan", "agentId": "plan-generator", "order": 2},
   {"id": "implement", "name": "Implementation", "description": "Execute the implementation plan and write code", "agentId": "implementation", "order": 3},
   {"id": "walkthrough", "name": "Verification", "description": "Verify implementation and generate walkthrough", "agentId": "failure-analyst", "order": 4}]'::jsonb, true),

-- Bug Fix Workflow
('Bug Fix', 'Targeted bug fixing: Reproduce -> Analyze -> Fix -> Verify', 'feature', 'bug-fix',
 '[{"id": "reproduce", "name": "Reproduction", "description": "Reproduce the bug and write failing tests", "agentId": "implementation", "order": 1},
   {"id": "analyze", "name": "Root Cause Analysis", "description": "Identify the source of the bug and plan fix", "agentId": "failure-analyst", "order": 2},
   {"id": "fix", "name": "Fix Implementation", "description": "Implement the fix and ensure tests pass", "agentId": "implementation", "order": 3},
   {"id": "verify", "name": "Verification", "description": "Final verification of the fix and regression check", "agentId": "critic", "order": 4}]'::jsonb, true),

-- Refactor Workflow
('Code Refactor', 'Improve code quality: Analyze -> Plan -> Refactor -> Verify', 'feature', 'refactor',
 '[{"id": "analyze", "name": "Refactor Analysis", "description": "Identify refactoring targets and define goals", "agentId": "quick-research", "order": 1},
   {"id": "plan", "name": "Refactoring Plan", "description": "Develop a strategy for non-breaking changes", "agentId": "plan-generator", "order": 2},
   {"id": "implement", "name": "Execution", "description": "Perform the refactoring implementation", "agentId": "implementation", "order": 3},
   {"id": "verify", "name": "Regression Check", "description": "Verify code quality and ensure no regressions", "agentId": "critic", "order": 4}]'::jsonb, true)

ON CONFLICT (name) DO NOTHING;
