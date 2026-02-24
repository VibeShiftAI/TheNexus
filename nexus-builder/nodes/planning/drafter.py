"""
Drafter Node - Implementation specification agent.

Extracted from architect/agent.py::drafter_node
Creates implementation spec and file manifest with rationales.
"""

from ..core.fleet import FleetAgentNode
from architect.agent import drafter_node


class DrafterNode(FleetAgentNode):
    """
    Phase 2 of Architect Fleet: Specification.
    
    Creates a detailed implementation plan including:
    - File manifest (files to create/modify)
    - Implementation steps with rationales
    - Dependency analysis
    """
    
    type_id = "architect_drafter"
    display_name = "Drafter"
    description = "Creates implementation spec and file manifest with rationales"
    category = "planning"
    icon = "📝"
    fleet_origin = "architect"
    levels = ["project", "task"]
    
    # Bind the legacy function (async)
    legacy_function = staticmethod(drafter_node)
    
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
                "displayName": "Output Format",
                "name": "output_format",
                "type": "options",
                "default": "structured",
                "options": [
                    {"name": "Structured JSON", "value": "structured"},
                    {"name": "Markdown", "value": "markdown"}
                ],
                "description": "Format for the implementation spec"
            }
        ]
