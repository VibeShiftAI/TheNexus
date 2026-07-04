"""
Workflow State - Shared state schema for LangGraph workflows

This defines the TypedDict that all nodes read from and write to.
Extended with Nexus Protocol fields for universal agent support.
"""

from typing import TypedDict, List, Dict, Any, Optional, Annotated
from langgraph.graph import add_messages


class WorkflowState(TypedDict):
    """
    Shared state that flows through all nodes in a workflow.
    
    Attributes:
        messages: Chat-style message history (for LLM context)
        current_step: ID of the current/last executed node
        context: Arbitrary context data (project info, feature details, etc.)
        outputs: Results from each node, keyed by node ID
        evaluator_decision: Decision for conditional routing
        
    Nexus Protocol Extensions:
        scratchpad: Internal monologue buffer for reasoning models
        artifacts: Structured outputs (charts, files, reports)
        retry_count: Counter for error handling loops
        custom_fields: User-defined domain-specific fields
        output_schema: Expected output format specification
        negative_constraints: "Do not..." guardrails for agent behavior
    """
    # Message history that accumulates across nodes
    messages: Annotated[List[Dict[str, Any]], add_messages]
    
    # Current execution state
    current_step: str
    
    # Context passed through the workflow
    context: Dict[str, Any]
    
    # Outputs from each node
    outputs: Dict[str, Any]
    
    # Evaluator decision for conditional routing (optional)
    evaluator_decision: Optional[str]
    
    # === Nexus Protocol Extensions ===
    
    # Internal monologue buffer for "Reasoning" models (Coding/Math)
    scratchpad: Optional[str]
    
    # Structured outputs from tools (charts, files, reports)
    artifacts: Optional[List[Dict[str, Any]]]
    
    # Counter for controlling error handling loops
    retry_count: Optional[int]
    
    # User-defined domain-specific fields (e.g., lead_score, candidate_rating)
    custom_fields: Optional[Dict[str, Any]]
    
    # Expected output format (JSON list, PDF report, spreadsheet row, etc.)
    output_schema: Optional[Dict[str, Any]]
    
    # "Do not..." guardrails for agent behavior
    negative_constraints: Optional[List[str]]
    
    # Nexus Protocol Extensions for dashboard/UI updates
    # Contains: status_update, status_color, etc. from Translation Layer
    nexus_protocol_extensions: Optional[Dict[str, Any]]
    
    # Human approval gate state
    # Contains: gate, artifact_type, artifact_preview, next_phase, message
    pending_approval: Optional[Dict[str, Any]]
