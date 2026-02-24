"""
Atomic Node System - Core Base Classes

This module implements the foundational atomic node system inspired by n8n.
Reference: packages/core/src/execution-engine/node-execution-context/node-execution-context.ts
Reference: packages/workflow/src/Interfaces.ts

MIGRATION: This is a NEW system. Legacy node_registry.py handlers remain active
           and can be commented out after testing atomic node equivalents.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, TypeVar, Generic
from dataclasses import dataclass, field
from enum import Enum
import uuid
from datetime import datetime


# ═══════════════════════════════════════════════════════════════════════════════
# NODE CONNECTION TYPES (from n8n Interfaces.ts)
# ═══════════════════════════════════════════════════════════════════════════════

class NodeConnectionType(str, Enum):
    """
    Mirrors n8n's NodeConnectionType.
    Reference: packages/workflow/src/Interfaces.ts
    """
    MAIN = "main"
    AI_AGENT = "ai_agent"
    AI_CHAIN = "ai_chain"
    AI_DOCUMENT = "ai_document"
    AI_EMBEDDING = "ai_embedding"
    AI_LANGUAGE_MODEL = "ai_languageModel"
    AI_MEMORY = "ai_memory"
    AI_OUTPUT_PARSER = "ai_outputParser"
    AI_RETRIEVER = "ai_retriever"
    AI_TEXT_SPLITTER = "ai_textSplitter"
    AI_TOOL = "ai_tool"
    AI_VECTOR_STORE = "ai_vectorStore"


# ═══════════════════════════════════════════════════════════════════════════════
# NODE EXECUTION DATA (from n8n INodeExecutionData)
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class NodeExecutionData:
    """
    Data passed between nodes during execution.
    Mirrors n8n's INodeExecutionData.
    """
    json: Dict[str, Any] = field(default_factory=dict)
    binary: Optional[Dict[str, Any]] = None
    pairedItem: Optional[Dict[str, Any]] = None
    error: Optional[Exception] = None


# ═══════════════════════════════════════════════════════════════════════════════
# NODE EXECUTION CONTEXT (from n8n NodeExecutionContext)
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class WorkflowInfo:
    """Basic workflow information."""
    id: str
    name: str
    active: bool = False


@dataclass
class NodeInfo:
    """Information about the current node."""
    id: str
    name: str
    type: str
    type_version: float
    position: List[int] = field(default_factory=lambda: [0, 0])
    disabled: bool = False
    parameters: Dict[str, Any] = field(default_factory=dict)


class NodeExecutionContext:
    """
    Execution context provided to nodes during execution.
    Mirrors n8n's NodeExecutionContext class.
    
    Reference: packages/core/src/execution-engine/node-execution-context/node-execution-context.ts
    
    This context provides nodes with:
    - Access to workflow and node information
    - Input data from connected nodes
    - Parameter resolution
    - Static data persistence (for polling nodes)
    - Credential access (delegated to Supabase)
    """
    
    def __init__(
        self,
        workflow: WorkflowInfo,
        node: NodeInfo,
        run_index: int = 0,
        item_index: int = 0,
        connection_input_data: Optional[List[NodeExecutionData]] = None,
        execution_id: Optional[str] = None,
        mode: str = "manual",
        # Global context (The Nexus's "secret sauce")
        project_id: Optional[str] = None,
        task_id: Optional[str] = None,
        user_preferences: Optional[Dict[str, Any]] = None,
    ):
        self.workflow = workflow
        self.node = node
        self.run_index = run_index
        self.item_index = item_index
        self.connection_input_data = connection_input_data or []
        self.execution_id = execution_id or str(uuid.uuid4())
        self.mode = mode
        
        # Nexus-specific context extensions
        self.project_id = project_id
        self.task_id = task_id
        self.user_preferences = user_preferences or {}
        
        # Static data storage (for polling nodes)
        self._static_data: Dict[str, Any] = {}
        self._static_data_changed = False
        
        # ═══════════════════════════════════════════════════════════════════════
        # ARTIFACT STORE (Universal Artifact System)
        # ═══════════════════════════════════════════════════════════════════════
        self._artifact_store = None  # Lazy-loaded ArtifactStore
    
    # ═══════════════════════════════════════════════════════════════════════════
    # ARTIFACT STORE METHODS (Universal Artifact System)
    # ═══════════════════════════════════════════════════════════════════════════
    
    def get_artifact_store(self):
        """
        Get the artifact store for this workflow run.
        
        Lazy-loads the store on first access.
        
        Usage:
            store = ctx.get_artifact_store()
            store.store_simple("my_output", content, category=...)
        
        Returns:
            ArtifactStore instance
        """
        if self._artifact_store is None:
            from ..artifacts import ArtifactStore
            self._artifact_store = ArtifactStore(
                workflow_run_id=self.workflow.id,
                task_id=self.task_id or "",
                project_id=self.project_id or "",
            )
        return self._artifact_store
    
    def set_artifact_store(self, store):
        """
        Set a shared artifact store (for workflow-level sharing).
        
        Use this to share artifacts across nodes in the same workflow run.
        
        Args:
            store: An ArtifactStore instance
        """
        self._artifact_store = store
    
    def get_workflow(self) -> Dict[str, Any]:
        """Get workflow information. Mirrors getWorkflow()."""
        return {
            "id": self.workflow.id,
            "name": self.workflow.name,
            "active": self.workflow.active,
        }
    
    def get_node(self) -> Dict[str, Any]:
        """Get current node information. Mirrors getNode()."""
        return {
            "id": self.node.id,
            "name": self.node.name,
            "type": self.node.type,
            "typeVersion": self.node.type_version,
            "position": self.node.position,
            "disabled": self.node.disabled,
            "parameters": self.node.parameters,
        }
    
    def get_execution_id(self) -> str:
        """Get the current execution ID. Mirrors getExecutionId()."""
        return self.execution_id
    
    def get_mode(self) -> str:
        """Get execution mode (manual, trigger, etc). Mirrors getMode()."""
        return self.mode
    
    def get_input_data(
        self,
        input_name: str = "main",
        input_index: int = 0
    ) -> List[NodeExecutionData]:
        """
        Get input data from connected nodes.
        Mirrors getInputData().
        """
        # For now, return all connection input data
        # TODO: Filter by input_name and input_index when multi-input is needed
        return self.connection_input_data
    
    def get_node_parameter(
        self,
        parameter_name: str,
        fallback_value: Any = None,
        item_index: Optional[int] = None
    ) -> Any:
        """
        Get a parameter value from the node configuration.
        Mirrors getNodeParameter().
        
        TODO: Add expression resolution support (Phase 3.5)
        """
        return self.node.parameters.get(parameter_name, fallback_value)
    
    def get_static_data(self, type: str = "node") -> Dict[str, Any]:
        """
        Get static data that persists across executions.
        Mirrors getWorkflowStaticData().
        
        Used by polling triggers to remember "last checked ID".
        Reference: packages/workflow/src/workflow.ts L218
        """
        key = "global" if type == "global" else f"node:{self.node.name}"
        if key not in self._static_data:
            self._static_data[key] = {}
        return self._static_data[key]
    
    def set_static_data(self, type: str, data: Dict[str, Any]) -> None:
        """Set static data and mark it as changed for persistence."""
        key = "global" if type == "global" else f"node:{self.node.name}"
        self._static_data[key] = data
        self._static_data_changed = True
    
    # ═══════════════════════════════════════════════════════════════════════════
    # NEXUS-SPECIFIC CONTEXT EXTENSIONS (Phase 6.5: Context Evolution)
    # ═══════════════════════════════════════════════════════════════════════════
    
    def get_project_context(self) -> Dict[str, Any]:
        """
        Get project-level context (The Nexus's "Soul").
        This provides project awareness that standard n8n nodes lack.
        """
        return {
            "project_id": self.project_id,
            "task_id": self.task_id,
            "user_preferences": self.user_preferences,
        }
    
    def get_global_context(self):
        """
        Access the GlobalContextService singleton.
        
        Phase 6.5: Context Evolution (Hybrid Middleware)
        
        This provides access to the project state "source of truth".
        
        Usage:
            global_ctx = ctx.get_global_context()
            project_path = global_ctx.get_project_path()
        
        Returns:
            GlobalContext containing project state
        """
        try:
            from context.global_context_service import GlobalContextService
            return GlobalContextService().get_global_context()
        except ImportError:
            # Fallback if context package not available
            from dataclasses import dataclass
            
            @dataclass
            class FallbackContext:
                project_id = self.project_id
                task_id = self.task_id
                project_path = None
                user_preferences = self.user_preferences
                
                def get_project_path(self):
                    return self.project_path
            
            return FallbackContext()
    
    async def search_project_memory(self, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        """
        RAG-enhanced memory retrieval (Pull-based context).
        
        Phase 6.5: Context Evolution (Hybrid Middleware)
        
        This replaces the old "push 15 memories into prompt" approach.
        Agents call this when they need to remember something.
        
        Args:
            query: Search query describing what to remember
            limit: Maximum number of results
        
        Returns:
            List of relevant memory dicts
        """
        try:
            from context.memory_tools import SearchProjectMemoryTool
            
            tool = SearchProjectMemoryTool(project_id=self.project_id)
            result = await tool.asearch(query, limit)
            
            # Return as structured list if possible
            return [{"content": result, "query": query}]
        except ImportError:
            # Fallback if context package not available
            return []


# ═══════════════════════════════════════════════════════════════════════════════
# ATOMIC NODE BASE CLASS
# ═══════════════════════════════════════════════════════════════════════════════

T = TypeVar('T', bound=NodeExecutionContext)


class AtomicNode(ABC, Generic[T]):
    """
    Base class for all atomic nodes in The Nexus.
    
    Inspired by n8n's INodeType interface.
    Reference: packages/workflow/src/Interfaces.ts (INodeType)
    
    This provides a clean separation of:
    1. Node metadata (description) - what the node IS
    2. Node execution (execute) - what the node DOES
    3. Node triggers (trigger/poll) - event-driven activation
    
    MIGRATION NOTE: When converting legacy handlers from node_registry.py,
    comment out the old handler but keep it for rollback.
    """
    
    # ───────────────────────────────────────────────────────────────────────────
    # CLASS ATTRIBUTES (Node Description)
    # ───────────────────────────────────────────────────────────────────────────
    
    # Unique identifier (e.g., "httpRequest", "researcher")
    type_id: str = ""
    
    # Display name shown in UI
    display_name: str = ""
    
    # Node description
    description: str = ""
    
    # Category for grouping (e.g., "research", "implementation")
    category: str = "general"
    
    # Icon identifier
    icon: str = "⚡"
    
    # Node version (for migrations)
    version: float = 1.0
    
    # Default input/output configuration
    default_inputs: List[str] = ["main"]
    default_outputs: List[str] = ["main"]
    
    # Execution level constraints: which workflow builder tabs show this node
    # Valid values: "dashboard", "project", "task"
    levels: List[str] = ["dashboard", "project", "task"]
    
    # Node type for UI badge classification
    # Valid values: "atomic", "fleet", "orchestrator", "utility"
    node_type: str = "atomic"
    
    # Default model used by this node (for display in Agent Manager)
    default_model: str = ""
    
    # ───────────────────────────────────────────────────────────────────────────
    # ABSTRACT METHODS
    # ───────────────────────────────────────────────────────────────────────────
    
    @abstractmethod
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """
        Execute the node's main logic.
        
        Args:
            ctx: Execution context with workflow/node info and helpers
            items: Input data from connected nodes
            
        Returns:
            List of output arrays (one per output connection)
            e.g., [[output_item_1, output_item_2]] for single output
        """
        pass
    
    # ───────────────────────────────────────────────────────────────────────────
    # OPTIONAL METHODS (Override as needed)
    # ───────────────────────────────────────────────────────────────────────────
    
    async def trigger(self, ctx: NodeExecutionContext) -> Optional[List[NodeExecutionData]]:
        """
        Event-driven trigger (e.g., webhook received).
        Override for trigger nodes.
        """
        return None
    
    async def poll(self, ctx: NodeExecutionContext) -> Optional[List[NodeExecutionData]]:
        """
        Polling trigger (e.g., check for new items on schedule).
        Override for polling nodes.
        
        Use ctx.get_static_data() to remember last polled state.
        """
        return None
    
    def get_description(self) -> Dict[str, Any]:
        """
        Get the full node description for UI/registry.
        Mirrors n8n's INodeTypeDescription.
        
        Properties are auto-merged: base class properties + subclass properties.
        """
        return {
            "type": self.type_id,
            "displayName": self.display_name,
            "description": self.description,
            "category": self.category,
            "icon": self.icon,
            "version": self.version,
            "inputs": self.default_inputs,
            "outputs": self.default_outputs,
            "levels": self.levels,
            "node_type": self.node_type,  # For UI badge classification
            "model": self.default_model,  # For Model column display
            # Merge base properties + subclass properties
            "properties": self._get_base_properties() + self.get_properties(),
        }
    
    def _get_base_properties(self) -> List[Dict[str, Any]]:
        """
        Base properties that ALL nodes have.
        These are automatically prepended to subclass properties.
        """
        return [
            {
                "displayName": "Applicable Levels",
                "name": "levels",
                "type": "multiOptions",
                "default": self.levels,
                "description": "Which workflow builder tabs show this node",
                "options": [
                    {"name": "Dashboard", "value": "dashboard", "description": "Dashboard-level initiatives"},
                    {"name": "Project", "value": "project", "description": "Project-wide workflows"},
                    {"name": "Task", "value": "task", "description": "Individual task execution"},
                ],
            }
        ]
    
    def get_properties(self) -> List[Dict[str, Any]]:
        """
        Get node-specific property definitions for the config panel.
        Override in subclasses to define UI parameters.
        
        NOTE: Base properties (like 'levels') are automatically prepended.
        """
        return []


# ═══════════════════════════════════════════════════════════════════════════════
# EXECUTION LIFECYCLE HOOKS (from n8n execution-lifecycle-hooks.ts)
# ═══════════════════════════════════════════════════════════════════════════════

class ExecutionLifecycleHooks:
    """
    Hooks for observing and modifying execution lifecycle.
    Reference: packages/cli/src/execution-lifecycle/execution-lifecycle-hooks.ts
    
    Allows external systems to:
    - Log execution events
    - Modify behavior at key points
    - Handle errors gracefully
    """
    
    def __init__(self):
        self._hooks: Dict[str, List[callable]] = {
            "workflow_execute_before": [],
            "workflow_execute_after": [],
            "node_execute_before": [],
            "node_execute_after": [],
            "node_execute_error": [],
        }
    
    def add_hook(self, event: str, handler: callable) -> None:
        """Register a hook for a lifecycle event."""
        if event in self._hooks:
            self._hooks[event].append(handler)
    
    async def run_hooks(self, event: str, *args, **kwargs) -> None:
        """Execute all hooks for an event."""
        for handler in self._hooks.get(event, []):
            try:
                result = handler(*args, **kwargs)
                if hasattr(result, '__await__'):
                    await result
            except Exception as e:
                # Log but don't fail execution
                print(f"Hook error on {event}: {e}")
