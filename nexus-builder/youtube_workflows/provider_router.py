from __future__ import annotations

from .models import ChannelProfile, ProviderDecision, SceneScript, WorkflowInput


class ProviderRouter:
    def __init__(self, *, veo_usd_per_second: float = 0.30):
        self.veo_usd_per_second = veo_usd_per_second

    def choose_scene_provider(
        self,
        scene: SceneScript,
        workflow_input: WorkflowInput,
        profile: ChannelProfile,
    ) -> ProviderDecision:
        if workflow_input.dry_run:
            return ProviderDecision(
                scene_id=scene.scene_id,
                provider="dry_run",
                reason="dry_run is enabled",
                estimated_cost_usd=0.0,
                requires_cost_approval=False,
                fallback_provider="dry_run",
            )

        policy = profile.provider_policy
        allow_sota = bool(policy.get("allow_sota", False))
        max_cost = workflow_input.max_cost_usd
        if max_cost <= 0:
            max_cost = float(policy.get("max_cost_usd", 0.0) or 0.0)

        wants_veo = scene.requires_sota or scene.provider_preference == "veo"
        estimated_veo = round(scene.duration_s * self.veo_usd_per_second, 4)

        if wants_veo and allow_sota and estimated_veo <= max_cost:
            return ProviderDecision(
                scene_id=scene.scene_id,
                provider="veo",
                reason="scene requests SOTA video and cost is within ceiling",
                estimated_cost_usd=estimated_veo,
                requires_cost_approval=True,
                fallback_provider="existing_adapter",
            )

        if wants_veo and estimated_veo > max_cost:
            reason = f"Veo estimate ${estimated_veo:.2f} exceeds cost ceiling ${max_cost:.2f}"
        elif wants_veo and not allow_sota:
            reason = "profile does not allow SOTA video providers"
        else:
            reason = "routine scene uses existing low-cost adapter"

        return ProviderDecision(
            scene_id=scene.scene_id,
            provider="existing_adapter",
            reason=reason,
            estimated_cost_usd=0.0,
            requires_cost_approval=False,
            fallback_provider="dry_run",
        )
