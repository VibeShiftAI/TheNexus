import json
from pathlib import Path

import pytest

from nodes.core import NodeExecutionContext, NodeExecutionData, NodeInfo, WorkflowInfo
from nodes.registry import NodeRegistry
from nodes.youtube_production import YouTubeProductionNode
from youtube_channel_workflow import create_initial_state, create_praxis_reusable_initial_state


def test_youtube_template_exists_and_is_dashboard_level():
    path = Path(__file__).resolve().parents[3] / "config" / "templates" / "workflows" / "youtube-production.json"
    data = json.loads(path.read_text())
    assert data["id"] == "youtube-production"
    assert data["workflow_type"] == "youtube-production"
    assert data["level"] == "project"


def test_youtube_template_stages_match_existing_shape():
    path = Path(__file__).resolve().parents[3] / "config" / "templates" / "workflows" / "youtube-production.json"
    stages = json.loads(path.read_text())["stages"]
    assert [stage["id"] for stage in stages] == ["concept", "script", "cost", "assets", "final"]
    assert [stage["order"] for stage in stages] == [1, 2, 3, 4, 5]
    assert all(stage["name"] for stage in stages)


def test_youtube_template_node_type_is_registered():
    registry = NodeRegistry()
    registry.register(YouTubeProductionNode)

    path = Path(__file__).resolve().parents[3] / "config" / "templates" / "workflows" / "youtube-production.json"
    node_type = json.loads(path.read_text())["nodes"][0]["type"]

    assert registry.get_node_instance(node_type) is not None


@pytest.mark.asyncio
async def test_youtube_template_node_starts_reusable_graph():
    node = YouTubeProductionNode()
    ctx = NodeExecutionContext(
        workflow=WorkflowInfo(id="workflow", name="workflow"),
        node=NodeInfo(
            id="youtube-production",
            name="YouTube Production",
            type="youtube_production",
            type_version=1.0,
            parameters={"prompt": "Explain The Nexus", "dry_run": True},
        ),
    )

    result = await node.execute(ctx, [NodeExecutionData(json={"context": {"run_id": "yt-node-test"}})])

    output = result[0][0].json
    assert output["pending_approval"].gate == "concept"
    assert output["outputs"]["youtube_workflow"]["input"].prompt == "Explain The Nexus"


def test_legacy_initial_state_still_has_channel_plan():
    state = create_initial_state(dry_run=True)
    assert state["channel_plan"] == {}
    assert state["dry_run"] is True


def test_praxis_reusable_initial_state_uses_praxis_profile():
    state = create_praxis_reusable_initial_state(dry_run=True)
    assert state["input"].channel_profile_id == "praxis"
    assert state["input"].dry_run is True
