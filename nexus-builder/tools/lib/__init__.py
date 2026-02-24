"""
Tool Libraries - Organized collections of NexusTool implementations.

Each module in this package provides tools for a specific domain:
- system: File operations, commands (Node.js bridge)
- research: Web search, documentation scraping
- code_analysis: AST parsing, symbol search
- file_editing: File creation/editing
- subagents: Meta-tools that spawn sub-LLM calls
- workflow: AI Workflow Builder tools
"""

# Lazy imports to avoid circular dependencies
# Each module defines register_tools(registry)

__all__ = [
    'system',
    'research', 
    'code_analysis',
    'file_editing',
    'subagents',
    'workflow',
]
