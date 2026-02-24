"""
Researcher Node - Atomic Node Implementation

This is the first atomic node migration from the legacy researcher/agent.py.
It demonstrates how to wrap existing LangGraph subgraphs as atomic nodes.

MIGRATION NOTE: The legacy researcher/agent.py handler in node_registry.py
should be commented out after this node is tested.

Reference: packages/@n8n/ai-workflow-builder.ee/src/subgraphs/discovery.subgraph.ts
"""

from typing import Any, Dict, List, Optional
from datetime import datetime
import hashlib
from ..core import (
    AtomicNode, 
    NodeExecutionContext, 
    NodeExecutionData,
    # Declarative schema imports (Phase 2)
    NodeProperty,
    PropertyType,
    string_property,
    number_property,
    boolean_property,
)
from nodes.artifacts import ArtifactCategory

# Import the existing researcher graph (keep legacy code working)
from researcher.agent import compile_researcher_graph, ResearchState


class ResearcherNode(AtomicNode):
    """
    Atomic node wrapper for the Researcher agent mesh.
    
    The Researcher performs:
    1. Scoping - Determines what needs to be researched
    2. Vetting - Validates the research plan
    3. Execution - Runs web searches and documentation scrapes
    4. Synthesis - Compiles findings into a dossier
    
    This is a "SuperNode" - it wraps a full LangGraph internally
    while presenting a simple atomic interface to the workflow engine.
    """
    
    type_id = "researcher"
    display_name = "Researcher"
    description = "Deep research agent using Gemini Mesh (Pro + Flash)"
    category = "research"
    icon = "🔬"
    version = 1.0
    levels = ["feature"]
    default_model = "gemini-3-pro-preview"
    
    # ═══════════════════════════════════════════════════════════════════════
    # DECLARATIVE SCHEMA (Phase 2) - Drives automatic UI generation
    # ═══════════════════════════════════════════════════════════════════════
    
    @classmethod
    def get_schema_properties(cls) -> List[NodeProperty]:
        """
        Define configurable parameters using Pydantic schema.
        These drive the config panel UI automatically.
        """
        return [
            string_property(
                name="request",
                display_name="Research Request",
                default="",
                description="What should be researched?",
                required=True,
                rows=3,
            ),
            number_property(
                name="maxIterations",
                display_name="Max Iterations",
                default=3,
                description="Maximum research cycles before synthesis",
                min_value=1,
                max_value=10,
            ),
            boolean_property(
                name="skipIfTrivial",
                display_name="Skip if Trivial",
                default=True,
                description="Skip research for well-known topics",
            ),
        ]
    
    def get_properties(self) -> List[Dict[str, Any]]:
        """
        Legacy method - now delegates to declarative schema.
        Returns JSON-serializable dicts for backward compatibility.
        """
        return [prop.to_frontend_schema() for prop in self.get_schema_properties()]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """
        Execute the Researcher subgraph.
        
        This wraps the existing LangGraph implementation while:
        1. Extracting parameters from the atomic node interface
        2. Injecting Nexus context (project awareness)
        3. Returning structured output data
        """
        # Get parameters from node config
        request = ctx.get_node_parameter("request", "")
        
        # If no request in config, try to get from input items
        if not request and items:
            request = items[0].json.get("request", "")
        
        if not request:
            return [[NodeExecutionData(
                json={"error": "No research request provided"},
                error=Exception("No research request provided")
            )]]
        
        # Get Nexus-specific context (our secret sauce!)
        project_context_meta = ctx.get_project_context()
        
        # Get global context for project path and full markdown content
        global_ctx = ctx.get_global_context()
        project_path = global_ctx.get_project_path() if global_ctx else None
        
        # Load full project context from supervisor/*.md files
        full_context = ""
        if project_path:
            try:
                from nodes.utility.context_loader import read_project_contexts
                full_context = read_project_contexts(project_path)
            except ImportError:
                print("⚠️ [ResearcherNode] context_loader not available")
            except Exception as e:
                print(f"⚠️ [ResearcherNode] Failed to load project context: {e}")
        
        # Compile the researcher graph (from legacy implementation)
        researcher_graph = compile_researcher_graph()
        
        # Build initial state for the LangGraph
        initial_state: ResearchState = {
            "messages": [],
            "user_request": request,
            "task_title": global_ctx.task_title or project_context_meta.get("task_id", "Research Task") if global_ctx else project_context_meta.get("task_id", "Research Task"),
            "project_context": full_context,  # Now populated from supervisor/*.md!
            "proposed_queries": [],
            "is_plan_approved": False,
            "critique": "",
            "execution_count": 0,
            "final_dossier": "",
            "blackboard_session_id": None,  # Will be set by scoper_node
        }
        
        # Execute the subgraph
        try:
            result = await researcher_graph.ainvoke(initial_state)
            
            # Extract the final dossier
            dossier = result.get("final_dossier", "")
            
            # NEW: Store in ArtifactStore for UI visibility
            try:
                store = ctx.get_artifact_store()
                store.store_simple(
                    key="research_dossier",
                    content=dossier,
                    name="Research Dossier",
                    category=ArtifactCategory.RESEARCH,
                    producer_node_id=ctx.node.id,
                    producer_node_type=self.type_id,
                )
            except Exception as e:
                print(f"⚠️ [ResearcherNode] Artifact storage failed: {e}")
            
            return [[NodeExecutionData(
                json={
                    "dossier": dossier,
                    "request": request,
                    "queries_executed": result.get("proposed_queries", []),
                    "blackboard_session_id": result.get("blackboard_session_id"),
                }
            )]]
            
        except Exception as e:
            return [[NodeExecutionData(
                json={"error": str(e)},
                error=e
            )]]

