-- ============================================================================
-- Migration: Add LangGraph workflow templates to workflows table
-- Created: 2025-12-26
-- Description: Migrates workflow_templates.json to the workflows table
-- ============================================================================

-- Insert LangGraph workflow templates as template workflows
INSERT INTO workflows (name, description, graph_config, version, is_template) VALUES

-- Full Feature Pipeline
('Full Feature Pipeline', 
 'Complete workflow with feedback loops: Research → Plan → Code → Evaluate → (loop or complete)',
 '{
    "nodes": [
        {"id": "quick-research-1", "type": "quick-research", "position": {"x": 250, "y": 50}, "data": {"label": "Quick Research", "config": {}}},
        {"id": "plan-generator-1", "type": "plan-generator", "position": {"x": 250, "y": 200}, "data": {"label": "Plan Generator", "config": {}}},
        {"id": "implementation-1", "type": "implementation", "position": {"x": 250, "y": 350}, "data": {"label": "Implementation", "config": {}}},
        {"id": "evaluator-1", "type": "evaluator", "position": {"x": 250, "y": 500}, "data": {"label": "Evaluator", "config": {}}}
    ],
    "edges": [
        {"id": "e1", "source": "quick-research-1", "target": "plan-generator-1"},
        {"id": "e2", "source": "plan-generator-1", "target": "implementation-1"},
        {"id": "e3", "source": "implementation-1", "target": "evaluator-1"}
    ],
    "conditionalEdges": [
        {"source": "evaluator-1", "routes": {"complete": "END", "re-implement": "implementation-1", "re-plan": "plan-generator-1", "re-research": "quick-research-1"}}
    ],
    "category": "standard",
    "templateId": "feature-full"
 }'::jsonb, 1, true),

-- Quick Implementation
('Quick Implementation',
 'Fast path: Plan → Code → Evaluate (with feedback loops)',
 '{
    "nodes": [
        {"id": "plan-generator-1", "type": "plan-generator", "position": {"x": 250, "y": 100}, "data": {"label": "Plan Generator", "config": {}}},
        {"id": "implementation-1", "type": "implementation", "position": {"x": 250, "y": 250}, "data": {"label": "Implementation", "config": {}}},
        {"id": "evaluator-1", "type": "evaluator", "position": {"x": 250, "y": 400}, "data": {"label": "Evaluator", "config": {}}}
    ],
    "edges": [
        {"id": "e1", "source": "plan-generator-1", "target": "implementation-1"},
        {"id": "e2", "source": "implementation-1", "target": "evaluator-1"}
    ],
    "conditionalEdges": [
        {"source": "evaluator-1", "routes": {"complete": "END", "re-implement": "implementation-1", "re-plan": "plan-generator-1"}}
    ],
    "category": "fast",
    "templateId": "quick-implement"
 }'::jsonb, 1, true),

-- Research Report
('Research Report',
 'Deep research with summary',
 '{
    "nodes": [
        {"id": "researcher-1", "type": "researcher", "position": {"x": 250, "y": 100}, "data": {"label": "Deep Researcher", "config": {"model": "gemini-2.5-pro", "depth": "deep"}}},
        {"id": "summarizer-1", "type": "summarizer", "position": {"x": 250, "y": 250}, "data": {"label": "Summarizer", "config": {"model": "gemini-2.5-flash"}}}
    ],
    "edges": [
        {"id": "e1", "source": "researcher-1", "target": "summarizer-1"}
    ],
    "category": "research",
    "templateId": "research-only"
 }'::jsonb, 1, true),

-- Supervised Pipeline
('Supervised Pipeline',
 'Supervisor routes between workers dynamically',
 '{
    "nodes": [
        {"id": "supervisor-1", "type": "supervisor", "position": {"x": 250, "y": 50}, "data": {"label": "Supervisor", "config": {"model": "gemini-2.5-flash"}}},
        {"id": "researcher-1", "type": "researcher", "position": {"x": 100, "y": 200}, "data": {"label": "Researcher"}},
        {"id": "planner-1", "type": "planner", "position": {"x": 250, "y": 200}, "data": {"label": "Planner"}},
        {"id": "coder-1", "type": "coder", "position": {"x": 400, "y": 200}, "data": {"label": "Coder"}},
        {"id": "reviewer-1", "type": "reviewer", "position": {"x": 250, "y": 350}, "data": {"label": "Reviewer"}}
    ],
    "edges": [
        {"id": "e1", "source": "supervisor-1", "target": "researcher-1"},
        {"id": "e2", "source": "supervisor-1", "target": "planner-1"},
        {"id": "e3", "source": "supervisor-1", "target": "coder-1"},
        {"id": "e4", "source": "researcher-1", "target": "supervisor-1"},
        {"id": "e5", "source": "planner-1", "target": "supervisor-1"},
        {"id": "e6", "source": "coder-1", "target": "reviewer-1"}
    ],
    "category": "advanced",
    "templateId": "supervised-full"
 }'::jsonb, 1, true),

-- Code Review Loop
('Code Review Loop',
 'Code → Review → Revise until approved',
 '{
    "nodes": [
        {"id": "coder-1", "type": "coder", "position": {"x": 150, "y": 150}, "data": {"label": "Coder", "config": {"model": "claude-opus-4-20250514"}}},
        {"id": "reviewer-1", "type": "reviewer", "position": {"x": 350, "y": 150}, "data": {"label": "Reviewer", "config": {"strictness": "strict"}}},
        {"id": "human-1", "type": "human_in_loop", "position": {"x": 250, "y": 300}, "data": {"label": "Human Approval", "config": {"approval_message": "Review the code and approve to commit"}}}
    ],
    "edges": [
        {"id": "e1", "source": "coder-1", "target": "reviewer-1"},
        {"id": "e2", "source": "reviewer-1", "target": "human-1"}
    ],
    "category": "quality",
    "templateId": "code-review-loop"
 }'::jsonb, 1, true)

ON CONFLICT DO NOTHING;

-- ============================================================================
-- Migration Complete
-- ============================================================================
