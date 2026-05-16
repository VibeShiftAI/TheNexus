from youtube_workflows.models import SceneScript, WorkflowInput
from youtube_workflows.profiles import get_channel_profile
from youtube_workflows.provider_router import ProviderRouter


def test_default_profile_is_private_first():
    profile = get_channel_profile("default")
    assert profile.publish_policy["privacy_status"] == "private"
    assert profile.publish_policy["allow_public_upload"] is False


def test_dry_run_forces_zero_cost_provider():
    router = ProviderRouter()
    profile = get_channel_profile("default")
    decision = router.choose_scene_provider(
        SceneScript(
            scene_id="s1",
            narration="Line",
            visual_prompt="Studio",
            motion_prompt="Slow zoom",
            duration_s=5,
            requires_sota=True,
        ),
        WorkflowInput(prompt="Demo", dry_run=True, max_cost_usd=0),
        profile,
    )
    assert decision.provider == "dry_run"
    assert decision.estimated_cost_usd == 0
    assert decision.requires_cost_approval is False


def test_veo_scene_requires_cost_approval_when_allowed():
    router = ProviderRouter(veo_usd_per_second=0.30, available_providers={"veo"})
    profile = get_channel_profile("default")
    decision = router.choose_scene_provider(
        SceneScript(
            scene_id="s1",
            narration="Line",
            visual_prompt="Cinematic lab",
            motion_prompt="Camera orbit",
            duration_s=5,
            requires_sota=True,
        ),
        WorkflowInput(prompt="Demo", dry_run=False, max_cost_usd=2.0),
        profile,
    )
    assert decision.provider == "veo"
    assert decision.estimated_cost_usd == 1.5
    assert decision.requires_cost_approval is True


def test_cost_ceiling_falls_back_to_existing_adapter():
    router = ProviderRouter(veo_usd_per_second=0.30, available_providers={"veo"})
    profile = get_channel_profile("default")
    decision = router.choose_scene_provider(
        SceneScript(
            scene_id="s1",
            narration="Line",
            visual_prompt="Cinematic lab",
            motion_prompt="Camera orbit",
            duration_s=10,
            requires_sota=True,
        ),
        WorkflowInput(prompt="Demo", dry_run=False, max_cost_usd=1.0),
        profile,
    )
    assert decision.provider == "existing_adapter"
    assert "cost ceiling" in decision.reason


def test_explicit_zero_cost_ceiling_blocks_profile_paid_default():
    router = ProviderRouter(veo_usd_per_second=0.30, available_providers={"veo"})
    profile = get_channel_profile("praxis")
    decision = router.choose_scene_provider(
        SceneScript(
            scene_id="s1",
            narration="Line",
            visual_prompt="Cinematic lab",
            motion_prompt="Camera orbit",
            duration_s=5,
            requires_sota=True,
        ),
        WorkflowInput(prompt="Demo", dry_run=False, max_cost_usd=0.0),
        profile,
    )
    assert decision.provider == "existing_adapter"
    assert decision.estimated_cost_usd == 0.0
    assert "cost ceiling" in decision.reason


def test_missing_veo_credentials_fall_back_to_existing_adapter():
    router = ProviderRouter(veo_usd_per_second=0.30, available_providers=set())
    profile = get_channel_profile("default")
    decision = router.choose_scene_provider(
        SceneScript(
            scene_id="s1",
            narration="Line",
            visual_prompt="Cinematic lab",
            motion_prompt="Camera orbit",
            duration_s=5,
            requires_sota=True,
        ),
        WorkflowInput(prompt="Demo", dry_run=False, max_cost_usd=2.0),
        profile,
    )
    assert decision.provider == "existing_adapter"
    assert "not configured" in decision.reason
