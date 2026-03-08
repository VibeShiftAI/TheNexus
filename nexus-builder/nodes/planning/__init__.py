"""
Planning Nodes Package - Architect and Strategic Planning

Contains atomic nodes for planning and architecture operations.
"""

from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData

# Import the existing architect graph (keep legacy code working)
from architect.agent import compile_architect_graph
from architect.tools import ArchitectTools


class ArchitectNode(AtomicNode):
    """
    Atomic node wrapper for the Architect agent mesh.
    
    The Architect performs:
    1. Cartography - Explores the codebase with tools
    2. Drafting - Creates ProjectBlueprint with spec and manifest
    3. Grounding - Validates plans against actual file structure
    
    This is a "SuperNode" - it wraps a full LangGraph internally.
    """
    
    type_id = "architect"
    display_name = "The Architect"
    description = "Gemini Mesh Planner (Pro + Flash) - Creates implementation blueprints"
    category = "planning"
    icon = "🗺️"
    version = 1.0
    levels = ["feature"]
    default_model = "gemini-3-pro-preview"
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Project Root",
                "name": "project_root",
                "type": "string",
                "default": ".",
                "description": "Root directory of the project",
                "required": True,
            },
            {
                "displayName": "Max Iterations",
                "name": "maxIterations",
                "type": "number",
                "default": 3,
                "description": "Maximum planning iterations before escalation",
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute the Architect subgraph."""
        
        # Get parameters
        project_root = ctx.get_node_parameter("project_root", ".")
        
        # Get input from previous nodes (e.g., research dossier)
        user_request = ""
        if items:
            user_request = items[0].json.get("dossier", "") or items[0].json.get("request", "")
        
        if not user_request:
            user_request = "Plan implementation"
        
        # Get Nexus context
        project_context = ctx.get_project_context()
        
        # Pre-load repo structure
        try:
            repo_structure = ArchitectTools.get_repo_structure(project_root)
        except Exception:
            repo_structure = "Could not load repo structure"
        
        # Compile the architect graph
        architect_graph = compile_architect_graph()
        
        # Build initial state
        initial_state = {
            "messages": [],
            "user_request": user_request,
            "repo_structure": repo_structure,
            "project_root": project_root,
            "task_title": project_context.get("task_id", "Architecture Task"),
            "task_description": user_request[:500],
            "project_context": "",  # TODO: Load from context service
            "thought_signature": "",
            "draft_spec": None,
            "draft_manifest": None,
            "final_spec": None,
            "final_manifest": None,
            "definition_of_done": None,
            "grounding_errors": [],
            "loop_count": 0,
            "dialogue_history": [],
        }
        
        try:
            result = await architect_graph.ainvoke(initial_state, config={"recursion_limit": 100})
            
            spec = result.get("final_spec", "")
            manifest = result.get("final_manifest", [])
            dod = result.get("definition_of_done", {})
            
            return [[NodeExecutionData(
                json={
                    "plan": spec,
                    "manifest": manifest,
                    "definition_of_done": dod,
                    "architect_summary": f"Created plan with {len(manifest)} files",
                }
            )]]
            
        except Exception as e:
            return [[NodeExecutionData(
                json={"error": str(e)},
                error=e
            )]]
from .cartographer import CartographerNode
from .drafter import DrafterNode
from .grounder import GrounderNode


__all__ = [
    "ArchitectNode",
    "CartographerNode",
    "DrafterNode",
    "GrounderNode",
]
