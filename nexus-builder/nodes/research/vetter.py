"""
Vetter Node - Research query validation agent.

Extracted from researcher/agent.py::vetting_node
Reviews and approves research queries before execution.
"""

from ..core.fleet import FleetAgentNode
from researcher.agent import vetting_node


class VetterNode(FleetAgentNode):
    """
    Phase 2 of Research Fleet: Query Validation.
    
    Reviews the proposed research queries to ensure they are:
    - Relevant to the task
    - Specific enough to get useful results
    - Safe (no sensitive data leakage)
    """
    
    type_id = "research_vetter"
    display_name = "Query Vetter"
    description = "Reviews and approves research queries before execution"
    category = "research"
    icon = "✅"
    fleet_origin = "research"
    levels = ["project", "task"]
    
    # Bind the legacy function
    legacy_function = staticmethod(vetting_node)
    
    def get_properties(self):
        """Define parameters exposed in UI."""
        return [
            {
                "displayName": "Proposed Queries",
                "name": "proposed_queries",
                "type": "json",
                "default": [],
                "description": "List of queries to review"
            }
        ]
