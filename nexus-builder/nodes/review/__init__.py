"""
Review Nodes Package - Auditor and Verification

Contains atomic nodes for code review and audit operations.
"""

from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData

# Import the existing auditor graph
from auditor.agent import compile_auditor_graph


class AuditorNode(AtomicNode):
    """
    Atomic node wrapper for the Auditor agent mesh.
    
    The Auditor performs:
    1. Forensic Investigation - Reviews diffs and linter reports
    2. Verification - Writes dry-run tests if needed
    3. Verdict - Issues structured approval/rejection
    
    Uses Claude Opus for deep reasoning.
    """
    
    type_id = "auditor"
    display_name = "The Auditor"
    description = "Zero-Trust verification agent (Forensics -> Verdict)"
    category = "review"
    icon = "🛡️"
    version = 1.0
    levels = ["feature"]
    default_model = "claude-opus-4-5-20251101"
    
    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Implementation Spec",
                "name": "spec",
                "type": "string",
                "default": "",
                "description": "The original implementation spec to audit against",
                "typeOptions": {"rows": 3},
            },
        ]
    
    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute the Auditor subgraph."""
        
        # Get parameters
        spec = ctx.get_node_parameter("spec", "")
        
        # Get artifacts from input
        modified_files = []
        walkthrough = ""
        dod = {}
        if items:
            modified_files = items[0].json.get("modified_files", [])
            walkthrough = items[0].json.get("walkthrough", "")
            dod = items[0].json.get("definition_of_done", {})
            if not spec:
                spec = items[0].json.get("plan", "") or items[0].json.get("spec", "")
        
        # Get Nexus context
        project_context = ctx.get_project_context()
        
        # Compile the auditor graph
        auditor_graph = compile_auditor_graph()
        
        # Build initial state
        initial_state = {
            "messages": [],
            "task_title": project_context.get("task_id", "Audit Task"),
            "task_description": spec[:500] if spec else "Verify implementation",
            "project_context": "",  # TODO: Load from context service
            "definition_of_done": dod,
            "modified_files": modified_files,
            "diff_context": walkthrough,  # Use walkthrough as diff context
            "blast_radius": "No blast radius analysis",
            "linter_report": "No linter issues",
            "implementation_spec": spec,
            "test_logs": [],
            "final_verdict": {},
        }
        
        try:
            result = await auditor_graph.ainvoke(initial_state)
            
            verdict = result.get("final_verdict", {})
            
            return [[NodeExecutionData(
                json={
                    "verdict": verdict,
                    "status": verdict.get("status", "UNKNOWN"),
                    "security_score": verdict.get("security_score", 0),
                    "reasoning": verdict.get("reasoning", ""),
                    "auditor_summary": f"Verdict: {verdict.get('status', 'UNKNOWN')}",
                }
            )]]
            
        except Exception as e:
            return [[NodeExecutionData(
                json={"error": str(e)},
                error=e
            )]]
from .forensic import ForensicNode
from .verdict import VerdictNode


__all__ = [
    "AuditorNode",
    "ForensicNode",
    "VerdictNode",
]
