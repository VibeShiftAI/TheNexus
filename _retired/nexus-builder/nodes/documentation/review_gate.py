"""
Doc Review Gate Node - Interrupt gate for human doc review.

Sets pending_approval with the doc_changes artifact for diff-based
review in the ArtifactPanel. Follows the same pattern as ApprovalGateNode.
"""

import json
import uuid
from typing import Any, Dict, List

from ..core.base import AtomicNode, NodeExecutionContext, NodeExecutionData


class DocReviewGateNode(AtomicNode):
    """Pause for human review of documentation changes."""

    type_id = "doc_review_gate"
    display_name = "Doc Review Gate"
    description = "Pauses the workflow for human review of documentation changes with per-hunk approve/reject/revise controls"
    category = "documentation"
    icon = "📋"
    version = 1.0
    levels = ["project", "task"]
    node_type = "atomic"

    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Gate Message",
                "name": "gate_message",
                "type": "string",
                "default": "Please review the documentation changes",
                "description": "Message shown to user when paused for review",
            },
        ]

    async def execute(
        self, ctx: NodeExecutionContext, items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        input_payload = items[0].json if items else {}
        outputs = input_payload.get("outputs", {})
        doc_changes = outputs.get("doc_changes", {})
        gate_message = ctx.get_node_parameter("gate_message", "Please review the documentation changes")

        total_hunks = sum(len(f.get("hunks", [])) for f in doc_changes.get("files", []))
        total_files = len(doc_changes.get("files", []))
        
        # Guard: if no changes were produced (e.g. drafter JSON parse failed), route back to drafter
        if total_files == 0 or total_hunks == 0:
            print(f"[DocReviewGate] No changes to review (files={total_files}, hunks={total_hunks}). Routing back to drafter.")
            return [[NodeExecutionData(json={
                **input_payload,
                "evaluator_decision": "revise",
                "messages": input_payload.get("messages", []) + [
                    {"role": "system", "content": "[Review Gate] No documentation changes produced. Re-drafting."}
                ],
            })]]
        
        # Guard: if drafter flagged partial recovery, route back for continuation
        if outputs.get("partial_recovery"):
            completed_count = len(outputs.get("completed_files", []))
            print(f"[DocReviewGate] Partial recovery detected ({completed_count} files so far). Routing back to drafter for continuation.")
            return [[NodeExecutionData(json={
                **input_payload,
                "evaluator_decision": "revise",
                "messages": input_payload.get("messages", []) + [
                    {"role": "system", "content": f"[Review Gate] Partial recovery: {completed_count} files drafted. Continuing..."}
                ],
            })]]

        # Hunks remain in "pending" status for user review in the artifact panel.
        # The GraphEngine will detect the pending_approval in the output and pause
        # execution, emitting an SSE interrupt event so the UI can show the review.
        # After the user approves/rejects hunks, the resume_run() method will
        # continue execution and the file_writer will only write approved hunks.

        # Build preview
        preview_lines = []
        for file_entry in doc_changes.get("files", []):
            action_badge = "📝 UPDATE" if file_entry.get("action") == "update" else "✨ CREATE"
            hunk_count = len(file_entry.get("hunks", []))
            preview_lines.append(f"{action_badge} {file_entry.get('path', '?')} ({hunk_count} hunks)")
        preview = "\n".join(preview_lines)

        # Build artifact for ArtifactPanel
        artifact = {
            "id": str(uuid.uuid4()),
            "key": "doc_changes",
            "name": "Documentation Changes",
            "content": f"{total_hunks} changes across {total_files} files",
            "content_json": doc_changes,
            "category": "doc_changes",
            "mime_type": "application/json",
            "file_extension": ".json",
            "version": 1,
        }

        return [[NodeExecutionData(json={
            **input_payload,
            # Set evaluator_decision for conditional edge routing
            # "complete" routes to write_docs, "revise" routes back to draft_docs
            "evaluator_decision": "complete",
            "pending_approval": {
                "gate": "doc_review",
                "artifact_type": "doc_changes",
                "artifact": artifact,
                "artifact_preview": preview,
                "next_phase": "doc_file_writer",
                "message": f"{gate_message} — {total_hunks} changes across {total_files} files.",
            },
        })]]
