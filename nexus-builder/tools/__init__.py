"""
Unified Tool Interface for Praxis Agents.

This package provides:
- NexusTool: Abstract base class for all tools
- ToolRegistry: Singleton registry for tool discovery
- Tool libraries: system, research, code_analysis, workflow, etc.

Usage:
    from tools import get_registry, NexusTool, ToolCategory
    
    registry = get_registry()
    tools = registry.get_langchain_tools(["read_file", "web_search"])
"""

from .interface import NexusTool, ToolMetadata, ToolCategory
from .registry import ToolRegistry, get_registry

__all__ = [
    'NexusTool',
    'ToolMetadata', 
    'ToolCategory',
    'ToolRegistry',
    'get_registry',
]
