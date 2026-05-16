import pytest
from pydantic import ValidationError

from youtube_workflows.models import (
    ChannelProfile,
    ProductionPlan,
    SceneScript,
    Script,
    WorkflowInput,
)


def test_workflow_input_defaults_to_dry_run_and_private_upload():
    item = WorkflowInput(prompt="Make a 90 second architecture explainer")
    assert item.dry_run is True
    assert item.publish_mode == "export"
    assert item.channel_profile_id == "default"


def test_channel_profile_blocks_public_auto_publish():
    profile = ChannelProfile(
        id="test",
        name="Test Channel",
        voice={"tone": "clear"},
        style_rules=["Use original commentary"],
        publish_policy={"privacy_status": "private", "allow_public_upload": False},
        disclosure_policy={"require_ai_disclosure_review": True},
        provider_policy={"max_cost_usd": 2.0, "allow_sota": True},
    )
    assert profile.publish_policy["privacy_status"] == "private"


def test_scene_requires_positive_duration():
    with pytest.raises(ValidationError):
        SceneScript(
            scene_id="s1",
            narration="A short line.",
            visual_prompt="A clean studio shot.",
            motion_prompt="Slow push in.",
            duration_s=0,
        )


def test_script_requires_at_least_one_scene():
    with pytest.raises(ValidationError):
        Script(title="Empty", scenes=[])


def test_production_plan_cost_rollup():
    scene = SceneScript(
        scene_id="s1",
        narration="A short line.",
        visual_prompt="A clean studio shot.",
        motion_prompt="Slow push in.",
        duration_s=5,
        requires_sota=True,
    )
    plan = ProductionPlan.from_script(
        Script(title="Demo", scenes=[scene]),
        provider="veo",
        estimated_cost_usd=1.5,
    )
    assert plan.total_estimated_cost_usd == 1.5
    assert plan.scenes[0].provider == "veo"
