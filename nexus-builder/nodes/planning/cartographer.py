"""
Cartographer Node - Codebase exploration agent.

Extracted from architect/agent.py::cartographer_node
Explores codebase structure and builds mental model for implementation.
"""

from ..core.fleet import FleetAgentNode
from architect.agent import cartographer_node
from architect.tools import read_file_signatures, search_codebase


class CartographerNode(FleetAgentNode):
    """
    Phase 1 of Architect Fleet: Discovery.
    
    Explores the codebase to understand:
    - Existing patterns and conventions
    - File structure and organization
    - Related code that might be affected
    
    Uses tools: search_codebase, read_file_signatures
    """
    
    type_id = "architect_cartographer"
    display_name = "Cartographer"
    description = "Explores codebase structure and builds mental model for implementation"
    category = "planning"
    icon = "🗺️"
    fleet_origin = "architect"
    levels = ["project", "task"]
    
    # Bind the legacy function (async)
    legacy_function = staticmethod(cartographer_node)
    
    # Tools for ReAct loop
    agent_tools = [read_file_signatures, search_codebase]
    
    def get_properties(self):
        """Define parameters exposed in UI."""
        return [
            {
                "displayName": "Project Root",
                "name": "project_root",
                "type": "string",
                "default": "",
                "description": "Absolute path to the project root directory",
                "required": True
            },
            {
                "displayName": "Task Description",
                "name": "task_description",
                "type": "string", 
                "default": "",
                "description": "What you're trying to implement"
            },
            {
                "displayName": "Research Dossier",
                "name": "user_request",
                "type": "string",
                "default": "",
                "description": "Research findings from previous phase"
            }
        ]
