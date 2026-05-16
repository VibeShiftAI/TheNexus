from __future__ import annotations

import uuid
from typing import Any, Dict, List

from .core import AtomicNode, NodeExecutionContext, NodeExecutionData
from youtube_workflows.graph import build_youtube_graph
from youtube_workflows.models import WorkflowInput
from youtube_workflows.state import initial_state


class YouTubeProductionNode(AtomicNode):
    type_id = "youtube_production"
    display_name = "YouTube Production"
    description = "Starts the reviewed local-first YouTube production workflow"
    category = "media"
    icon = "video"
    version = 1.0
    levels = ["project"]
    node_type = "orchestrator"

    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Prompt",
                "name": "prompt",
                "type": "string",
                "default": "",
                "description": "Video brief or production request",
                "required": False,
            },
            {
                "displayName": "Channel Profile",
                "name": "channel_profile_id",
                "type": "string",
                "default": "default",
                "description": "YouTube channel profile ID",
            },
            {
                "displayName": "Dry Run",
                "name": "dry_run",
                "type": "boolean",
                "default": True,
                "description": "Use placeholder media and zero-cost providers",
            },
            {
                "displayName": "Max Cost USD",
                "name": "max_cost_usd",
                "type": "number",
                "default": 0,
                "description": "Maximum approved provider estimate",
            },
        ]

    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData],
    ) -> List[List[NodeExecutionData]]:
        state = items[0].json if items else {}
        context = state.get("context", {})

        workflow_input = WorkflowInput(
            prompt=(
                ctx.get_node_parameter("prompt", "")
                or context.get("task_title")
                or context.get("title")
                or "Create a reviewed YouTube video."
            ),
            project_id=ctx.project_id or context.get("project_id"),
            task_id=ctx.task_id or context.get("task_id"),
            channel_profile_id=ctx.get_node_parameter("channel_profile_id", "default"),
            dry_run=ctx.get_node_parameter("dry_run", True),
            publish_mode=ctx.get_node_parameter("publish_mode", "export"),
            max_cost_usd=ctx.get_node_parameter("max_cost_usd", 0.0),
        )
        run_id = context.get("run_id") or f"yt-template-{uuid.uuid4().hex[:10]}"
        result = await build_youtube_graph().ainvoke(
            initial_state(workflow_input),
            {"configurable": {"thread_id": run_id}},
        )

        merged = {
            **state,
            "pending_approval": result.get("pending_approval"),
            "outputs": {
                **state.get("outputs", {}),
                "youtube_workflow": result,
            },
        }
        return [[NodeExecutionData(json=merged)]]
