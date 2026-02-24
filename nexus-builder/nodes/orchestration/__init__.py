"""
Orchestration Nodes Package - Supervisors and Control Flow

Contains atomic nodes for workflow orchestration and coordination.
"""

from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData

# Import the Nexus workflow builder
from nexus_workflow import build_nexus_graph


class NexusPrimeNode(AtomicNode):
    """
    Atomic node wrapper for Nexus Prime (The CEO Agent).
    
    Nexus Prime orchestrates the full pipeline:
    Research -> Architect -> Builder -> Auditor
    
    With human-in-the-loop approval gates.
    """
    
    type_id = "nexus_prime"
    display_name = "Nexus Prime (Supervisor)"
    description = "The CEO Agent - Orchestrates the full development pipeline"
    category = "orchestration"
    icon = "🧠"
    version = 1.0
    levels = ["project", "task"]
    node_type = "orchestrator"
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Task ID",
                "name": "task_id",
                "type": "string",
                "default": "",
                "description": "The task being orchestrated",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute the Nexus Prime supervisor graph."""
        
        nexus_graph = build_nexus_graph()
        
        # Pass through the workflow state
        initial_state = {}
        if items:
            initial_state = items[0].json
        
        try:
            result = await nexus_graph.ainvoke(initial_state)
            return [[NodeExecutionData(json=result)]]
        except Exception as e:
            return [[NodeExecutionData(json={"error": str(e)}, error=e)]]


class HumanApprovalNode(AtomicNode):
    """
    Human-in-the-loop approval gate.
    
    Pauses execution for human review and approval.
    Uses LangGraph's interrupt functionality.
    """
    
    type_id = "human_in_loop"
    display_name = "Human Approval"
    description = "Pauses execution for human review"
    category = "orchestration"
    icon = "🙋"
    version = 1.0
    levels = ["dashboard", "project", "task"]
    node_type = "orchestrator"
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Approval Message",
                "name": "approval_message",
                "type": "string",
                "default": "Please review and approve to continue",
                "description": "Message shown to the human reviewer",
            },
            {
                "displayName": "Approval Type",
                "name": "approval_type",
                "type": "options",
                "default": "manual",
                "options": [
                    {"name": "Manual Approval", "value": "manual"},
                    {"name": "Auto-Approve After Delay", "value": "auto"},
                ],
                "description": "How approval is handled",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Signal that human approval is needed."""
        
        message = ctx.get_node_parameter("approval_message", "Please review")
        
        return [[NodeExecutionData(
            json={
                "awaiting_approval": True,
                "approval_message": message,
                "stage": "human_review",
                # Pass through any input data
                **(items[0].json if items else {}),
            }
        )]]


class ProjectIteratorNode(AtomicNode):
    """
    Iterates over target projects and runs child workflows.
    
    Dashboard-level node for multi-project operations.
    """
    
    type_id = "project_iterator"
    display_name = "Project Iterator"
    description = "Iterates over projects and runs child workflows for each"
    category = "dashboard"
    icon = "🔄"
    version = 1.0
    levels = ["dashboard"]
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Parallel Execution",
                "name": "parallel",
                "type": "boolean",
                "default": False,
                "description": "Run projects in parallel",
            },
            {
                "displayName": "Max Concurrent",
                "name": "max_concurrent",
                "type": "number",
                "default": 3,
                "description": "Maximum concurrent project executions",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Iterate over projects."""
        # TODO: Implement project iteration logic
        return [[NodeExecutionData(json={"status": "iterator_placeholder"})]]


class StageManagerNode(AtomicNode):
    """
    Manages workflow stages and advancement.
    
    Project-level node for stage tracking.
    """
    
    type_id = "stage_manager"
    display_name = "Stage Manager"
    description = "Manages workflow stages and advancement"
    category = "project"
    icon = "📈"
    version = 1.0
    levels = ["project"]
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Require All Complete",
                "name": "require_all_complete",
                "type": "boolean",
                "default": True,
                "description": "All tasks must complete before advancing",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Manage stage advancement."""
        # TODO: Implement stage management logic
        return [[NodeExecutionData(json={"status": "stage_manager_placeholder"})]]


class FleetNode(AtomicNode):
    """
    Fleet node - a coordinated group of AI agents.
    
    Represents Research, Architect, Builder, or Auditor fleets
    that work together on a specific phase of the pipeline.
    """
    
    type_id = "fleet"
    display_name = "Agent Fleet"
    description = "A coordinated group of AI agents working on a pipeline phase"
    category = "orchestration"
    icon = "👥"
    version = 1.0
    levels = ["project", "task"]
    node_type = "fleet"
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Fleet Type",
                "name": "fleet_type",
                "type": "options",
                "default": "research",
                "options": [
                    {"name": "Research Fleet", "value": "research"},
                    {"name": "Architect Fleet", "value": "architect"},
                    {"name": "Builder Fleet", "value": "builder"},
                    {"name": "Audit Fleet", "value": "audit"},
                ],
                "description": "The type of fleet to deploy",
            },
            {
                "displayName": "Model",
                "name": "model",
                "type": "modelSelector",
                "default": "",
                "description": "AI model to use for this fleet",
            },
            {
                "displayName": "Max Iterations",
                "name": "max_iterations",
                "type": "number",
                "default": 10,
                "description": "Maximum iterations before stopping",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute the fleet's coordinated agents."""
        fleet_type = ctx.get_node_parameter("fleet_type", "research")
        
        # Route to appropriate specialized node based on fleet type
        result = {
            "fleet_type": fleet_type,
            "status": "completed",
            **(items[0].json if items else {})
        }
        return [[NodeExecutionData(json=result)]]


class SupervisorNode(AtomicNode):
    """
    Generic Supervisor node for workflow orchestration.
    
    Routes decisions between worker nodes based on state evaluation.
    This is the visual builder's supervisor type - distinct from
    NexusPrimeNode which is the full Nexus workflow.
    """
    
    type_id = "supervisor"
    display_name = "Supervisor"
    description = "Routes between worker nodes based on state evaluation"
    category = "orchestration"
    icon = "🧠"
    version = 1.0
    levels = ["dashboard", "project", "task"]
    node_type = "orchestrator"
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Model",
                "name": "model",
                "type": "modelSelector",
                "default": "",
                "description": "AI model used for routing decisions",
            },
            {
                "displayName": "Routing Strategy",
                "name": "routing_strategy",
                "type": "options",
                "default": "sequential",
                "options": [
                    {"name": "Sequential", "value": "sequential"},
                    {"name": "Conditional", "value": "conditional"},
                    {"name": "Parallel", "value": "parallel"},
                ],
                "description": "How to route between worker nodes",
            },
            {
                "displayName": "Max Retries",
                "name": "max_retries",
                "type": "number",
                "default": 3,
                "description": "Maximum retry attempts before escalating",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute supervisor routing logic."""
        strategy = ctx.get_node_parameter("routing_strategy", "sequential")
        
        result = {
            "supervisor_decision": "continue",
            "routing_strategy": strategy,
            **(items[0].json if items else {})
        }
        return [[NodeExecutionData(json=result)]]
from .approval_gate import ApprovalGateNode


__all__ = [
    "NexusPrimeNode",
    "HumanApprovalNode", 
    "ProjectIteratorNode",
    "StageManagerNode",
    "FleetNode",
    "SupervisorNode",
    "ApprovalGateNode",
]

