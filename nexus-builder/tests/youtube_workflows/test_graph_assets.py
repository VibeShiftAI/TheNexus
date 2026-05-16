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


@pytest.mark.asyncio
async def test_final_gate_revise_does_not_duplicate_dry_run_assets():
    graph = build_youtube_graph()
    config = {"configurable": {"thread_id": "yt-test-assets-revise"}}
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))

    await graph.ainvoke(state, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    first_final = await graph.ainvoke(None, config)

    await graph.aupdate_state(config, {"review_decision": "revise", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    result = await graph.ainvoke(None, config)

    assert first_final["pending_approval"].gate == "final"
    assert result["pending_approval"].gate == "final"
    identity = [
        (asset.scene_id, asset.asset_type, asset.path, asset.provider)
        for asset in result["assets"]
    ]
    assert len(identity) == len(set(identity))
    assert len(identity) == len(first_final["assets"])
