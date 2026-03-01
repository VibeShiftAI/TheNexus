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
    Each fleet's sub-agents can be individually configured with
    different models via the workflow builder config panel.
    """
    
    type_id = "fleet"
    display_name = "Agent Fleet"
    description = "A coordinated group of AI agents working on a pipeline phase"
    category = "orchestration"
    icon = "👥"
    version = 1.0
    levels = ["project", "task"]
    node_type = "fleet"
    
    # Per-fleet sub-agent model config keys
    _FLEET_MODEL_KEYS = {
        "research": [
            ("scoper_model", "Scoper Model", "Model for the Scoper agent (plans research queries)"),
            ("researcher_model", "Researcher Model", "Model for the Researcher agent (executes searches)"),
            ("vetter_model", "Vetter Model", "Model for the Vetter agent (reviews research plan)"),
            ("synthesizer_model", "Synthesizer Model", "Model for the Synthesizer agent (writes dossier)"),
        ],
        "architect": [
            ("cartographer_model", "Cartographer Model", "Model for the Cartographer agent (explores codebase)"),
            ("drafter_model", "Drafter Model", "Model for the Drafter agent (writes blueprint spec)"),
            ("grounder_model", "Grounder Model", "Model for the Grounder agent (validates manifest)"),
        ],
        "builder": [
            ("scout_model", "Scout Model", "Model for the Scout agent (reads files, plans edits)"),
            ("coder_model", "Coder Model", "Model for the Coder agent (writes code)"),
            ("checker_model", "Checker Model", "Model for the Checker agent (syntax/logic review)"),
        ],
        "audit": [
            ("forensic_model", "Forensic Model", "Model for the Forensic agent (investigates changes)"),
            ("verdict_model", "Verdict Model", "Model for the Verdict agent (final approval)"),
        ],
    }
    
    def get_properties(self) -> List[Dict[str, Any]]:
        props = [
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
                "displayName": "Max Iterations",
                "name": "max_iterations",
                "type": "number",
                "default": 10,
                "description": "Maximum iterations before stopping",
            },
        ]
        
        # Add per-agent model selectors with displayOptions
        for fleet_type, model_keys in self._FLEET_MODEL_KEYS.items():
            for key, display_name, description in model_keys:
                props.append({
                    "displayName": display_name,
                    "name": key,
                    "type": "modelSelector",
                    "default": "",
                    "description": description,
                    "displayOptions": {
                        "show": {"fleet_type": [fleet_type]}
                    },
                })
        
        return props
    
    def _collect_model_overrides(self, ctx: NodeExecutionContext, fleet_type: str) -> Dict[str, str]:
        """Collect non-empty model overrides from node config."""
        overrides = {}
        model_keys = self._FLEET_MODEL_KEYS.get(fleet_type, [])
        for key, _, _ in model_keys:
            value = ctx.get_node_parameter(key, "")
            if value:
                overrides[key] = value
        return overrides
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute the fleet's coordinated agents."""
        from supervisor.agent import (
            call_research_fleet,
            call_architect_fleet,
            call_builder_fleet,
            call_audit_fleet,
        )
        
        fleet_type = ctx.get_node_parameter("fleet_type", "research")
        state = items[0].json if items else {}
        
        # Inject model overrides from config panel
        model_overrides = self._collect_model_overrides(ctx, fleet_type)
        if model_overrides:
            existing = state.get("model_overrides", {})
            state["model_overrides"] = {**existing, **model_overrides}
        
        dispatch = {
            "research": call_research_fleet,
            "architect": call_architect_fleet,
            "builder": call_builder_fleet,
            "audit": call_audit_fleet,
        }
        
        fleet_fn = dispatch.get(fleet_type)
        if not fleet_fn:
            return [[NodeExecutionData(
                json={"error": f"Unknown fleet type: {fleet_type}"},
            )]]
        
        try:
            print(f"[FleetNode] Dispatching to {fleet_type} fleet")
            result = await fleet_fn(state)
            merged = {**state, **result}
            return [[NodeExecutionData(json=merged)]]
        except Exception as e:
            print(f"[FleetNode] {fleet_type} fleet error: {e}")
            import traceback
            traceback.print_exc()
            return [[NodeExecutionData(
                json={**state, "error": str(e)},
                error=e
            )]]


class SupervisorNode(AtomicNode):
    """
    Supervisor node for Nexus Prime workflow orchestration.
    
    Routes decisions between worker fleet nodes based on state evaluation.
    Delegates to the actual supervisor_node() from supervisor.agent which
    uses an LLM to make routing decisions.
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
                "displayName": "Supervisor Model",
                "name": "supervisor_model",
                "type": "modelSelector",
                "default": "",
                "description": "AI model for the Supervisor (routing decisions)",
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
        """Execute supervisor routing logic via actual supervisor_node()."""
        from supervisor.agent import supervisor_node
        
        state = items[0].json if items else {}
        
        # Inject supervisor model override
        supervisor_model = ctx.get_node_parameter("supervisor_model", "")
        if supervisor_model:
            overrides = state.get("model_overrides", {})
            overrides["supervisor_model"] = supervisor_model
            state["model_overrides"] = overrides
        
        try:
            print(f"[SupervisorNode] Executing routing decision")
            result = await supervisor_node(state)
            merged = {**state, **result}
            return [[NodeExecutionData(json=merged)]]
        except Exception as e:
            print(f"[SupervisorNode] Error: {e}")
            import traceback
            traceback.print_exc()
            return [[NodeExecutionData(
                json={**state, "error": str(e)},
                error=e
            )]]
from .approval_gate import ApprovalGateNode
from .walkthrough_generator import WalkthroughGeneratorNode


__all__ = [
    "NexusPrimeNode",
    "HumanApprovalNode", 
    "ProjectIteratorNode",
    "StageManagerNode",
    "FleetNode",
    "SupervisorNode",
    "ApprovalGateNode",
    "WalkthroughGeneratorNode",
]
