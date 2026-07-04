"""
Approval Gate Node - Human-in-the-loop approval agent.

Extracted from supervisor/agent.py approval patterns.
Pauses workflow for human review before continuing.
"""

from ..core.fleet import FleetAgentNode


class ApprovalGateNode(FleetAgentNode):
    """
    Orchestration Node: Human Approval Gate.
    
    Pauses the workflow execution and waits for human approval.
    Used for critical checkpoints like:
    - Research approval (before planning)
    - Plan approval (before implementation)
    - Custom approval points
    """
    
    type_id = "approval_gate"
    display_name = "Human Approval Gate"
    description = "Pauses workflow for human review before continuing"
    category = "orchestration"
    icon = "🚦"
    fleet_origin = "supervisor"
    levels = ["project", "task"]
    
    # No legacy function - this is a control flow node
    legacy_function = None
    
    def get_properties(self):
        """Define parameters exposed in UI."""
        return [
            {
                "displayName": "Gate Type",
                "name": "gate_type",
                "type": "options",
                "default": "custom",
                "options": [
                    {"name": "Research Approval", "value": "research"},
                    {"name": "Plan Approval", "value": "plan"},
                    {"name": "Implementation Approval", "value": "implementation"},
                    {"name": "Custom", "value": "custom"}
                ],
                "description": "Type of approval gate"
            },
            {
                "displayName": "Gate Message",
                "name": "gate_message",
                "type": "string",
                "default": "Waiting for human approval to proceed",
                "description": "Message shown to user when paused"
            },
            {
                "displayName": "Artifact Preview",
                "name": "artifact_preview",
                "type": "string",
                "default": "",
                "description": "Key to extract from state for preview"
            }
        ]
    
    async def execute(self, ctx, items):
        """
        Sets the pending_approval state to trigger human-in-the-loop.
        
        The GraphEngine's interrupt_before mechanism will pause execution
        when it sees this node in the interrupt_nodes list.
        """
        from ..core import NodeExecutionData
        
        input_payload = items[0].json if items else {}
        
        gate_type = ctx.get_node_parameter("gate_type", "custom")
        gate_message = ctx.get_node_parameter("gate_message", "Awaiting approval")
        artifact_preview_key = ctx.get_node_parameter("artifact_preview", "")
        
        # Extract preview content
        artifact_preview = ""
        if artifact_preview_key and artifact_preview_key in input_payload:
            content = input_payload[artifact_preview_key]
            if isinstance(content, str):
                artifact_preview = content[:500]  # Truncate for preview
            else:
                import json
                artifact_preview = json.dumps(content, indent=2)[:500]
        
        return [[NodeExecutionData(json={
            "pending_approval": {
                "gate": gate_type,
                "message": gate_message,
                "artifact_preview": artifact_preview,
                "next_phase": f"Continue after {gate_type} approval"
            },
            # Pass through existing data
            **input_payload
        })]]
