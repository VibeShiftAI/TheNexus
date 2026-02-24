"""
Memory Nodes Package - Phase 7: Memory Systems

n8n-inspired memory nodes for LangChain integration.
Provides session-based memory with automatic cleanup.

Usage:
    from nodes.memory import (
        BufferWindowMemory,
        MemoryBufferSingleton,
        MemoryManager,
        get_session_memory
    )
    
    # Get session-isolated memory
    memory = await get_session_memory(workflow_id, session_id, k=5)
    
    # Add messages
    await memory.add_human_message("Hello!")
    await memory.add_ai_message("Hi there!")
    
    # Get for LangChain
    variables = memory.get_memory_variables()
"""

from .memory_nodes import (
    # Types
    MemoryType,
    MemoryOperation,
    MemoryMessage,
    
    # Base
    BaseMemory,
    
    # Buffer Memory
    BufferWindowMemory,
    MemoryBufferSingleton,
    MemoryBufferEntry,
    
    # Memory Manager
    MemoryManager,
    
    # Convenience
    get_memory_manager,
    get_session_memory,
)

__all__ = [
    # Types
    "MemoryType",
    "MemoryOperation",
    "MemoryMessage",
    
    # Base
    "BaseMemory",
    
    # Buffer Memory
    "BufferWindowMemory",
    "MemoryBufferSingleton",
    "MemoryBufferEntry",
    
    # Memory Manager
    "MemoryManager",
    
    # Convenience
    "get_memory_manager",
    "get_session_memory",
]
