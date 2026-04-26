"""
NexusTool Interface - Abstract base class for all Praxis tools.

This module defines the core abstraction for tools in the Praxis Cooperative Mesh.
All tools implement the NexusTool interface, which provides:
- Discoverable metadata for UI/registry display
- Standardized execution with context injection
- LangChain compatibility for LangGraph integration

Aligns with Society of Minds blueprint:
- Node A5 (Source Strategist): Routes tasks to correct tool channels
- Node B2 (Recursive Browser): Unified web interaction tools
- Node B5 (Code Sandbox): Standardized execution interface
"""

from abc import ABC, abstractmethod
from enum import Enum
from typing import Any, Dict, Optional, List, Callable, TYPE_CHECKING
from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool


class ToolCategory(str, Enum):
    """
    Categories for organizing tools in the registry.
    
    Used for filtering and grouping in the UI and for
    capability-based tool selection by agents.
    """
    FILESYSTEM = "filesystem"
    COMMAND = "command"
    SEARCH = "search"
    RESEARCH = "research"
    CODE_ANALYSIS = "code_analysis"
    CODE_EXECUTION = "code_execution"  # Sandbox execution tools
    GIT = "git"
    SUBAGENT = "subagent"  # Tools that spawn sub-LLM calls
    WORKFLOW = "workflow"  # AI Workflow Builder tools
    BLACKBOARD = "blackboard"  # Shared state management tools
    VERIFICATION = "verification"  # Fact checking and validation tools
    MEDIA = "media"  # Image/video/audio generation, assembly, and publishing


class ToolMetadata(BaseModel):
    """
    Discoverable metadata for UI/registry display.
    
    This schema enables:
    - Dynamic tool documentation in the UI
    - Permission-based execution control
    - Cost estimation for usage tracking
    
    Attributes:
        name: Machine-readable tool identifier
        description: Human-readable description for LLM prompts
        category: ToolCategory for grouping
        can_auto_execute: Safe to run without human approval?
        requires_permission: Needs explicit user consent?
        estimated_cost: "free", "low", "medium", "high"
        tags: Optional list of tags for search/filtering
    """
    name: str
    description: str
    category: ToolCategory
    can_auto_execute: bool = False
    requires_permission: bool = True
    estimated_cost: Optional[str] = None
    tags: List[str] = Field(default_factory=list)


class NexusTool(ABC):
    """
    Abstract base class for all Praxis tools.
    
    Implements the Contract Net Protocol pattern for tool discovery
    and standardized execution with context injection.
    
    Usage:
        class ReadFileTool(NexusTool):
            @property
            def metadata(self) -> ToolMetadata:
                return ToolMetadata(
                    name="read_file",
                    description="Read file contents",
                    category=ToolCategory.FILESYSTEM,
                )
            
            async def execute(self, context, path: str) -> Dict[str, Any]:
                # Implementation here
                return {"success": True, "result": content}
    """
    
    @property
    @abstractmethod
    def metadata(self) -> ToolMetadata:
        """
        Return discoverable metadata for this tool.
        
        Returns:
            ToolMetadata with name, description, category, and permissions.
        """
        pass
    
    @abstractmethod
    async def execute(self, context: Dict[str, Any], **kwargs) -> Dict[str, Any]:
        """
        Execute the tool with context injection.
        
        Args:
            context: Execution context containing:
                - project_root: Path to project directory
                - task_id: Current task identifier
                - project_context: Full context from Nexus
            **kwargs: Tool-specific arguments
            
        Returns:
            Dict with:
                - success: bool indicating success/failure
                - result: Tool output on success
                - error: Error message on failure
        """
        pass
    
    def to_langchain_tool(self) -> "BaseTool":
        """
        Convert to LangChain-compatible tool for LangGraph ToolNode.
        
        This enables seamless integration with existing LangGraph
        workflows that use bind_tools() and ToolNode.
        
        Returns:
            LangChain StructuredTool wrapping this NexusTool.
        """
        from langchain_core.tools import StructuredTool
        from pydantic import create_model
        import inspect
        from typing import Any
        
        sig = inspect.signature(self.execute)
        fields = {}
        for name, param in sig.parameters.items():
            if name in ("self", "context") or param.kind == inspect.Parameter.VAR_KEYWORD:
                continue
                
            annotation = param.annotation
            if annotation == inspect.Parameter.empty or isinstance(annotation, str):
                annotation = Any
                
            if param.default == inspect.Parameter.empty:
                fields[name] = (annotation, ...)
            else:
                fields[name] = (annotation, param.default)
                
        args_schema = create_model(f"{self.__class__.__name__}Schema", **fields)
        
        return StructuredTool.from_function(
            coroutine=self._langchain_wrapper,
            name=self.metadata.name,
            description=self.metadata.description,
            args_schema=args_schema,
        )
    
    async def _langchain_wrapper(self, **kwargs) -> str:
        """
        Internal wrapper for LangChain compatibility.
        
        Executes the tool with empty context (context will be
        injected by FleetAgentNode or similar orchestrator).
        
        Returns:
            String result for LangChain message format.
        """
        result = await self.execute({}, **kwargs)
        if result.get("success"):
            return str(result.get("result", "OK"))
        return f"Error: {result.get('error', 'Unknown error')}"
    
    @classmethod
    def from_langchain_tool(cls, lc_tool: "BaseTool", metadata: ToolMetadata) -> "NexusTool":
        """
        Create a NexusTool wrapper from an existing LangChain tool.
        
        Args:
            lc_tool: LangChain BaseTool to wrap
            metadata: ToolMetadata for registry
            
        Returns:
            NexusTool instance wrapping the LangChain tool
        """
        return LangChainToolWrapper(lc_tool, metadata)


class LangChainToolWrapper(NexusTool):
    """
    Wrapper to adapt LangChain tools to NexusTool interface.
    """
    
    def __init__(self, lc_tool: "BaseTool", meta: ToolMetadata):
        self._lc_tool = lc_tool
        self._metadata = meta
    
    @property
    def metadata(self) -> ToolMetadata:
        return self._metadata
    
    async def execute(self, context: Dict[str, Any], **kwargs) -> Dict[str, Any]:
        try:
            result = await self._lc_tool.ainvoke(kwargs)
            return {"success": True, "result": result}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    def to_langchain_tool(self) -> "BaseTool":
        return self._lc_tool
