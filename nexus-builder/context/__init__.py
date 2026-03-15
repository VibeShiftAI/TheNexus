"""
Context Package - Phase 6.5: Context Evolution (Hybrid Middleware)

This package provides the tiered, pull-based context system for The Nexus.

Key Components:
- GlobalContextService: Singleton holding project state "source of truth"
- ContextMiddleware: Tiered context injection (Executor/Builder/Reasoner)
- Memory Tools: RAG-enhanced pull tools for agents to query memories

Usage:
    from context import (
        GlobalContextService,
        GlobalContext,
        ContextMiddleware,
        IntelligenceTier,
        SearchProjectMemoryTool,
    )
    
    # Initialize at workflow start
    gcs = GlobalContextService()
    gcs.initialize(project_id="...", task_id="...", project_path="/path")
    
    # Get context in any node
    ctx = gcs.get_global_context()
    
    # Determine tier for a node
    tier = ContextMiddleware.get_tier_for_node("nexus.research_fleet")
"""

from .global_context_service import (
    GlobalContextService,
    GlobalContext,
    get_global_context,
)

from .context_middleware import (
    ContextMiddleware,
    IntelligenceTier,
    ExecutorContext,
    BuilderContext,
    ReasonerContext,
    EXECUTOR_NODES,
    BUILDER_NODES,
    REASONER_NODES,
)

from .memory_tools import (
    SearchProjectMemoryTool,
    MemorySearchResult,
)

__all__ = [
    # Global Context Service
    "GlobalContextService",
    "GlobalContext",
    "get_global_context",
    
    # Context Middleware
    "ContextMiddleware",
    "IntelligenceTier",
    "ExecutorContext",
    "BuilderContext",
    "ReasonerContext",
    "EXECUTOR_NODES",
    "BUILDER_NODES",
    "REASONER_NODES",
    
    # Memory Tools
    "SearchProjectMemoryTool",
    "MemorySearchResult",
]
