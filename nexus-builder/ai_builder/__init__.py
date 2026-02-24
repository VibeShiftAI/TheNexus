"""
AI Workflow Builder - Phase 8: AI-Assisted Workflow Creation

A multi-agent system for AI-assisted workflow and agent creation.
Inspired by n8n's AI Workflow Builder (packages/@n8n/ai-workflow-builder.ee/).

Architecture:
    SUPERVISOR
       │
   ┌───┼───┬───────────┐
   ▼   ▼   ▼           ▼
 DISCOVERY  BUILDER  CONFIGURATOR  RESPONDER
 (Find     (Create   (Set params)  (Synthesize
  nodes)   structure)              response)

Usage:
    from ai_builder import handle_builder_request
    
    result = await handle_builder_request(
        session_id="user-123",
        user_request="Create a workflow that sends email when a new task is created"
    )
"""

from .supervisor import WorkflowBuilderSupervisor
from .state import BuilderState, BuilderMessage, WorkflowCanvas, create_initial_builder_state
from .graph import build_workflow_builder_graph, run_workflow_builder
from .session_manager import SessionManager, BuilderSession, get_session_manager, handle_builder_request
from .tools import (
    DISCOVERY_TOOLS, BUILDER_TOOLS, CONFIGURATOR_TOOLS, ALL_TOOLS,
    apply_operations_to_workflow
)

__all__ = [
    # Core classes
    "WorkflowBuilderSupervisor",
    "BuilderState",
    "BuilderMessage",
    "WorkflowCanvas",
    
    # Graph
    "build_workflow_builder_graph",
    "run_workflow_builder",
    
    # Session management
    "SessionManager",
    "BuilderSession",
    "get_session_manager",
    "handle_builder_request",
    
    # State creation
    "create_initial_builder_state",
    
    # Tools
    "DISCOVERY_TOOLS",
    "BUILDER_TOOLS",
    "CONFIGURATOR_TOOLS",
    "ALL_TOOLS",
    "apply_operations_to_workflow",
]
