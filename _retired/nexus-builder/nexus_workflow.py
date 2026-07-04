"""
Nexus Workflow - The Master Orchestration Graph

This is the "Chassis" that wires all encapsulated fleets into the Star Topology
(Hub-and-Spoke) design. Nexus Prime (the Supervisor) acts as the central hub,
dynamically routing to specialized fleets based on artifact state.

Architecture:
    START -> nexus_prime <-> [research_fleet, architect_fleet, builder_fleet, audit_fleet]
                 |
                 v
            human_in_loop (interrupt) -> nexus_prime
                 |
                 v
                END (finish)
"""

from typing import Literal
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver  # Use PostgresSaver for production

# 1. Import The Data Backbone
from workflow_state import WorkflowState

# 2. Import The "Encapsulated Fleets" (The Nodes)
# These are the wrappers created in supervisor/agent.py
from supervisor.agent import (
    supervisor_node as call_nexus_prime,  # The Supervisor (renamed for clarity)
    call_research_fleet,   # Gemini Mesh
    call_architect_fleet,  # Gemini Mesh
    call_builder_fleet,    # Implementation + Retry
    call_audit_fleet,      # Claude/Gemini Adversarial Mesh
    call_walkthrough_generator,  # LLM-powered walkthrough synthesis
    await_research_approval,  # Human approval gate after research
    await_plan_approval       # Human approval gate after planning
)


# ═══════════════════════════════════════════════════════════════
# 3. THE SWITCHBOARD (Routing Logic)
# ═══════════════════════════════════════════════════════════════

def route_nexus_prime(state: WorkflowState) -> Literal[
    "research_fleet", 
    "architect_fleet", 
    "builder_fleet", 
    "audit_fleet", 
    "walkthrough_generator",
    "human_in_loop", 
    "finish"
]:
    """
    Decodes the Supervisor's decision into a graph edge.
    This uses the 'evaluator_decision' field populated by call_nexus_prime.
    """
    decision = state.get("evaluator_decision")
    
    # Map 'finish' directly to the End Node
    if decision == "finish":
        return "finish"
        
    # Map 'human_help' signal to the registered node name 'human_in_loop'
    if decision == "human_help":
        return "human_in_loop"
    
    # Default: Route to the requested fleet
    # Safety: Ensure the decision matches a known node
    valid_routes = ["research_fleet", "architect_fleet", "builder_fleet", "audit_fleet", "walkthrough_generator"]
    if decision in valid_routes:
        return decision
        
    # Fallback for unexpected outputs -> Pause for Human
    print(f"[Nexus] WARNING: Unexpected decision '{decision}', routing to human_in_loop")
    return "human_in_loop"


# ═══════════════════════════════════════════════════════════════
# 4. HUMAN INTERRUPT NODE
# ═══════════════════════════════════════════════════════════════

def human_node(state: WorkflowState):
    """
    A passive node that effectively pauses execution.
    The graph interrupt will trigger BEFORE this node runs.
    
    In the UI, this allows the user to:
    - Inject a new "user_request" 
    - Override state values
    - Provide guidance to the AI
    """
    return {
        "nexus_protocol_extensions": {
            "status_update": "PAUSED: Awaiting Human Input", 
            "status_color": "red"
        }
    }


# ═══════════════════════════════════════════════════════════════
# 5. ASSEMBLE THE GRAPH (Star Topology)
# ═══════════════════════════════════════════════════════════════

def build_nexus_graph(checkpointer=None):
    """
    Build and compile the Nexus orchestration graph.
    
    Args:
        checkpointer: LangGraph checkpointer for state persistence.
                     Use MemorySaver() for dev, PostgresSaver for production.
    
    Returns:
        Compiled StateGraph ready for execution
    """
    builder = StateGraph(WorkflowState)
    
    # A. Register the Nodes (The Fleets + Approval Gates)
    builder.add_node("nexus_prime", call_nexus_prime)
    builder.add_node("research_fleet", call_research_fleet)
    builder.add_node("await_research_approval", await_research_approval)
    builder.add_node("architect_fleet", call_architect_fleet)
    builder.add_node("await_plan_approval", await_plan_approval)
    builder.add_node("builder_fleet", call_builder_fleet)
    builder.add_node("audit_fleet", call_audit_fleet)
    builder.add_node("walkthrough_generator", call_walkthrough_generator)
    builder.add_node("human_in_loop", human_node)
    
    # B. Create the Edges (Star Topology with Approval Gates)
    
    # 1. Start -> Hub
    builder.add_edge(START, "nexus_prime")
    
    # 2. Research -> Approval Gate -> Hub (human reviews research before planning)
    builder.add_edge("research_fleet", "await_research_approval")
    builder.add_edge("await_research_approval", "nexus_prime")
    
    # 3. Architect -> Approval Gate -> Hub (human reviews plan before coding)
    builder.add_edge("architect_fleet", "await_plan_approval")
    builder.add_edge("await_plan_approval", "nexus_prime")
    
    # 4. Builder and Audit go directly back to hub
    builder.add_edge("builder_fleet", "nexus_prime")
    builder.add_edge("audit_fleet", "nexus_prime")
    
    # 5. Walkthrough Generator -> END (final step before completion)
    builder.add_edge("walkthrough_generator", END)
    
    # 6. Human -> Hub (Resume Loop for manual intervention)
    builder.add_edge("human_in_loop", "nexus_prime")
    
    # C. The Conditional Router (Hub -> Spokes)
    builder.add_conditional_edges(
        "nexus_prime",
        route_nexus_prime,
        {
            "research_fleet": "research_fleet",
            "architect_fleet": "architect_fleet",
            "builder_fleet": "builder_fleet",
            "audit_fleet": "audit_fleet",
            "walkthrough_generator": "walkthrough_generator",
            "human_in_loop": "human_in_loop",
            "finish": END
        }
    )
    
    # D. Compile with Persistence
    # CRITICAL: Interrupts pause execution and wait for human input.
    # - interrupt_before: Pauses BEFORE the node runs (for manual intervention)
    # - interrupt_after: Pauses AFTER the node runs (for approval gates)
    if checkpointer is None:
        checkpointer = MemorySaver()
    
    return builder.compile(
        checkpointer=checkpointer,
        interrupt_before=["human_in_loop"],
        interrupt_after=["await_research_approval", "await_plan_approval"]
    )


# ═══════════════════════════════════════════════════════════════
# 6. DEFAULT GRAPH INSTANCE
# ═══════════════════════════════════════════════════════════════

# Pre-compiled graph for direct import
# For production with PostgresSaver, use build_nexus_graph(your_checkpointer)
nexus_graph = build_nexus_graph()


# ═══════════════════════════════════════════════════════════════
# 7. CONVENIENCE FUNCTIONS
# ═══════════════════════════════════════════════════════════════

def create_initial_state(
    task_title: str,
    task_description: str,
    project_id: str = None,
    project_path: str = None,
    task_id: str = None
) -> WorkflowState:
    """
    Create the initial state for a new workflow run.
    
    Args:
        task_title: Title of the task being implemented
        task_description: Detailed description of the task
        project_id: ID of the target project
        project_path: Filesystem path to the project
        task_id: ID of the task in the task manager
        
    Returns:
        Initialized WorkflowState ready for graph execution
    """
    return {
        "messages": [],
        "current_step": "start",
        "context": {
            "task_title": task_title,
            "task_description": task_description,
            "project_id": project_id,
            "project_path": project_path,
            "task_id": task_id
        },
        "outputs": {},
        "evaluator_decision": None,
        "scratchpad": None,
        "artifacts": None,
        "retry_count": 0,
        "custom_fields": None,
        "output_schema": None,
        "negative_constraints": None,
        "nexus_protocol_extensions": None
    }


async def run_nexus_workflow(
    task_title: str,
    task_description: str,
    project_id: str = None,
    project_path: str = None,
    task_id: str = None,
    thread_id: str = None
):
    """
    Run the complete Nexus workflow for a task.
    
    Args:
        task_title: Title of the task
        task_description: Detailed description
        project_id: Target project ID
        project_path: Filesystem path to project
        task_id: Task ID in task manager
        thread_id: Optional thread ID for resuming
        
    Returns:
        Final state after workflow completion or interrupt
    """
    initial_state = create_initial_state(
        task_title=task_title,
        task_description=task_description,
        project_id=project_id,
        project_path=project_path,
        task_id=task_id
    )
    
    config = {"configurable": {"thread_id": thread_id or task_id or "default"}}
    
    return await nexus_graph.ainvoke(initial_state, config)
