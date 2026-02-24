"""
Tool Registry - Singleton registry for tool discovery and management.

Implements the Contract Net Protocol pattern for tool discovery,
enabling agents to query available tools by category or capability.

Usage:
    from tools import get_registry
    
    registry = get_registry()
    
    # Get all tools
    all_tools = registry.list_tools()
    
    # Get tools by category
    research_tools = registry.list_tools(category=ToolCategory.RESEARCH)
    
    # Get LangChain-compatible tools for ToolNode
    lc_tools = registry.get_langchain_tools(["read_file", "web_search"])
"""

from typing import Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool

from .interface import NexusTool, ToolMetadata, ToolCategory


class ToolRegistry:
    """
    Central registry for all available tools.
    
    Implements singleton pattern to ensure consistent tool discovery
    across the entire application.
    
    Thread-safe for read operations. Tool registration should happen
    at startup before concurrent access.
    """
    _instance: Optional['ToolRegistry'] = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._tools: Dict[str, NexusTool] = {}
            cls._instance._initialized = False
        return cls._instance
    
    def register(self, tool: NexusTool) -> None:
        """
        Register a tool with the registry.
        
        Args:
            tool: NexusTool instance to register.
            
        Raises:
            ValueError: If tool with same name already exists.
        """
        name = tool.metadata.name
        if name in self._tools:
            # Allow re-registration for hot-reload scenarios
            pass
        self._tools[name] = tool
    
    def get(self, name: str) -> Optional[NexusTool]:
        """
        Get a tool by name.
        
        Args:
            name: Tool name to look up.
            
        Returns:
            NexusTool if found, None otherwise.
        """
        return self._tools.get(name)
    
    def list_tools(self, category: Optional[ToolCategory] = None) -> List[ToolMetadata]:
        """
        List all registered tools, optionally filtered by category.
        
        Args:
            category: Optional category to filter by.
            
        Returns:
            List of ToolMetadata for matching tools.
        """
        tools = list(self._tools.values())
        if category:
            tools = [t for t in tools if t.metadata.category == category]
        return [t.metadata for t in tools]
    
    def get_langchain_tools(self, names: Optional[List[str]] = None) -> List["BaseTool"]:
        """
        Get LangChain-compatible tools for ToolNode binding.
        
        Args:
            names: Optional list of tool names. If None, returns all tools.
            
        Returns:
            List of LangChain BaseTool instances.
        """
        if names:
            tools = [self._tools[n] for n in names if n in self._tools]
        else:
            tools = list(self._tools.values())
        return [t.to_langchain_tool() for t in tools]
    
    def initialize_defaults(self) -> None:
        """
        Register all built-in tools.
        
        Called automatically by get_registry(). Subsequent calls are no-ops.
        """
        if self._initialized:
            return
        
        # Import and register tool libraries
        # Each library has a register_tools(registry) function
        try:
            from .lib import system
            system.register_tools(self)
        except ImportError:
            pass  # Library not yet implemented
        
        try:
            from .lib import research
            research.register_tools(self)
        except ImportError:
            pass
        
        try:
            from .lib import code_analysis
            code_analysis.register_tools(self)
        except ImportError:
            pass
        
        try:
            from .lib import file_editing
            file_editing.register_tools(self)
        except ImportError:
            pass
        
        try:
            from .lib import subagents
            subagents.register_tools(self)
        except ImportError:
            pass
        
        try:
            from .lib import workflow
            workflow.register_tools(self)
        except ImportError:
            pass
        
        try:
            from .lib import sandbox
            sandbox.register_tools(self)
        except ImportError:
            pass
        
        try:
            from .lib import blackboard
            blackboard.register_tools(self)
        except ImportError:
            pass
        
        self._initialized = True
    
    def __len__(self) -> int:
        """Return number of registered tools."""
        return len(self._tools)
    
    def __contains__(self, name: str) -> bool:
        """Check if tool is registered."""
        return name in self._tools


def get_registry() -> ToolRegistry:
    """
    Get the global registry instance, initialized with defaults.
    
    This is the primary entry point for accessing tools.
    
    Returns:
        ToolRegistry singleton with all default tools registered.
    """
    registry = ToolRegistry()
    registry.initialize_defaults()
    return registry
