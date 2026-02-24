"""
Memory Buffer Window Node - Phase 7: Memory Systems

Atomic node wrapper for BufferWindowMemory.
Reference: packages/@n8n/nodes-langchain/nodes/memory/MemoryBufferWindow/

This exposes the memory buffer as an atomic node that can be used in workflows.
"""

from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field

from nodes.core.base import AtomicNode, NodeExecutionContext, NodeExecutionData
from nodes.core.schema import (
    NodeDescription, NodeProperty, PropertyType, PropertyOption, DisplayCondition,
    string_property, number_property, options_property
)
from .memory_nodes import MemoryBufferSingleton, BufferWindowMemory


# ═══════════════════════════════════════════════════════════════════════════
# MEMORY BUFFER WINDOW NODE
# ═══════════════════════════════════════════════════════════════════════════

class MemoryBufferWindowNode(AtomicNode):
    """
    Simple Memory node - stores conversation history in memory.
    
    Reference: MemoryBufferWindow.node.ts
    
    Properties:
    - sessionIdType: How to determine session (fromInput, customKey)
    - sessionKey: Custom session key if sessionIdType is customKey
    - contextWindowLength: Number of conversation turns to remember
    """
    
    type_id = "memoryBufferWindow"
    category = "memory"
    levels = ["feature", "project"]
    
    @classmethod
    def get_description(cls) -> NodeDescription:
        return NodeDescription(
            display_name="Simple Memory",
            name="memoryBufferWindow",
            icon="fa:database",
            group="memory",
            version=1.0,
            description="Stores conversation history in memory. No external credentials required.",
            defaults={"name": "Simple Memory"},
            inputs=[],
            outputs=["ai_memory"],
            output_names=["Memory"],
            properties=cls.get_schema_properties()
        )
    
    @classmethod
    def get_schema_properties(cls) -> List[NodeProperty]:
        return [
            NodeProperty(
                display_name="Session ID Type",
                name="sessionIdType",
                type=PropertyType.OPTIONS,
                default="fromInput",
                description="How to identify the session",
                options=[
                    PropertyOption(name="From Input", value="fromInput"),
                    PropertyOption(name="Custom Key", value="customKey"),
                ]
            ),
            NodeProperty(
                display_name="Session Key",
                name="sessionKey",
                type=PropertyType.STRING,
                default="chat_history",
                description="The key to identify this session",
                display_options=DisplayCondition(show={"sessionIdType": ["customKey"]})
            ),
            number_property(
                name="contextWindowLength",
                display_name="Context Window Length",
                description="Number of conversation turns to keep in memory",
                default=5,
                min_value=1,
                max_value=100
            ),
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext
    ) -> List[NodeExecutionData]:
        """
        Execute the memory node - returns a memory instance.
        
        This node is typically used as a sub-node connected to an AI Agent.
        It supplies the memory instance rather than processing data.
        """
        # Get parameters
        session_id_type = ctx.get_node_parameter("sessionIdType", "fromInput")
        context_window = ctx.get_node_parameter("contextWindowLength", 5)
        
        # Determine session key
        if session_id_type == "fromInput":
            # Get from input data
            input_data = ctx.get_input_data()
            if input_data and len(input_data) > 0:
                session_id = input_data[0].json.get("sessionId", "default")
            else:
                session_id = "default"
        else:
            session_id = ctx.get_node_parameter("sessionKey", "chat_history")
        
        # Build unique session key with workflow context
        workflow_id = ctx.workflow.id if ctx.workflow else "unknown"
        full_session_key = f"{workflow_id}__{session_id}"
        
        # Get memory from singleton
        singleton = MemoryBufferSingleton()
        memory = await singleton.get_memory(
            session_key=full_session_key,
            k=context_window,
            memory_key="chat_history"
        )
        
        # Return memory reference (for AI Agent to consume)
        return [NodeExecutionData(json={
            "memory": memory,
            "session_key": full_session_key,
            "context_window": context_window,
            "memory_type": "buffer_window"
        })]


# ═══════════════════════════════════════════════════════════════════════════
# MEMORY MANAGER NODE
# ═══════════════════════════════════════════════════════════════════════════

class MemoryManagerNode(AtomicNode):
    """
    Memory Manager node - get, insert, or delete messages.
    
    Reference: packages/@n8n/nodes-langchain/nodes/memory/MemoryManager/
    
    Operations:
    - get: Retrieve messages from memory
    - insert: Add a message to memory
    - delete: Clear session memory
    """
    
    type_id = "memoryManager"
    category = "memory"
    levels = ["feature", "project"]
    
    @classmethod
    def get_description(cls) -> NodeDescription:
        return NodeDescription(
            display_name="Memory Manager",
            name="memoryManager",
            icon="fa:brain",
            group="memory",
            version=1.0,
            description="Manage conversation memory - get, insert, or delete messages",
            defaults={"name": "Memory Manager"},
            inputs=["main"],
            outputs=["main"],
            properties=cls.get_schema_properties()
        )
    
    @classmethod
    def get_schema_properties(cls) -> List[NodeProperty]:
        return [
            NodeProperty(
                display_name="Operation",
                name="operation",
                type=PropertyType.OPTIONS,
                default="get",
                description="Operation to perform",
                options=[
                    PropertyOption(name="Get Messages", value="get"),
                    PropertyOption(name="Insert Message", value="insert"),
                    PropertyOption(name="Delete Session", value="delete"),
                ]
            ),
            string_property(
                name="sessionKey",
                display_name="Session Key",
                description="The session to operate on",
                default="",
                required=True
            ),
            # For insert operation
            NodeProperty(
                display_name="Message Role",
                name="messageRole",
                type=PropertyType.OPTIONS,
                default="human",
                description="Role of the message",
                options=[
                    PropertyOption(name="Human", value="human"),
                    PropertyOption(name="AI", value="ai"),
                    PropertyOption(name="System", value="system"),
                ],
                display_options=DisplayCondition(show={"operation": ["insert"]})
            ),
            NodeProperty(
                display_name="Message Content",
                name="messageContent",
                type=PropertyType.STRING,
                default="",
                description="Content of the message to insert",
                display_options=DisplayCondition(show={"operation": ["insert"]})
            ),
            # For get operation
            NodeProperty(
                display_name="Limit",
                name="limit",
                type=PropertyType.NUMBER,
                default=10,
                description="Maximum number of messages to retrieve",
                display_options=DisplayCondition(show={"operation": ["get"]})
            ),
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext
    ) -> List[NodeExecutionData]:
        """Execute memory manager operation."""
        from .memory_nodes import MemoryManager
        
        operation = ctx.get_node_parameter("operation", "get")
        session_key = ctx.get_node_parameter("sessionKey", "")
        
        if not session_key:
            return [NodeExecutionData(
                json={"error": "Session key is required"},
                error=Exception("Session key is required")
            )]
        
        manager = MemoryManager()
        
        if operation == "get":
            limit = ctx.get_node_parameter("limit", 10)
            messages = await manager.get_messages(session_key, limit)
            return [NodeExecutionData(json={
                "messages": messages,
                "session_key": session_key,
                "count": len(messages)
            })]
        
        elif operation == "insert":
            role = ctx.get_node_parameter("messageRole", "human")
            content = ctx.get_node_parameter("messageContent", "")
            
            success = await manager.insert_message(session_key, role, content)
            return [NodeExecutionData(json={
                "success": success,
                "session_key": session_key,
                "role": role
            })]
        
        elif operation == "delete":
            success = await manager.delete_session(session_key)
            return [NodeExecutionData(json={
                "success": success,
                "session_key": session_key,
                "deleted": success
            })]
        
        return [NodeExecutionData(json={"error": f"Unknown operation: {operation}"})]
