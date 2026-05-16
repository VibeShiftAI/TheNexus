import pytest

from youtube_workflows.graph import build_youtube_graph
from youtube_workflows.models import WorkflowInput
from youtube_workflows.state import initial_state


@pytest.mark.asyncio
async def test_graph_reaches_final_gate_with_dry_run_assets():
    graph = build_youtube_graph()
    config = {"configurable": {"thread_id": "yt-test-assets"}}
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))

    await graph.ainvoke(state, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    result = await graph.ainvoke(None, config)

    assert result["pending_approval"].gate == "final"
    asset_types = {asset.asset_type for asset in result["assets"]}
    assert {"voiceover", "still", "clip", "final_video"}.issubset(asset_types)
