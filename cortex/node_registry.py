"""
Nexus Node Registry — Agent Discovery for Dashboard

Provides metadata for all active agents in the Vibe Coding OS pipeline.
Used by the Agent Manager dashboard for the unified agent inventory.
"""

from typing import Dict, Any, List, Optional


# ═══════════════════════════════════════════════════════════════════════════
# Agent Definitions
# ═══════════════════════════════════════════════════════════════════════════

AGENT_REGISTRY: Dict[str, Dict[str, Any]] = {
    # ── Orchestration ─────────────────────────────────────────────────────
    "chat_router": {
        "id": "chat_router",
        "name": "Chat Router",
        "description": "Semantic intent detection — classifies user messages as 'chat' or 'build' to route through the correct pipeline",
        "category": "orchestration",
        "icon": "🔀",
        "node_type": "orchestrator",
        "source_file": "core/orchestrator.py",
    },

    # ── Planning ──────────────────────────────────────────────────────────
    "lead_architect": {
        "id": "lead_architect",
        "name": "Lead Architect",
        "description": "Drafts and revises project plans using high-diversity model shuffling for creative hypothesis generation",
        "category": "planning",
        "icon": "🏛️",
        "node_type": "planner",
        "source_file": "agents/planner.py",
    },

    # ── Review (Council) ──────────────────────────────────────────────────
    "frontend_specialist": {
        "id": "frontend_specialist",
        "name": "Frontend/UX Specialist",
        "description": "Reviews component architecture, accessibility (WCAG), responsive design, and UI/UX patterns",
        "category": "review",
        "icon": "🎨",
        "node_type": "voter",
        "source_file": "agents/council.py",
    },
    "systems_engineer": {
        "id": "systems_engineer",
        "name": "Systems Engineer",
        "description": "Reviews database schemas, API design, authentication, security, and deployment architecture",
        "category": "review",
        "icon": "⚙️",
        "node_type": "voter",
        "source_file": "agents/council.py",
    },
    "qa_strategist": {
        "id": "qa_strategist",
        "name": "QA Strategist",
        "description": "Reviews test strategy, edge cases, CI/CD pipelines, and acceptance criteria completeness",
        "category": "review",
        "icon": "🧪",
        "node_type": "voter",
        "source_file": "agents/council.py",
    },
    "gap_analyst": {
        "id": "gap_analyst",
        "name": "Gap Analyst",
        "description": "Finds what's missing — integration gaps, implied features, shortcuts, and failure recovery holes",
        "category": "review",
        "icon": "🔍",
        "node_type": "voter",
        "source_file": "agents/council.py",
    },

    # ── Utility ───────────────────────────────────────────────────────────
    "compiler": {
        "id": "compiler",
        "name": "Compiler",
        "description": "Converts approved Markdown plans into executable JSON project definitions with tasks and dependencies",
        "category": "utility",
        "icon": "📦",
        "node_type": "utility",
        "source_file": "agents/compiler.py",
    },
    "executor": {
        "id": "executor",
        "name": "Executor",
        "description": "Creates projects and tasks in Nexus from compiled plans, completing the build pipeline",
        "category": "utility",
        "icon": "🚀",
        "node_type": "utility",
        "source_file": "core/orchestrator.py",
    },
}


# ═══════════════════════════════════════════════════════════════════════════
# Registry Class
# ═══════════════════════════════════════════════════════════════════════════

class NodeRegistry:
    """
    Registry for Nexus agents.
    Provides agent metadata to the dashboard Agent Manager.
    """

    _instance: Optional['NodeRegistry'] = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(NodeRegistry, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True

    def get_all(self) -> List[Dict[str, Any]]:
        """Get all registered agents."""
        return list(AGENT_REGISTRY.values())

    def get(self, agent_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific agent by ID."""
        return AGENT_REGISTRY.get(agent_id)

    def get_by_category(self, category: str) -> List[Dict[str, Any]]:
        """Get agents by category."""
        return [a for a in AGENT_REGISTRY.values() if a["category"] == category]


# Convenience function
def get_node_registry() -> NodeRegistry:
    """Get the singleton registry instance."""
    return NodeRegistry()


# For testing
if __name__ == "__main__":
    registry = get_node_registry()
    print(f"Loaded {len(registry.get_all())} agents:")
    for agent in registry.get_all():
        print(f"  [{agent['node_type']}] {agent['icon']} {agent['name']}: {agent['description'][:60]}...")
