"""
Memory Nodes - Phase 7: Memory Systems

n8n-inspired memory nodes for LangChain integration.
Reference: packages/@n8n/nodes-langchain/nodes/memory/

Key patterns from n8n:
1. MemoryBufferWindow - Simple in-memory buffer with session keys
2. MemoryManager - Orchestrates memory operations (get/update/clear)
3. Session-based isolation - Multiple conversations don't interfere

This module provides atomic memory nodes that can be used in workflows.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from enum import Enum
import threading


# ═══════════════════════════════════════════════════════════════════════════
# MEMORY TYPES
# ═══════════════════════════════════════════════════════════════════════════

class MemoryType(str, Enum):
    """Available memory types."""
    BUFFER_WINDOW = "buffer_window"
    SUMMARY = "summary"
    ENTITY = "entity"
    CONVERSATION = "conversation"


# ═══════════════════════════════════════════════════════════════════════════
# BASE MEMORY INTERFACE
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class MemoryMessage:
    """A single message in memory."""
    role: str  # "human" | "ai" | "system"
    content: str
    timestamp: datetime = field(default_factory=datetime.utcnow)
    metadata: Dict[str, Any] = field(default_factory=dict)


class BaseMemory(ABC):
    """Base class for all memory implementations."""
    
    @abstractmethod
    async def add_message(self, role: str, content: str, **metadata) -> None:
        """Add a message to memory."""
        pass
    
    @abstractmethod
    async def get_messages(self, limit: Optional[int] = None) -> List[MemoryMessage]:
        """Get messages from memory."""
        pass
    
    @abstractmethod
    async def clear(self) -> None:
        """Clear all messages from memory."""
        pass
    
    @abstractmethod
    def get_memory_variables(self) -> Dict[str, Any]:
        """Get memory as variables for LangChain."""
        pass


# ═══════════════════════════════════════════════════════════════════════════
# BUFFER WINDOW MEMORY (n8n: MemoryBufferWindow)
# ═══════════════════════════════════════════════════════════════════════════

class BufferWindowMemory(BaseMemory):
    """
    Simple sliding window buffer memory.
    
    Reference: packages/@n8n/nodes-langchain/nodes/memory/MemoryBufferWindow/MemoryBufferWindow.node.ts
    
    Stores the last K messages (conversation turns).
    """
    
    def __init__(
        self,
        k: int = 5,
        memory_key: str = "chat_history",
        input_key: str = "input",
        output_key: str = "output",
        return_messages: bool = True
    ):
        """
        Initialize buffer window memory.
        
        Args:
            k: Number of conversation turns to keep
            memory_key: Key for memory variable
            input_key: Key for human input
            output_key: Key for AI output
            return_messages: Whether to return as message objects
        """
        self.k = k
        self.memory_key = memory_key
        self.input_key = input_key
        self.output_key = output_key
        self.return_messages = return_messages
        
        self._messages: List[MemoryMessage] = []
        self._lock = threading.Lock()
    
    async def add_message(self, role: str, content: str, **metadata) -> None:
        """Add a message to the buffer."""
        with self._lock:
            self._messages.append(MemoryMessage(
                role=role,
                content=content,
                metadata=metadata
            ))
            
            # Maintain window size (k turns = 2*k messages for human+ai)
            max_messages = self.k * 2
            if len(self._messages) > max_messages:
                self._messages = self._messages[-max_messages:]
    
    async def add_ai_message(self, content: str, **metadata) -> None:
        """Convenience: Add an AI message."""
        await self.add_message("ai", content, **metadata)
    
    async def add_human_message(self, content: str, **metadata) -> None:
        """Convenience: Add a human message."""
        await self.add_message("human", content, **metadata)
    
    async def get_messages(self, limit: Optional[int] = None) -> List[MemoryMessage]:
        """Get messages from the buffer."""
        with self._lock:
            msgs = self._messages.copy()
        
        if limit and len(msgs) > limit:
            return msgs[-limit:]
        return msgs
    
    async def clear(self) -> None:
        """Clear all messages."""
        with self._lock:
            self._messages.clear()
    
    def get_memory_variables(self) -> Dict[str, Any]:
        """Get memory as LangChain-compatible variables."""
        with self._lock:
            if self.return_messages:
                return {
                    self.memory_key: [
                        {"role": m.role, "content": m.content}
                        for m in self._messages
                    ]
                }
            else:
                # Return as formatted string
                history_str = "\n".join([
                    f"{m.role.upper()}: {m.content}"
                    for m in self._messages
                ])
                return {self.memory_key: history_str}


# ═══════════════════════════════════════════════════════════════════════════
# MEMORY BUFFER SINGLETON (n8n pattern)
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class MemoryBufferEntry:
    """Entry in the memory buffer singleton."""
    buffer: BufferWindowMemory
    created: datetime
    last_accessed: datetime


class MemoryBufferSingleton:
    """
    Singleton for managing multiple memory buffers across sessions.
    
    Reference: MemoryChatBufferSingleton in MemoryBufferWindow.node.ts
    
    This allows multiple workflows/sessions to have isolated memory.
    """
    
    _instance: Optional["MemoryBufferSingleton"] = None
    _lock = threading.Lock()
    
    def __new__(cls) -> "MemoryBufferSingleton":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        self._buffers: Dict[str, MemoryBufferEntry] = {}
        self._cleanup_interval = timedelta(hours=1)
        self._initialized = True
    
    async def get_memory(
        self,
        session_key: str,
        k: int = 5,
        memory_key: str = "chat_history"
    ) -> BufferWindowMemory:
        """
        Get or create a memory buffer for a session.
        
        Args:
            session_key: Unique session identifier
            k: Context window length
            memory_key: Key for memory variable
        
        Returns:
            BufferWindowMemory instance
        """
        await self._cleanup_stale_buffers()
        
        with self._lock:
            if session_key in self._buffers:
                entry = self._buffers[session_key]
                entry.last_accessed = datetime.utcnow()
                return entry.buffer
            
            # Create new buffer
            buffer = BufferWindowMemory(k=k, memory_key=memory_key)
            self._buffers[session_key] = MemoryBufferEntry(
                buffer=buffer,
                created=datetime.utcnow(),
                last_accessed=datetime.utcnow()
            )
            return buffer
    
    async def _cleanup_stale_buffers(self) -> None:
        """Remove buffers that haven't been accessed in an hour."""
        cutoff = datetime.utcnow() - self._cleanup_interval
        
        with self._lock:
            stale_keys = [
                key for key, entry in self._buffers.items()
                if entry.last_accessed < cutoff
            ]
            for key in stale_keys:
                await self._buffers[key].buffer.clear()
                del self._buffers[key]
    
    def get_session_count(self) -> int:
        """Get number of active sessions."""
        with self._lock:
            return len(self._buffers)
    
    async def clear_session(self, session_key: str) -> bool:
        """Clear a specific session's memory."""
        with self._lock:
            if session_key in self._buffers:
                await self._buffers[session_key].buffer.clear()
                del self._buffers[session_key]
                return True
            return False
    
    async def clear_all(self) -> int:
        """Clear all sessions. Returns count cleared."""
        with self._lock:
            count = len(self._buffers)
            for entry in self._buffers.values():
                await entry.buffer.clear()
            self._buffers.clear()
            return count


# ═══════════════════════════════════════════════════════════════════════════
# MEMORY MANAGER NODE (n8n: MemoryManager)
# ═══════════════════════════════════════════════════════════════════════════

class MemoryOperation(str, Enum):
    """Available memory operations."""
    GET = "get"
    INSERT = "insert"
    DELETE = "delete"


class MemoryManager:
    """
    Memory manager for workflow operations.
    
    Reference: packages/@n8n/nodes-langchain/nodes/memory/MemoryManager/
    
    Provides operations to get, insert, and delete memories.
    """
    
    def __init__(self, supabase_client=None):
        """
        Initialize memory manager.
        
        Args:
            supabase_client: Optional Supabase client for persistent memory
        """
        self.supabase = supabase_client
        self._buffer_singleton = MemoryBufferSingleton()
    
    async def get_buffer_memory(
        self,
        session_key: str,
        k: int = 5
    ) -> BufferWindowMemory:
        """Get a buffer memory for a session."""
        return await self._buffer_singleton.get_memory(session_key, k)
    
    async def get_messages(
        self,
        session_key: str,
        limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Get messages from a session's memory.
        
        Args:
            session_key: Session identifier
            limit: Optional message limit
        
        Returns:
            List of message dicts
        """
        memory = await self._buffer_singleton.get_memory(session_key)
        messages = await memory.get_messages(limit)
        
        return [
            {
                "role": m.role,
                "content": m.content,
                "timestamp": m.timestamp.isoformat(),
                "metadata": m.metadata
            }
            for m in messages
        ]
    
    async def insert_message(
        self,
        session_key: str,
        role: str,
        content: str,
        **metadata
    ) -> bool:
        """
        Insert a message into a session's memory.
        
        Args:
            session_key: Session identifier
            role: Message role (human/ai/system)
            content: Message content
            **metadata: Additional metadata
        
        Returns:
            True if successful
        """
        memory = await self._buffer_singleton.get_memory(session_key)
        await memory.add_message(role, content, **metadata)
        
        # Optionally persist to database
        if self.supabase:
            try:
                self.supabase.client.table("memory_messages").insert({
                    "session_key": session_key,
                    "role": role,
                    "content": content,
                    "metadata": metadata,
                    "created_at": datetime.utcnow().isoformat()
                }).execute()
            except Exception as e:
                print(f"[MemoryManager] Failed to persist message: {e}")
        
        return True
    
    async def delete_session(self, session_key: str) -> bool:
        """
        Delete all messages for a session.
        
        Args:
            session_key: Session identifier
        
        Returns:
            True if session existed and was deleted
        """
        result = await self._buffer_singleton.clear_session(session_key)
        
        # Also clear from database
        if self.supabase and result:
            try:
                self.supabase.client.table("memory_messages").delete().eq(
                    "session_key", session_key
                ).execute()
            except Exception as e:
                print(f"[MemoryManager] Failed to delete persisted messages: {e}")
        
        return result
    
    def get_active_session_count(self) -> int:
        """Get count of active memory sessions."""
        return self._buffer_singleton.get_session_count()


# ═══════════════════════════════════════════════════════════════════════════
# CONVENIENCE FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

def get_memory_manager(supabase_client=None) -> MemoryManager:
    """Get a memory manager instance."""
    return MemoryManager(supabase_client)


async def get_session_memory(
    workflow_id: str,
    session_id: str,
    k: int = 5
) -> BufferWindowMemory:
    """
    Get session memory using n8n's key pattern.
    
    Args:
        workflow_id: Workflow ID
        session_id: Session ID
        k: Context window length
    
    Returns:
        BufferWindowMemory for the session
    """
    session_key = f"{workflow_id}__{session_id}"
    singleton = MemoryBufferSingleton()
    return await singleton.get_memory(session_key, k)
