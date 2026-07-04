"""
Fleet Agent Node - Base class for agents extracted from fleets.

This module provides the FleetAgentNode class which adapts legacy fleet
functions (scoper_node, cartographer_node, etc.) to work as standalone
AtomicNodes that can be used in custom workflows.

Key Features:
1. State Adapter: Maps NodeExecutionContext to legacy TypedDict states
2. Context Self-Loading: Loads project_context if not provided in inputs
3. Async/Sync Compatibility: Handles both sync and async legacy functions
4. Tool Loop Support: execute_with_tools() for agents that need LLM→Tool loops
"""

import asyncio
import inspect
from typing import Any, Dict, List, Optional, Callable

from .base import AtomicNode, NodeExecutionContext, NodeExecutionData
from ..utility.context_loader import read_project_contexts, get_repo_structure
from ..artifacts import ArtifactCategory, Artifact

# Unified tool registry integration
try:
    from tools import get_registry as _get_registry
    _REGISTRY_AVAILABLE = True
except ImportError:
    _REGISTRY_AVAILABLE = False
    _get_registry = None


class FleetAgentNode(AtomicNode):
    """
    Base class for agents extracted from fleets.
    
    Acts as an adapter between the AtomicNode execution model and legacy
    fleet functions that expect TypedDict states.
    
    Usage:
        class CartographerNode(FleetAgentNode):
            type_id = "architect_cartographer"
            display_name = "Cartographer"
            legacy_function = staticmethod(cartographer_node)
    """
    
    # Which fleet this agent was extracted from
    fleet_origin: str = ""
    
    # The original function to delegate to
    legacy_function: Optional[Callable] = None
    
    # Tools this agent uses (names for registry lookup, or raw tools)
    agent_tools: List[Any] = []  # Can be tool names (str) or LangChain tools
    
    @classmethod
    def get_tools_from_registry(cls, tool_names: List[str]) -> List[Any]:
        """
        Get LangChain tools from the unified registry by name.
        
        Usage:
            tools = FleetAgentNode.get_tools_from_registry(
                ["read_file", "web_search"]
            )
        """
        if not _REGISTRY_AVAILABLE:
            raise ImportError("tools.registry not available")
        registry = _get_registry()
        return registry.get_langchain_tools(tool_names)
    
    async def execute(
        self, 
        ctx: NodeExecutionContext, 
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """
        Default execution adapter:
        1. Builds 'legacy_state' from inputs + project context
        2. Calls the legacy function (handling sync/async)
        3. Wraps result in NodeExecutionData
        """
        # 1. Construct State from inputs
        input_payload = items[0].json if items else {}
        
        # Get global project context from NodeExecutionContext
        project_context = ctx.get_project_context()
        
        # Determine Project Root - check parameters first, then input, then fallback
        project_root = ctx.get_node_parameter(
            "project_root", 
            input_payload.get("context", {}).get("project_root",
                input_payload.get("project_root", "."))
        )
        
        # STRATEGY: Self-Load Context if missing
        # This allows the agent to work standalone on a blank canvas
        context_str = input_payload.get("project_context", "")
        if not context_str and project_root and project_root != ".":
            context_str = read_project_contexts(project_root)
            # Also inject global "Soul" context if available
            if project_context.get("full_context"):
                context_str += "\n" + project_context.get("full_context")
        
        # Self-load repo structure if missing
        repo_structure = input_payload.get("repo_structure", "")
        if not repo_structure and project_root and project_root != ".":
            repo_structure = get_repo_structure(project_root)
        
        # Build the state dict expected by legacy functions
        # Start with base required fields, then merge all inputs
        legacy_state = {
            # Core message history
            "messages": input_payload.get("messages", []),
            
            # Project identification
            "project_root": project_root,
            "task_title": ctx.get_node_parameter(
                "task_title", 
                input_payload.get("context", {}).get("task_title",
                    input_payload.get("task_title", ""))
            ),
            
            # Inject Project Context (The Nexus "Soul")
            "project_context": context_str,
            "repo_structure": repo_structure,
            
            # User request (common across research/architect agents)
            "user_request": input_payload.get("user_request", 
                input_payload.get("context", {}).get("user_request", "")),
            
            # Task description (common across builder/auditor agents)
            "task_description": input_payload.get("task_description",
                input_payload.get("context", {}).get("task_description", "")),
        }
        
        # Merge remaining input fields (preserves any custom state)
        for key, value in input_payload.items():
            if key not in legacy_state and key != "context":
                legacy_state[key] = value
        
        # Also merge context dict fields
        if "context" in input_payload and isinstance(input_payload["context"], dict):
            for key, value in input_payload["context"].items():
                if key not in legacy_state:
                    legacy_state[key] = value
        
        # 2. Execute Legacy Logic
        if not self.legacy_function:
            raise NotImplementedError(
                f"{self.display_name} has no legacy_function defined"
            )
        
        # CRITICAL: Handle both sync and async legacy functions
        # Research fleet uses sync, Architect/Builder/Auditor use async
        if inspect.iscoroutinefunction(self.legacy_function):
            result_state = await self.legacy_function(legacy_state)
        else:
            # Run sync function in thread pool to not block event loop
            loop = asyncio.get_event_loop()
            result_state = await loop.run_in_executor(
                None, self.legacy_function, legacy_state
            )
        
        # 3. Map Output
        output_data = NodeExecutionData(json=result_state)
        
        return [[output_data]]

    async def execute_with_tools(
        self, 
        ctx: NodeExecutionContext, 
        items: List[NodeExecutionData],
        tools: List[Any]
    ) -> List[List[NodeExecutionData]]:
        """
        Extended adapter for agents that need a tool loop (e.g. Cartographer).
        
        Runs a ReAct-style loop: LLM → Tool → LLM → Finish
        
        This is used by agents like:
        - Cartographer (uses search_codebase, read_file_signatures)
        - Research Executor (uses web_search, scrape_documentation)
        - Builder Scout (uses read_file_window, find_symbol)
        """
        from langgraph.prebuilt import ToolExecutor, ToolInvocation
        from langchain_core.messages import ToolMessage
        
        # 1. Construct Initial State (same as execute)
        input_payload = items[0].json if items else {}
        project_context = ctx.get_project_context()
        
        project_root = ctx.get_node_parameter(
            "project_root", 
            input_payload.get("context", {}).get("project_root",
                input_payload.get("project_root", "."))
        )
        
        context_str = input_payload.get("project_context", "")
        if not context_str and project_root and project_root != ".":
            context_str = read_project_contexts(project_root)
        
        legacy_state = {
            "messages": input_payload.get("messages", []),
            "project_root": project_root,
            "task_title": ctx.get_node_parameter("task_title", ""),
            "project_context": context_str,
            "repo_structure": input_payload.get("repo_structure", 
                get_repo_structure(project_root) if project_root != "." else ""),
            "user_request": input_payload.get("user_request", ""),
            **{k: v for k, v in input_payload.items() 
               if k not in ["messages", "project_root", "project_context", "repo_structure"]}
        }
        
        # 2. Create Tool Executor
        tool_executor = ToolExecutor(tools)
        
        # 3. ReAct Loop with limit
        max_steps = 5
        result_state = legacy_state
        
        for step in range(max_steps):
            # Call Agent
            if inspect.iscoroutinefunction(self.legacy_function):
                result_state = await self.legacy_function(legacy_state)
            else:
                loop = asyncio.get_event_loop()
                result_state = await loop.run_in_executor(
                    None, self.legacy_function, legacy_state
                )
            
            # Check for tool calls in the last message
            messages = result_state.get("messages", [])
            if not messages:
                break
                
            last_msg = messages[-1]
            
            # Check if message has tool_calls
            if not (hasattr(last_msg, 'tool_calls') and last_msg.tool_calls):
                # No tools called → We are done
                break
                
            # Execute Tools
            for tool_call in last_msg.tool_calls:
                try:
                    tool_result = await tool_executor.ainvoke(ToolInvocation(
                        tool=tool_call["name"],
                        tool_input=tool_call["args"]
                    ))
                except Exception as e:
                    tool_result = f"Error executing tool: {e}"
                
                # Append ToolMessage to state for next iteration
                legacy_state["messages"].append(ToolMessage(
                    tool_call_id=tool_call.get("id", "unknown"),
                    content=str(tool_result),
                    name=tool_call["name"]
                ))
        
        return [[NodeExecutionData(json=result_state)]]
    
    def get_description(self) -> Dict[str, Any]:
        """
        Return node description for the registry.
        Extends base with fleet-specific metadata.
        """
        base_desc = super().get_description() if hasattr(super(), 'get_description') else {}
        return {
            **base_desc,
            "type_id": self.type_id,
            "display_name": self.display_name,
            "description": self.description,
            "category": self.category,
            "icon": self.icon,
            "levels": getattr(self, 'levels', ["project", "task"]),
            "fleet_origin": self.fleet_origin,
        }
    
    # ═══════════════════════════════════════════════════════════════════════════
    # ARTIFACT METHODS (Universal Artifact System)
    # ═══════════════════════════════════════════════════════════════════════════
    
    def create_artifact(
        self,
        ctx: NodeExecutionContext,
        key: str,
        content: Any,
        name: str = "",
        category: ArtifactCategory = ArtifactCategory.CUSTOM,
        tags: Optional[List[str]] = None,
        **metadata
    ) -> Artifact:
        """
        Create and store an artifact from this node.
        
        Usage:
            artifact = self.create_artifact(
                ctx, 
                key="research_dossier",
                content=dossier_markdown,
                category=ArtifactCategory.DOCUMENT
            )
        
        Args:
            ctx: Node execution context
            key: Machine key for retrieval (e.g., "research_dossier")
            content: The content (str, dict, list, or bytes)
            name: Human-readable name (defaults to formatted key)
            category: ArtifactCategory for grouping
            tags: Optional list of tags
            **metadata: Additional metadata
        
        Returns:
            The stored Artifact
        """
        store = ctx.get_artifact_store()
        return store.store_simple(
            key=key,
            content=content,
            name=name,
            category=category,
            producer_node_id=ctx.node.id,
            producer_node_type=self.type_id,
            tags=tags,
            **metadata
        )
    
    def get_artifact(self, ctx: NodeExecutionContext, key: str, default: Any = None) -> Any:
        """
        Get artifact content by key.
        
        Usage:
            dossier = self.get_artifact(ctx, "research_dossier")
        
        Args:
            ctx: Node execution context
            key: The artifact key to retrieve
            default: Value to return if artifact not found
        
        Returns:
            The artifact content or default
        """
        store = ctx.get_artifact_store()
        return store.get_content(key, default)
    
    def get_artifact_full(self, ctx: NodeExecutionContext, key: str) -> Optional[Artifact]:
        """
        Get full Artifact object (with metadata) by key.
        
        Args:
            ctx: Node execution context
            key: The artifact key to retrieve
        
        Returns:
            The Artifact object or None
        """
        store = ctx.get_artifact_store()
        return store.get_by_key(key)
    
    def list_artifacts(self, ctx: NodeExecutionContext) -> List[str]:
        """
        List all available artifact keys.
        
        Args:
            ctx: Node execution context
        
        Returns:
            List of artifact keys
        """
        store = ctx.get_artifact_store()
        return store.list_keys()
    
    def has_artifact(self, ctx: NodeExecutionContext, key: str) -> bool:
        """
        Check if an artifact exists.
        
        Args:
            ctx: Node execution context
            key: The artifact key to check
        
        Returns:
            True if artifact exists
        """
        store = ctx.get_artifact_store()
        return store.exists(key)
