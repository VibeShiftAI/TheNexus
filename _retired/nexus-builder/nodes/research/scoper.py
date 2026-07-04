"""
Scoper Node - Research query planning agent.

Extracted from researcher/agent.py::scoper_node
Analyzes task context and creates targeted research queries.
"""

from ..core.fleet import FleetAgentNode
from researcher.agent import scoper_node


class ScoperNode(FleetAgentNode):
    """
    Phase 1 of Research Fleet: Query Planning.
    
    Analyzes the task description and project context to create
    a focused list of research queries.
    """
    
    type_id = "research_scoper"
    display_name = "Research Scoper"
    description = "Analyzes task and project context to create targeted research queries"
    category = "research"
    icon = "🔬"
    fleet_origin = "research"
    levels = ["project", "task"]
    
    # Bind the legacy function
    legacy_function = staticmethod(scoper_node)
    
    def get_properties(self):
        """Define parameters exposed in UI."""
        return [
            {
                "displayName": "Task Title",
                "name": "task_title",
                "type": "string",
                "default": "",
                "description": "Title of the task to research"
            },
            {
                "displayName": "User Request",
                "name": "user_request",
                "type": "string",
                "default": "",
                "description": "Specific query or request to research"
            },
            {
                "displayName": "Project Root",
                "name": "project_root",
                "type": "string",
                "default": "",
                "description": "Path to the project root directory"
            }
        ]
