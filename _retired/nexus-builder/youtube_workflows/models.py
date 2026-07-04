from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


PublishMode = Literal["export", "private_upload"]
ReviewDecision = Literal["approve", "revise", "reject"]
RevisionTarget = Literal["research", "concept", "script", "production_plan", "assets", "compliance"]
ProviderName = Literal["dry_run", "local", "existing_adapter", "veo"]
ResearchSourceType = Literal[
    "context",
    "tool_registry",
    "codebase",
    "git",
    "workflow",
    "memory",
    "praxis_chat",
]


class WorkflowInput(BaseModel):
    prompt: str = Field(min_length=1)
    project_id: Optional[str] = None
    task_id: Optional[str] = None
    desired_duration_s: int = Field(default=90, ge=15, le=1800)
    channel_profile_id: str = "default"
    dry_run: bool = True
    publish_mode: PublishMode = "export"
    max_cost_usd: float = Field(default=0.0, ge=0.0)


class ChannelProfile(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    voice: Dict[str, Any] = Field(default_factory=dict)
    style_rules: List[str] = Field(default_factory=list)
    publish_policy: Dict[str, Any] = Field(default_factory=dict)
    disclosure_policy: Dict[str, Any] = Field(default_factory=dict)
    provider_policy: Dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def enforce_private_default(self) -> "ChannelProfile":
        privacy = self.publish_policy.get("privacy_status", "private")
        if privacy != "private":
            raise ValueError("YouTube workflow profiles must default to private upload")
        if self.publish_policy.get("allow_public_upload") is True:
            raise ValueError("public auto-upload is not supported")
        return self


class Concept(BaseModel):
    title: str = Field(min_length=1)
    logline: str = Field(min_length=1)
    audience: str = Field(min_length=1)
    promise: str = Field(min_length=1)
    retention_hook: str = Field(min_length=1)
    outline: List[str] = Field(min_length=1)
    risk_notes: List[str] = Field(default_factory=list)


class ResearchEvidence(BaseModel):
    source_type: ResearchSourceType
    title: str = Field(min_length=1)
    path: Optional[str] = None
    excerpt: str = Field(min_length=1, max_length=500)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ResearchBrief(BaseModel):
    source_scope: Literal["praxis_internal"] = "praxis_internal"
    summary: str = Field(min_length=1)
    evidence: List[ResearchEvidence] = Field(default_factory=list)
    claims: List[str] = Field(default_factory=list)
    gaps: List[str] = Field(default_factory=list)
    angle_notes: List[str] = Field(default_factory=list)


class SceneScript(BaseModel):
    scene_id: str = Field(min_length=1)
    narration: str = Field(min_length=1)
    visual_prompt: str = Field(min_length=1)
    motion_prompt: str = Field(min_length=1)
    duration_s: float = Field(gt=0)
    requires_sota: bool = False
    provider_preference: Optional[ProviderName] = None


class Script(BaseModel):
    title: str = Field(min_length=1)
    scenes: List[SceneScript] = Field(min_length=1)
    metadata: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("scenes")
    @classmethod
    def scene_ids_are_unique(cls, scenes: List[SceneScript]) -> List[SceneScript]:
        ids = [scene.scene_id for scene in scenes]
        if len(ids) != len(set(ids)):
            raise ValueError("scene_id values must be unique")
        return scenes


class ProviderDecision(BaseModel):
    scene_id: str
    provider: ProviderName
    reason: str
    estimated_cost_usd: float = Field(ge=0.0)
    requires_cost_approval: bool


class ProductionScene(BaseModel):
    scene_id: str
    provider: ProviderName
    visual_prompt: str
    motion_prompt: str
    duration_s: float = Field(gt=0)
    estimated_cost_usd: float = Field(ge=0.0)
    requires_cost_approval: bool


class ProductionPlan(BaseModel):
    scenes: List[ProductionScene] = Field(min_length=1)
    total_estimated_cost_usd: float = Field(ge=0.0)
    cost_approved: bool = False

    @classmethod
    def from_script(
        cls,
        script: Script,
        *,
        provider: ProviderName,
        estimated_cost_usd: float,
    ) -> "ProductionPlan":
        scenes = [
            ProductionScene(
                scene_id=scene.scene_id,
                provider=provider,
                visual_prompt=scene.visual_prompt,
                motion_prompt=scene.motion_prompt,
                duration_s=scene.duration_s,
                estimated_cost_usd=estimated_cost_usd,
                requires_cost_approval=estimated_cost_usd > 0,
            )
            for scene in script.scenes
        ]
        return cls(
            scenes=scenes,
            total_estimated_cost_usd=sum(scene.estimated_cost_usd for scene in scenes),
            cost_approved=False,
        )


class AssetRecord(BaseModel):
    scene_id: str
    asset_type: Literal["voiceover", "still", "clip", "caption", "thumbnail", "final_video"]
    path: str
    provider: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class CostEntry(BaseModel):
    provider: str
    operation: str
    usd: float = Field(ge=0.0)
    scene_id: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ComplianceReport(BaseModel):
    disclosure_required: bool
    blocks_publish: bool
    warnings: List[str] = Field(default_factory=list)
    revision_target: Optional[RevisionTarget] = None


class ApprovalPayload(BaseModel):
    gate: Literal["research", "concept", "script", "cost", "final"]
    message: str
    artifact: Dict[str, Any]
    decisions: List[ReviewDecision]
    revision_targets: List[RevisionTarget] = Field(default_factory=list)
