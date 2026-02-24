"""
Atomic Node Registry - Node Discovery and Management

This registry discovers and manages atomic nodes.
Inspired by n8n's LoadNodesAndCredentials service.

Reference: packages/cli/src/load-nodes-and-credentials.ts

MIGRATION NOTE: This registry will gradually replace functions in node_registry.py.
During transition, both registries coexist. Comment out legacy handlers
after their atomic counterparts are tested.
"""

from typing import Dict, List, Type, Any, Optional
import importlib
import pkgutil
from pathlib import Path

from .core import AtomicNode


class AtomicNodeRegistry:
    """
    Registry for discovering and managing atomic nodes.
    
    Features:
    1. Automatic node discovery from directories
    2. Node type resolution by ID
    3. Node description export for frontend
    
    Reference: packages/cli/src/load-nodes-and-credentials.ts
    """
    
    def __init__(self):
        self._nodes: Dict[str, Type[AtomicNode]] = {}
        self._instances: Dict[str, AtomicNode] = {}
    
    def register(self, node_class: Type[AtomicNode]) -> None:
        """
        Register a node class by its type_id.
        """
        if not node_class.type_id:
            raise ValueError(f"Node class {node_class.__name__} has no type_id")
        
        self._nodes[node_class.type_id] = node_class
        # Create a singleton instance for description access
        self._instances[node_class.type_id] = node_class()
    
    def get_node_class(self, type_id: str) -> Optional[Type[AtomicNode]]:
        """Get a node class by its type ID."""
        return self._nodes.get(type_id)
    
    def get_node_instance(self, type_id: str) -> Optional[AtomicNode]:
        """Get a node instance by its type ID."""
        return self._instances.get(type_id)
    
    def create_node(self, type_id: str) -> Optional[AtomicNode]:
        """Create a new instance of a node by type ID."""
        node_class = self._nodes.get(type_id)
        if node_class:
            return node_class()
        return None
    
    def get_all_descriptions(self) -> List[Dict[str, Any]]:
        """
        Get descriptions for all registered nodes.
        Used to populate the frontend node palette.
        """
        return [
            instance.get_description()
            for instance in self._instances.values()
        ]
    
    def get_nodes_by_category(self, category: str) -> List[Dict[str, Any]]:
        """Get all nodes in a specific category."""
        return [
            instance.get_description()
            for instance in self._instances.values()
            if instance.category == category
        ]
    
    def get_nodes_by_level(self, level: str) -> List[Dict[str, Any]]:
        """Get all nodes available at a specific level (dashboard/project/feature)."""
        return [
            instance.get_description()
            for instance in self._instances.values()
            if level in instance.levels
        ]
    
    def discover_nodes(self, package_path: str = "nodes") -> int:
        """
        Auto-discover and register all atomic nodes in the package.
        
        Mirrors n8n's loadNodesFromNodeModules pattern.
        Reference: packages/cli/src/load-nodes-and-credentials.ts L126
        
        Returns the number of nodes discovered.
        """
        discovered = 0
        
        # Get the nodes package
        try:
            nodes_package = importlib.import_module(package_path)
            package_dir = Path(nodes_package.__file__).parent
        except ImportError:
            return 0
        
        # Walk all submodules
        for _, submodule_name, is_pkg in pkgutil.walk_packages(
            path=[str(package_dir)],
            prefix=f"{package_path}."
        ):
            if submodule_name.endswith("__init__"):
                continue
                
            try:
                module = importlib.import_module(submodule_name)
                
                # Find all AtomicNode subclasses in the module
                for attr_name in dir(module):
                    attr = getattr(module, attr_name)
                    if (
                        isinstance(attr, type) and
                        issubclass(attr, AtomicNode) and
                        attr is not AtomicNode and
                        attr.type_id  # Must have a type_id
                    ):
                        self.register(attr)
                        discovered += 1
                        
            except Exception as e:
                # Log but don't fail on import errors
                print(f"Warning: Could not load {submodule_name}: {e}")
        
        return discovered


# DEPRECATED: Old registry global - now using NodeRegistry as single source of truth
# _registry: Optional[AtomicNodeRegistry] = None



# ═══════════════════════════════════════════════════════════════
# UNIFIED NODE REGISTRY (ATOMIC NODES ONLY)
# ═══════════════════════════════════════════════════════════════

class NodeRegistry(AtomicNodeRegistry):
    """
    Unified registry for built-in atomic nodes.
    
    This is the single source of truth for all workflow nodes.
    User-defined nodes have been deprecated - new agents should be
    added as atomic node classes via Praxis tasks.
    """
    
    def __init__(self):
        super().__init__()
    
    def get_all_descriptions(self) -> List[Dict[str, Any]]:
        """
        Get descriptions for all built-in atomic nodes.
        Used to populate the frontend workflow builder palette.
        """
        return [
            instance.get_description()
            for instance in self._instances.values()
        ]
    
    def get_node_instance(self, type_id: str) -> Optional[Any]:
        """Get a node instance by type ID."""
        return self._instances.get(type_id)
    
    def create_node(self, type_id: str, config: Dict[str, Any] = None) -> Any:
        """
        Create a node handler function for use in LangGraph.
        Returns a function that takes state and returns updated state.
        
        This is a compatibility layer for graph_engine.py which uses
        the legacy state-based execution model.
        """
        config = config or {}
        
        # Get the atomic node instance
        node = self.get_node_instance(type_id)
        if not node:
            raise ValueError(f"Unknown node type: {type_id}")
        
        # Wrap atomic node in legacy handler interface
        async def node_handler(state: Dict[str, Any]) -> Dict[str, Any]:
            from .core import NodeExecutionContext, NodeExecutionData, WorkflowInfo, NodeInfo
            from .artifacts import ArtifactStore
            
            # Create execution context from state with full context access
            ctx = NodeExecutionContext(
                workflow=WorkflowInfo(id="workflow", name="workflow"),
                node=NodeInfo(
                    id=type_id,
                    name=type_id,
                    type=type_id,
                    type_version=1.0,
                    parameters={
                        **config,
                        # Inject critical context fields as parameters
                        "project_root": state.get("context", {}).get("project_root", "."),
                        "task_title": state.get("context", {}).get("task_title", ""),
                    }
                ),
                project_id=state.get("context", {}).get("project_id"),
                task_id=state.get("context", {}).get("task_id"),
            )
            
            # ═══════════════════════════════════════════════════════════════════
            # ARTIFACT STORE: Inject or create shared artifact store
            # ═══════════════════════════════════════════════════════════════════
            if "artifact_store" in state.get("context", {}):
                # Use existing store from workflow state
                ctx.set_artifact_store(state["context"]["artifact_store"])
            else:
                # Create new store and attach to context for downstream nodes
                store = ArtifactStore(
                    workflow_run_id=state.get("context", {}).get("run_id", ""),
                    task_id=state.get("context", {}).get("task_id", ""),
                    project_id=state.get("context", {}).get("project_id", ""),
                )
                ctx.set_artifact_store(store)
            
            # CRITICAL FIX: Pass full state so FleetAgentNode can access messages, context, etc.
            items = [NodeExecutionData(json=state)]
            
            # Execute atomic node
            results = await node.execute(ctx, items)
            
            # ═══════════════════════════════════════════════════════════════════
            # ARTIFACT SYNC: Merge artifacts back to state outputs
            # ═══════════════════════════════════════════════════════════════════
            artifact_store = ctx.get_artifact_store()
            
            # Convert results back to legacy state format
            if results and results[0]:
                output_data = results[0][0].json
                return {
                    "messages": state.get("messages", []),
                    "context": {
                        **state.get("context", {}),
                        # Share artifact store with downstream nodes
                        "artifact_store": artifact_store,
                    },
                    "outputs": {
                        **state.get("outputs", {}),
                        **output_data,
                        # Also merge legacy outputs from artifact store
                        **artifact_store.to_legacy_outputs(),
                    },
                    # Store artifacts list for UI display
                    "artifacts": artifact_store.to_dict()["artifacts"],
                }
            return state
        
        return node_handler


# Global unified registry instance
_registry: Optional[NodeRegistry] = None


def get_registry() -> NodeRegistry:
    """Get or create the global node registry."""
    global _registry
    if _registry is None:
        _registry = NodeRegistry()
    return _registry


def get_atomic_registry() -> NodeRegistry:
    """Get the global node registry (alias for get_registry for backward compat)."""
    return get_registry()


# Alias for backward compatibility
get_unified_registry = get_registry


def init_atomic_nodes() -> int:
    """
    Initialize the atomic node system.
    
    Call this at application startup to:
    1. Create the global registry (NodeRegistry)
    2. Register all built-in atomic nodes
    3. Return the count of discovered nodes
    """
    registry = get_registry()
    
    # Import and register all built-in nodes
    from .research import ResearcherNode
    from .planning import ArchitectNode
    from .implementation import BuilderNode
    from .review import AuditorNode
    from .orchestration import (
        NexusPrimeNode,
        HumanApprovalNode,
        ProjectIteratorNode,
        StageManagerNode,
        FleetNode,
        SupervisorNode,
    )
    from .utility import (
        SummarizerNode,
        GitCommitNode,
        AggregateResultsNode,
    )
    # Phase 7: Memory nodes
    from .memory.atomic_nodes import (
        MemoryBufferWindowNode,
        MemoryManagerNode,
    )
    
    # Register all built-in nodes
    for node_class in [
        ResearcherNode,
        ArchitectNode,
        BuilderNode,
        AuditorNode,
        NexusPrimeNode,
        HumanApprovalNode,
        ProjectIteratorNode,
        StageManagerNode,
        FleetNode,
        SupervisorNode,
        SummarizerNode,
        GitCommitNode,
        AggregateResultsNode,
        # Phase 7: Memory nodes
        MemoryBufferWindowNode,
        MemoryManagerNode,
    ]:
        registry.register(node_class)
    
    return len(registry._nodes)
