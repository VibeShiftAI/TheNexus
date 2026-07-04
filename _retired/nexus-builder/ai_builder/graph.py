"""
AI Workflow Builder Graph - Phase 8

The main LangGraph for the AI Workflow Builder.
Reference: packages/@n8n/ai-workflow-builder.ee/src/multi-agent-workflow-subgraphs.ts

Architecture:
    ┌──────────────┐
    │  SUPERVISOR  │ ← Entry point
    └──────┬───────┘
           │ routes to:
    ┌──────┼──────┬──────────────┐
    ▼      ▼      ▼              ▼
 DISCOVERY BUILDER CONFIGURATOR RESPONDER → END

The supervisor examines the request and routes to the appropriate agent.
After each agent completes, control returns to supervisor for next routing.
"""

from typing import Literal
from langgraph.graph import StateGraph, END

from .state import BuilderState, create_initial_builder_state
from .supervisor import supervisor_node
from .subgraphs import (
    discovery_subgraph,
    builder_subgraph,
    configurator_subgraph,
    responder_agent,
)


# ═══════════════════════════════════════════════════════════════════════════
# ROUTING FUNCTION
# ═══════════════════════════════════════════════════════════════════════════

def route_after_supervisor(state: BuilderState) -> Literal["discovery", "builder", "configurator", "responder", "end"]:
    """
    Route to the next agent based on supervisor's decision.
    """
    next_agent = state.get("next_agent", "responder")
    
    # Check for completion
    if state.get("is_complete", False) or next_agent == "end":
        return "end"
    
    # Route to the chosen agent
    if next_agent in ["discovery", "builder", "configurator", "responder"]:
        return next_agent
    
    # Default fallback
    return "responder"


def route_after_subgraph(state: BuilderState) -> Literal["supervisor", "end"]:
    """
    After a subgraph completes, route back to supervisor or end.
    """
    if state.get("is_complete", False) or state.get("next_agent") == "end":
        return "end"
    return "supervisor"


# ═══════════════════════════════════════════════════════════════════════════
# BUILD THE GRAPH
# ═══════════════════════════════════════════════════════════════════════════

def build_workflow_builder_graph(checkpointer=None):
    """
    Build and compile the AI Workflow Builder graph.
    
    Args:
        checkpointer: Optional LangGraph checkpointer for persistence
    
    Returns:
        Compiled StateGraph
    """
    # Create the graph
    graph = StateGraph(BuilderState)
    
    # Add nodes
    graph.add_node("supervisor", supervisor_node)
    graph.add_node("discovery", discovery_subgraph)
    graph.add_node("builder", builder_subgraph)
    graph.add_node("configurator", configurator_subgraph)
    graph.add_node("responder", responder_agent)
    
    # Set entry point
    graph.set_entry_point("supervisor")
    
    # Conditional routing from supervisor
    graph.add_conditional_edges(
        "supervisor",
        route_after_supervisor,
        {
            "discovery": "discovery",
            "builder": "builder",
            "configurator": "configurator",
            "responder": "responder",
            "end": END,
        }
    )
    
    # After each subgraph, route back to supervisor or end
    for subgraph_name in ["discovery", "builder", "configurator"]:
        graph.add_conditional_edges(
            subgraph_name,
            route_after_subgraph,
            {
                "supervisor": "supervisor",
                "end": END,
            }
        )
    
    # Responder always leads to END
    graph.add_edge("responder", END)
    
    # Compile
    if checkpointer:
        return graph.compile(checkpointer=checkpointer)
    return graph.compile()


# ═══════════════════════════════════════════════════════════════════════════
# CONVENIENCE RUNNER
# ═══════════════════════════════════════════════════════════════════════════

async def run_workflow_builder(
    user_request: str,
    session_id: str = None,
    project_id: str = None,
    existing_workflow: dict = None
) -> BuilderState:
    """
    Run the workflow builder for a user request.
    
    Args:
        user_request: Natural language request from user
        session_id: Optional session ID (generated if not provided)
        project_id: Optional project context
        existing_workflow: Optional existing workflow to modify
    
    Returns:
        Final BuilderState with the result
    """
    import uuid
    
    if not session_id:
        session_id = str(uuid.uuid4())
    
    # Create initial state
    initial_state = create_initial_builder_state(
        user_request=user_request,
        session_id=session_id,
        project_id=project_id,
        existing_workflow=existing_workflow,
    )
    
    # Build and run the graph
    graph = build_workflow_builder_graph()
    
    final_state = await graph.ainvoke(initial_state)
    
    return final_state


def run_workflow_builder_sync(
    user_request: str,
    session_id: str = None,
    project_id: str = None,
    existing_workflow: dict = None
) -> BuilderState:
    """Synchronous version of run_workflow_builder."""
    import asyncio
    return asyncio.run(run_workflow_builder(
        user_request, session_id, project_id, existing_workflow
    ))
