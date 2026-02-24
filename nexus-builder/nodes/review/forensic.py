"""
Forensic Node - Diff analysis and review agent.

Extracted from auditor/agent.py::forensic_node
Reviews diffs, blast radius, and linter reports.
"""

from ..core.fleet import FleetAgentNode
from auditor.agent import forensic_node


class ForensicNode(FleetAgentNode):
    """
    Phase 1 of Auditor Fleet: Investigation.
    
    Performs deep analysis of code changes:
    - Diff analysis (what changed and why)
    - Blast radius estimation (what could be affected)
    - Linter report review
    - Security scan check
    """
    
    type_id = "auditor_forensic"
    display_name = "Forensic Investigator"
    description = "Reviews diffs, blast radius, and linter reports"
    category = "review"
    icon = "🔬"
    fleet_origin = "auditor"
    levels = ["project", "task"]
    
    # Bind the legacy function (async)
    legacy_function = staticmethod(forensic_node)
    
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
                "displayName": "Modified Files",
                "name": "modified_files",
                "type": "json",
                "default": [],
                "description": "List of files that were modified"
            },
            {
                "displayName": "Include Linter",
                "name": "include_linter",
                "type": "boolean",
                "default": True,
                "description": "Run linter checks on modified files"
            }
        ]
