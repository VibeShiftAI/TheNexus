import pytest
from pathlib import Path

from youtube_workflows.graph import build_youtube_graph, fanout_assets
from youtube_workflows.models import ProductionPlan, ProductionScene, Script, SceneScript, WorkflowInput
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
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    result = await graph.ainvoke(None, config)

    assert result["pending_approval"].gate == "final"
    asset_types = {asset.asset_type for asset in result["assets"]}
    assert {"voiceover", "still", "clip", "final_video"}.issubset(asset_types)
    final_video = next(asset for asset in result["assets"] if asset.asset_type == "final_video")
    assert Path(final_video.path).exists()
    assert Path(final_video.path).stat().st_size > 0
    assert result["final_output"]["video_path"] == final_video.path


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


@pytest.mark.asyncio
async def test_cost_gate_approval_is_persisted_before_asset_generation():
    graph = build_youtube_graph()
    config = {"configurable": {"thread_id": "yt-test-cost-approved"}}
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))

    await graph.ainvoke(state, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    result = await graph.ainvoke(None, config)

    assert result["production_plan"].cost_approved is True
    assert result["pending_approval"].gate == "final"


@pytest.mark.asyncio
async def test_paid_asset_generation_fails_closed_without_cost_approval():
    scene = SceneScript(
        scene_id="s1",
        narration="Line",
        visual_prompt="Cinematic lab",
        motion_prompt="Camera orbit",
        duration_s=5,
        requires_sota=True,
    )
    state = initial_state(WorkflowInput(prompt="Demo", dry_run=False, max_cost_usd=2.0))
    state["script"] = Script(title="Demo", scenes=[scene])
    state["production_plan"] = ProductionPlan(
        scenes=[
            ProductionScene(
                scene_id="s1",
                provider="veo",
                visual_prompt=scene.visual_prompt,
                motion_prompt=scene.motion_prompt,
                duration_s=5,
                estimated_cost_usd=1.5,
                requires_cost_approval=True,
            )
        ],
        total_estimated_cost_usd=1.5,
        cost_approved=False,
    )

    with pytest.raises(RuntimeError, match="Cost approval is required"):
        await fanout_assets(state)
