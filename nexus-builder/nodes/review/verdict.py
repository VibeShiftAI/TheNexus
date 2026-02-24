"""
Verdict Node - Approval decision agent.

Extracted from auditor/agent.py::verdict_parser
Extracts structured approval/rejection decision from audit.
"""

from ..core.fleet import FleetAgentNode
from auditor.agent import verdict_parser


class VerdictNode(FleetAgentNode):
    """
    Phase 2 of Auditor Fleet: Decision.
    
    Parses the forensic analysis and produces a structured verdict:
    - APPROVE: Changes are safe to proceed
    - REJECT: Changes have issues that need fixing
    - NEEDS_REVIEW: Requires human attention
    """
    
    type_id = "auditor_verdict"
    display_name = "Verdict Parser"
    description = "Extracts structured approval/rejection decision"
    category = "review"
    icon = "⚖️"
    fleet_origin = "auditor"
    levels = ["project", "task"]
    
    # Bind the legacy function (async)
    legacy_function = staticmethod(verdict_parser)
    
    def get_properties(self):
        """Define parameters exposed in UI."""
        return [
            {
                "displayName": "Auto-Approve Threshold",
                "name": "auto_approve_threshold",
                "type": "number",
                "default": 0.9,
                "description": "Confidence threshold for auto-approval (0-1)"
            },
            {
                "displayName": "Require Human for High Risk",
                "name": "require_human_high_risk",
                "type": "boolean",
                "default": True,
                "description": "Always require human review for high-risk changes"
            }
        ]
