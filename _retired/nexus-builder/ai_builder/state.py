"""
AI Workflow Builder State - Phase 8

State management for the AI Workflow Builder multi-agent system.
Reference: packages/@n8n/ai-workflow-builder.ee/src/workflow-state.ts
           packages/@n8n/ai-workflow-builder.ee/src/parent-graph-state.ts

Key Design Decisions:
1. Separate from WorkflowState (task execution) - this is for building workflows
2. Tracks the workflow being constructed, not the workflow being executed
3. Includes messages history for multi-turn conversation
"""

from typing import Any, Dict, List, Optional, TypedDict, Literal
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


# ═══════════════════════════════════════════════════════════════════════════
# MESSAGE TYPES
# ═══════════════════════════════════════════════════════════════════════════

class MessageRole(str, Enum):
    """Message role types."""
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


@dataclass
class BuilderMessage:
    """
    A message in the builder conversation.
    Reference: parent-graph-state.ts MessageItem
    """
    role: MessageRole
    content: str
    timestamp: datetime = field(default_factory=datetime.utcnow)
    tool_call_id: Optional[str] = None
    name: Optional[str] = None  # Tool name if role is TOOL
    metadata: Dict[str, Any] = field(default_factory=dict)


# ═══════════════════════════════════════════════════════════════════════════
# WORKFLOW NODE REPRESENTATION
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class WorkflowNode:
    """
    A node in the workflow being built.
    Reference: workflow-state.ts IWorkflowNode
    """
    id: str
    type: str
    name: str
    position: tuple = (0, 0)  # Canvas position
    parameters: Dict[str, Any] = field(default_factory=dict)
    credentials: Optional[Dict[str, Any]] = None
    notes: Optional[str] = None


@dataclass
class WorkflowConnection:
    """
    A connection between nodes.
    Reference: workflow-state.ts IConnection
    """
    source_node_id: str
    target_node_id: str
    source_output: int = 0
    target_input: int = 0


@dataclass
class WorkflowCanvas:
    """
    The workflow being constructed.
    Reference: workflow-state.ts WorkflowState
    """
    nodes: List[WorkflowNode] = field(default_factory=list)
    connections: List[WorkflowConnection] = field(default_factory=list)
    name: str = "New Workflow"
    description: str = ""
    
    def add_node(self, node: WorkflowNode) -> None:
        """Add a node to the canvas."""
        self.nodes.append(node)
    
    def add_connection(self, conn: WorkflowConnection) -> None:
        """Add a connection between nodes."""
        self.connections.append(conn)
    
    def get_node(self, node_id: str) -> Optional[WorkflowNode]:
        """Get a node by ID."""
        for node in self.nodes:
            if node.id == node_id:
                return node
        return None
    
    def remove_node(self, node_id: str) -> bool:
        """Remove a node and its connections."""
        # Remove connections involving this node
        self.connections = [
            c for c in self.connections
            if c.source_node_id != node_id and c.target_node_id != node_id
        ]
        # Remove the node
        original_count = len(self.nodes)
        self.nodes = [n for n in self.nodes if n.id != node_id]
        return len(self.nodes) < original_count
    
    def to_dict(self) -> Dict[str, Any]:
        """Export to dictionary for JSON serialization."""
        return {
            "name": self.name,
            "description": self.description,
            "nodes": [
                {
                    "id": n.id,
                    "type": n.type,
                    "name": n.name,
                    "position": list(n.position),
                    "parameters": n.parameters,
                    "credentials": n.credentials,
                }
                for n in self.nodes
            ],
            "connections": [
                {
                    "sourceNodeId": c.source_node_id,
                    "sourceOutput": c.source_output,
                    "targetNodeId": c.target_node_id,
                    "targetInput": c.target_input,
                }
                for c in self.connections
            ],
        }


# ═══════════════════════════════════════════════════════════════════════════
# BUILDER STATE (LangGraph TypedDict)
# ═══════════════════════════════════════════════════════════════════════════

class BuilderState(TypedDict, total=False):
    """
    State for the AI Workflow Builder graph.
    Reference: parent-graph-state.ts ParentGraphState
    
    This tracks the multi-turn conversation and the workflow being constructed.
    """
    # Conversation history
    messages: List[Dict[str, Any]]  # Serializable message list
    
    # Current user request
    user_request: str
    
    # Supervisor routing
    next_agent: Literal["discovery", "builder", "configurator", "responder", "end"]
    supervisor_reasoning: str
    
    # The workflow being constructed
    workflow: Dict[str, Any]  # Serialized WorkflowCanvas
    
    # Discovery results (node search)
    discovered_nodes: List[Dict[str, Any]]
    node_search_query: str
    
    # Pending operations from builder
    pending_operations: List[Dict[str, Any]]
    
    # Configuration in progress
    config_node_id: str
    config_parameters: Dict[str, Any]
    
    # Session management
    session_id: str
    project_id: Optional[str]
    
    # Error handling
    error: Optional[str]
    
    # Completion
    final_response: str
    is_complete: bool


def create_initial_builder_state(
    user_request: str,
    session_id: str,
    project_id: Optional[str] = None,
    existing_workflow: Optional[Dict[str, Any]] = None
) -> BuilderState:
    """
    Create the initial state for a new builder session.
    
    Args:
        user_request: The user's natural language request
        session_id: Unique session identifier
        project_id: Optional project context
        existing_workflow: Optional existing workflow to modify
    
    Returns:
        Initialized BuilderState
    """
    canvas = WorkflowCanvas()
    if existing_workflow:
        # Hydrate from existing workflow
        canvas.name = existing_workflow.get("name", "Modified Workflow")
        canvas.description = existing_workflow.get("description", "")
        # TODO: Full hydration of nodes and connections
    
    return BuilderState(
        messages=[{
            "role": "user",
            "content": user_request,
            "timestamp": datetime.utcnow().isoformat()
        }],
        user_request=user_request,
        next_agent="discovery",  # Default to discovery for new requests
        supervisor_reasoning="",
        workflow=canvas.to_dict(),
        discovered_nodes=[],
        node_search_query="",
        pending_operations=[],
        config_node_id="",
        config_parameters={},
        session_id=session_id,
        project_id=project_id,
        error=None,
        final_response="",
        is_complete=False
    )
