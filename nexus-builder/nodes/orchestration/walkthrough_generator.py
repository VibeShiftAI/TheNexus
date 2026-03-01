"""
Walkthrough Generator Node — Atomic node for synthesizing workflow walkthroughs.

Delegates to the call_walkthrough_generator() function from supervisor.agent,
making it a configurable, visible node in the workflow builder.
"""

from typing import Any, Dict, List
from ..core import AtomicNode, NodeExecutionContext, NodeExecutionData


class WalkthroughGeneratorNode(AtomicNode):
    """
    Synthesizes a human-readable walkthrough from all workflow artifacts.

    Runs after the audit fleet approves. Uses an LLM to combine the
    research dossier, blueprint, builder output, and audit verdict
    into a structured walkthrough document.
    """

    type_id = "walkthrough_generator"
    display_name = "Walkthrough Generator"
    description = "Synthesizes a walkthrough from workflow artifacts"
    category = "orchestration"
    icon = "📖"
    version = 1.0
    levels = ["project", "task"]
    node_type = "processor"

    def get_properties(self) -> List[Dict[str, Any]]:
        return [
            {
                "displayName": "Model",
                "name": "model",
                "type": "modelSelector",
                "default": "",
                "description": "AI model for walkthrough synthesis",
            },
        ]

    async def execute(
        self,
        ctx: NodeExecutionContext,
        items: List[NodeExecutionData]
    ) -> List[List[NodeExecutionData]]:
        """Execute the walkthrough generator."""
        from supervisor.agent import call_walkthrough_generator

        state = items[0].json if items else {}

        # Inject model override if configured
        model_id = ctx.get_node_parameter("model", "")
        if model_id:
            overrides = state.get("model_overrides", {})
            overrides["walkthrough_model"] = model_id
            state["model_overrides"] = overrides

        try:
            result = await call_walkthrough_generator(state)
            # Merge result into state
            merged = {**state, **result}
            return [[NodeExecutionData(json=merged)]]
        except Exception as e:
            print(f"[WalkthroughGenerator] Error: {e}")
            return [[NodeExecutionData(
                json={**state, "error": str(e)},
                error=e
            )]]
