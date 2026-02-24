"""
Sandbox Tools Library - Code execution in isolated containers.

Provides:
- execute_python: Run Python code
- execute_nodejs: Run Node.js code
- execute_r: Run R code
- execute_bash: Run bash commands
"""

from ..interface import NexusTool, ToolMetadata, ToolCategory
from ..code_interpreter import (
    execute_python,
    execute_nodejs,
    execute_r,
    execute_bash,
)


def register_tools(registry):
    """Register sandbox execution tools."""
    
    # Wrap LangChain tools as NexusTool
    tools = [
        NexusTool.from_langchain_tool(
            execute_python,
            ToolMetadata(
                name="execute_python",
                description="Execute Python code in a secure, network-isolated sandbox.",
                category=ToolCategory.CODE_EXECUTION,
            ),
        ),
        NexusTool.from_langchain_tool(
            execute_nodejs,
            ToolMetadata(
                name="execute_nodejs",
                description="Execute JavaScript in a secure Node.js sandbox.",
                category=ToolCategory.CODE_EXECUTION,
            ),
        ),
        NexusTool.from_langchain_tool(
            execute_r,
            ToolMetadata(
                name="execute_r",
                description="Execute R code in a secure sandbox with tidyverse.",
                category=ToolCategory.CODE_EXECUTION,
            ),
        ),
        NexusTool.from_langchain_tool(
            execute_bash,
            ToolMetadata(
                name="execute_bash",
                description="Execute bash commands in a secure sandbox.",
                category=ToolCategory.CODE_EXECUTION,
            ),
        ),
    ]
    
    for tool in tools:
        registry.register(tool)
