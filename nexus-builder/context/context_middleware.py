"""
Context Middleware - Phase 6.5: Context Evolution

Tiered context injection based on node intelligence level.
This is the key to efficient context management:
- Executors (Tier 0): No context injection (pure functions)
- Builders (Tier 1): Project structure context
- Reasoners (Tier 2): Full history and preferences

The middleware determines what context to inject based on node type.
"""

from enum import IntEnum
from typing import Any, Dict, List, Optional, Set
from dataclasses import dataclass, field


# ═══════════════════════════════════════════════════════════════════════════
# INTELLIGENCE TIERS
# ═══════════════════════════════════════════════════════════════════════════

class IntelligenceTier(IntEnum):
    """
    Intelligence tiers for nodes.
    
    Higher tiers receive more context but are more expensive.
    The key insight: most nodes don't need full context!
    """
    EXECUTOR = 0   # Zero context - pure function execution
    BUILDER = 1    # Project structure (file tree, type definitions)
    REASONER = 2   # Full history (memories, preferences, deep context)


# ═══════════════════════════════════════════════════════════════════════════
# TIER CONTEXT DATA STRUCTURES
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class ExecutorContext:
    """
    Tier 0: Minimal context for atomic operations.
    
    Executors don't need project awareness - they just execute.
    Examples: HTTP Request, File Write, Code Execute, Transform
    """
    execution_id: str = ""
    node_id: str = ""


@dataclass
class BuilderContext:
    """
    Tier 1: Project structure context for design/build operations.
    
    Builders need to understand what exists but not the full history.
    Examples: Builder Fleet, Scaffold Node, Code Generator
    """
    execution_id: str = ""
    node_id: str = ""
    
    # Project structure
    project_path: Optional[str] = None
    project_name: str = "Unknown"
    file_tree: List[str] = field(default_factory=list)
    type_definitions: Dict[str, Any] = field(default_factory=dict)
    
    # Current task focus
    task_title: Optional[str] = None
    task_description: Optional[str] = None


@dataclass
class ReasonerContext:
    """
    Tier 2: Full context for cognitive/reasoning operations.
    
    Reasoners need deep context to make intelligent decisions.
    Examples: Research Fleet, Architect Fleet, Nexus Prime
    """
    execution_id: str = ""
    node_id: str = ""
    
    # Project structure (inherited from Builder)
    project_path: Optional[str] = None
    project_name: str = "Unknown"
    file_tree: List[str] = field(default_factory=list)
    type_definitions: Dict[str, Any] = field(default_factory=dict)
    
    # Current task focus
    task_title: Optional[str] = None
    task_description: Optional[str] = None
    
    # Full history context
    memories: List[Dict[str, Any]] = field(default_factory=list)
    user_preferences: Dict[str, Any] = field(default_factory=dict)
    previous_runs: List[Dict[str, Any]] = field(default_factory=list)
    
    # Deep context
    project_persona: Optional[str] = None
    coding_standards: Optional[str] = None


# ═══════════════════════════════════════════════════════════════════════════
# NODE TYPE CLASSIFICATION
# ═══════════════════════════════════════════════════════════════════════════

# Executor nodes: Pure functions, no context needed
EXECUTOR_NODES: Set[str] = {
    # Core atomic nodes
    "nexus.http_request",
    "nexus.code_execute", 
    "nexus.data_transform",
    "nexus.conditional",
    "nexus.merge",
    "nexus.split",
    "nexus.set",
    "nexus.filter",
    "nexus.switch",
    
    # File operations
    "nexus.file_read",
    "nexus.file_write",
    
    # Utility nodes
    "nexus.wait",
    "nexus.no_op",
    "nexus.error",
}

# Builder nodes: Need project structure
BUILDER_NODES: Set[str] = {
    "nexus.builder_fleet",
    "nexus.scaffold",
    "nexus.code_generator",
    "nexus.file_tree",
    "nexus.dependency_analyzer",
    
    # Agent with build capabilities
    "builder_agent",
    "scaffold_agent",
}

# Reasoner nodes: Need full context
REASONER_NODES: Set[str] = {
    "nexus.research_fleet",
    "nexus.architect_fleet",
    "nexus.audit_fleet",
    "nexus.nexus_prime",
    
    # High-level reasoning agents
    "research_agent",
    "architect_agent",
    "supervisor_agent",
    "auditor_agent",
    
    # AI/LLM nodes
    "nexus.ai_agent",
    "nexus.llm_chain",
}


# ═══════════════════════════════════════════════════════════════════════════
# CONTEXT MIDDLEWARE
# ═══════════════════════════════════════════════════════════════════════════

class ContextMiddleware:
    """
    Middleware that injects appropriate context based on node intelligence tier.
    
    Phase 6.5: Context Evolution (Hybrid Middleware)
    
    Usage:
        tier = ContextMiddleware.get_tier_for_node("nexus.research_fleet")
        # Returns IntelligenceTier.REASONER
        
        context = await ContextMiddleware.build_context_for_tier(tier, global_ctx)
    """
    
    @staticmethod
    def get_tier_for_node(node_type: str) -> IntelligenceTier:
        """
        Determine the intelligence tier for a node type.
        
        Args:
            node_type: The node type identifier
        
        Returns:
            IntelligenceTier for the node
        """
        # Check explicit classifications first
        if node_type in EXECUTOR_NODES:
            return IntelligenceTier.EXECUTOR
        
        if node_type in BUILDER_NODES:
            return IntelligenceTier.BUILDER
        
        if node_type in REASONER_NODES:
            return IntelligenceTier.REASONER
        
        # Heuristic classification for unknown nodes
        node_lower = node_type.lower()
        
        # Pattern matching for reasoners
        if any(pattern in node_lower for pattern in [
            "research", "architect", "audit", "supervisor",
            "reason", "analyze", "plan", "nexus_prime",
            "ai_agent", "llm", "cognitive"
        ]):
            return IntelligenceTier.REASONER
        
        # Pattern matching for builders
        if any(pattern in node_lower for pattern in [
            "build", "scaffold", "generate", "create",
            "construct", "assemble"
        ]):
            return IntelligenceTier.BUILDER
        
        # Default to executor (safest, least expensive)
        return IntelligenceTier.EXECUTOR
    
    @staticmethod
    async def build_context_for_tier(
        tier: IntelligenceTier,
        execution_id: str = "",
        node_id: str = "",
        project_path: Optional[str] = None,
        task_title: Optional[str] = None,
        task_description: Optional[str] = None,
        supabase_client=None
    ):
        """
        Build the appropriate context object for a tier.
        
        Args:
            tier: The intelligence tier
            execution_id: Current execution ID
            node_id: Current node ID
            project_path: Project filesystem path
            task_title: Task title
            task_description: Task description
            supabase_client: Optional Supabase client for data retrieval
        
        Returns:
            ExecutorContext, BuilderContext, or ReasonerContext
        """
        if tier == IntelligenceTier.EXECUTOR:
            return ExecutorContext(
                execution_id=execution_id,
                node_id=node_id
            )
        
        if tier == IntelligenceTier.BUILDER:
            # Load project structure
            file_tree = await ContextMiddleware._load_file_tree(project_path)
            
            return BuilderContext(
                execution_id=execution_id,
                node_id=node_id,
                project_path=project_path,
                project_name=project_path.split("/")[-1] if project_path else "Unknown",
                file_tree=file_tree,
                task_title=task_title,
                task_description=task_description
            )
        
        if tier == IntelligenceTier.REASONER:
            # Load full context
            file_tree = await ContextMiddleware._load_file_tree(project_path)
            memories = await ContextMiddleware._load_memories(supabase_client)
            user_prefs = await ContextMiddleware._load_user_preferences(supabase_client)
            
            return ReasonerContext(
                execution_id=execution_id,
                node_id=node_id,
                project_path=project_path,
                project_name=project_path.split("/")[-1] if project_path else "Unknown",
                file_tree=file_tree,
                task_title=task_title,
                task_description=task_description,
                memories=memories,
                user_preferences=user_prefs
            )
        
        # Fallback
        return ExecutorContext(execution_id=execution_id, node_id=node_id)
    
    @staticmethod
    async def _load_file_tree(project_path: Optional[str]) -> List[str]:
        """Load project file tree."""
        if not project_path:
            return []
        
        from pathlib import Path
        import os
        
        try:
            path = Path(project_path)
            if not path.exists():
                return []
            
            # Walk first 3 levels, ignore common patterns
            ignore = {".git", "node_modules", "__pycache__", "venv", ".next", "dist", "build"}
            result = []
            
            for root, dirs, files in os.walk(path):
                # Filter ignored dirs
                dirs[:] = [d for d in dirs if d not in ignore]
                
                # Calculate depth
                rel_path = Path(root).relative_to(path)
                depth = len(rel_path.parts)
                
                if depth > 3:
                    continue
                
                for f in files[:50]:  # Limit files per directory
                    result.append(str(Path(root).relative_to(path) / f))
                
                if len(result) > 200:  # Hard limit
                    break
            
            return result[:200]
        
        except Exception as e:
            print(f"[ContextMiddleware] Error loading file tree: {e}")
            return []
    
    @staticmethod
    async def _load_memories(supabase_client, limit: int = 15) -> List[Dict[str, Any]]:
        """Load recent memories from database."""
        if not supabase_client:
            return []
        
        try:
            result = supabase_client.client.table("agent_memories").select(
                "*"
            ).order("created_at", desc=True).limit(limit).execute()
            
            return result.data or []
        except Exception as e:
            print(f"[ContextMiddleware] Error loading memories: {e}")
            return []
    
    @staticmethod
    async def _load_user_preferences(supabase_client) -> Dict[str, Any]:
        """Load user preferences from database."""
        if not supabase_client:
            return {}
        
        try:
            result = supabase_client.client.table("user_preferences").select("*").execute()
            
            prefs = {}
            for row in result.data or []:
                prefs[row.get("key", "unknown")] = row.get("value")
            
            return prefs
        except Exception as e:
            print(f"[ContextMiddleware] Error loading preferences: {e}")
            return {}
    
    @staticmethod
    def should_inject_context(node_type: str) -> bool:
        """Check if a node should receive any context injection."""
        tier = ContextMiddleware.get_tier_for_node(node_type)
        return tier > IntelligenceTier.EXECUTOR
    
    @staticmethod
    def get_tier_name(tier: IntelligenceTier) -> str:
        """Get human-readable name for a tier."""
        names = {
            IntelligenceTier.EXECUTOR: "Executor",
            IntelligenceTier.BUILDER: "Builder",
            IntelligenceTier.REASONER: "Reasoner"
        }
        return names.get(tier, "Unknown")
