"""
Scout Node - File targeting agent.

Extracted from builder/agent.py::scout_node
Reads project skeleton and decides which files to target for implementation.
"""

from ..core.fleet import FleetAgentNode
from builder.agent import scout_node


class ScoutNode(FleetAgentNode):
    """
    Phase 1 of Builder Fleet: Reconnaissance.
    
    Analyzes the project structure and implementation plan to:
    - Identify files that need to be created
    - Identify files that need to be modified
    - Read relevant existing code for context
    """
    
    type_id = "builder_scout"
    display_name = "Scout"
    description = "Reads project skeleton and decides which files to target"
    category = "implementation"
    icon = "🔍"
    fleet_origin = "builder"
    levels = ["project", "task"]
    
    # Bind the legacy function (async)
    legacy_function = staticmethod(scout_node)
    
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
                "displayName": "File Manifest",
                "name": "manifest",
                "type": "json",
                "default": [],
                "description": "List of files to create/modify from Architect"
            }
        ]
