"""
Checker Node - Syntax check and review agent.

Extracted from builder/agent.py::basic_check_node
Runs syntax checks and cross-provider LLM review on changes.
"""

from ..core.fleet import FleetAgentNode
from builder.agent import basic_check_node


class CheckerNode(FleetAgentNode):
    """
    Phase 3 of Builder Fleet: Verification.
    
    Performs quality checks on the created/modified code:
    - Syntax validation (AST parsing for Python, etc.)
    - Linting checks
    - Cross-provider LLM review for catching errors
    """
    
    type_id = "builder_checker"
    display_name = "Syntax Checker"
    description = "Runs syntax checks and cross-provider LLM review"
    category = "implementation"
    icon = "🔧"
    fleet_origin = "builder"
    levels = ["project", "task"]
    
    # Bind the legacy function (async)
    legacy_function = staticmethod(basic_check_node)
    
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
                "displayName": "Files Changed",
                "name": "files_changed",
                "type": "json",
                "default": [],
                "description": "List of files that were created/modified"
            },
            {
                "displayName": "Cross-Provider Review",
                "name": "cross_review",
                "type": "boolean",
                "default": True,
                "description": "Use different LLM provider for review"
            }
        ]
