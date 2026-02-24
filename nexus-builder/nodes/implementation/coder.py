"""
Coder Node - File creation/editing agent.

Extracted from builder/agent.py::builder_node
Creates new files or edits existing ones based on implementation spec.
"""

from ..core.fleet import FleetAgentNode
from builder.agent import builder_node


class CoderNode(FleetAgentNode):
    """
    Phase 2 of Builder Fleet: Implementation.
    
    Takes the implementation plan and file context to:
    - Create new files with proper structure
    - Modify existing files with surgical precision
    - Follow project conventions and patterns
    """
    
    type_id = "builder_coder"
    display_name = "Coder"
    description = "Creates new files or edits existing ones based on spec"
    category = "implementation"
    icon = "💻"
    fleet_origin = "builder"
    levels = ["project", "task"]
    
    # Bind the legacy function (async)
    legacy_function = staticmethod(builder_node)
    
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
                "displayName": "Implementation Spec",
                "name": "spec",
                "type": "string",
                "default": "",
                "description": "The implementation specification from Architect"
            },
            {
                "displayName": "Target Files",
                "name": "target_files",
                "type": "json",
                "default": [],
                "description": "List of files to create or modify"
            }
        ]
