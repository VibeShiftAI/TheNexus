"""
Grounder Node - Manifest validation agent.

Extracted from architect/agent.py::grounding_node
Validates file manifest against actual repo structure.
"""

from ..core.fleet import FleetAgentNode
from architect.agent import grounding_node


class GrounderNode(FleetAgentNode):
    """
    Phase 3 of Architect Fleet: Grounding.
    
    Validates the proposed file manifest against reality:
    - Checks if files to modify actually exist
    - Verifies parent directories exist
    - Detects potential conflicts
    
    Returns a GroundingReport with validation results.
    """
    
    type_id = "architect_grounder"
    display_name = "Grounder"
    description = "Validates file manifest against actual repo structure"
    category = "planning"
    icon = "⚓"
    fleet_origin = "architect"
    levels = ["project", "task"]
    
    # Bind the legacy function (async)
    legacy_function = staticmethod(grounding_node)
    
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
                "default": {},
                "description": "The proposed file manifest to validate"
            },
            {
                "displayName": "Strict Mode",
                "name": "strict",
                "type": "boolean",
                "default": True,
                "description": "Fail if any validation errors found"
            }
        ]
