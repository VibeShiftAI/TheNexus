# YouTube Production Workflows Implementation Plan

> **Status: ✅ SHIPPED — verified against the codebase 2026-07-02.** The unchecked boxes below were never ticked during execution and are NOT open work. Canonical open-items list: shared-mind vault → `projects/Open Items Board.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable local-first LangGraph YouTube production workflow package that can run dry-run video production, expose human review gates, and reserve paid SOTA providers such as Veo for approved scenes.

**Architecture:** Add a new `nexus-builder/youtube_workflows/` package while keeping the existing Praxis-specific `youtube_channel_workflow.py` intact. The package owns schemas, reducers, profiles, provider routing, local-first LLM access, a reusable LangGraph graph, and a FastAPI surface that Node can proxy. Existing media adapters in `nexus-builder/tools/media/` remain the leaf execution tools.

**Tech Stack:** Python 3.13, FastAPI, LangGraph, Pydantic v2, pytest, pytest-asyncio, existing Cortex `LLMFactory`, existing Node Express LangGraph proxy.

---

## File Structure

- Create `nexus-builder/youtube_workflows/__init__.py`: package exports.
- Create `nexus-builder/youtube_workflows/models.py`: Pydantic data contracts for inputs, profiles, concepts, scripts, production plans, assets, costs, compliance, and gate payloads.
- Create `nexus-builder/youtube_workflows/state.py`: TypedDict graph state plus reducer functions.
- Create `nexus-builder/youtube_workflows/profiles.py`: default and Praxis channel profiles.
- Create `nexus-builder/youtube_workflows/provider_router.py`: deterministic provider selection and cost gate checks.
- Create `nexus-builder/youtube_workflows/llm.py`: role-based LLM access through Cortex `LLMFactory` and thought-block stripping helpers.
- Create `nexus-builder/youtube_workflows/graph.py`: reusable LangGraph nodes and graph assembly.
- Create `nexus-builder/youtube_workflows/api.py`: FastAPI router for start, resume, and inspect operations.
- Modify `nexus-builder/main.py`: include the YouTube workflow router.
- Modify `config/model_registry.yaml`: add YouTube-specific local-first roles.
- Modify `server/routes/langgraph.js`: proxy `/api/langgraph/youtube/*` calls to Python.
- Create `config/templates/workflows/youtube-production.json`: dashboard-visible workflow template metadata.
- Modify `nexus-builder/youtube_channel_workflow.py`: add compatibility wrapper only after the reusable graph works.
- Create tests under `nexus-builder/tests/youtube_workflows/`.

## Task 1: Pydantic Models

**Files:**
- Create: `/Volumes/Projects/TheNexus/nexus-builder/youtube_workflows/__init__.py`
- Create: `/Volumes/Projects/TheNexus/nexus-builder/youtube_workflows/models.py`
- Test: `/Volumes/Projects/TheNexus/nexus-builder/tests/youtube_workflows/test_models.py`

- [ ] **Step 1: Write failing model tests**

Create `nexus-builder/tests/youtube_workflows/test_models.py`:

```python
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
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_models.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'youtube_workflows'`.

- [ ] **Step 3: Implement models**

Create `nexus-builder/youtube_workflows/__init__.py`:

```python
"""Reusable YouTube production workflows for The Nexus."""
```

Create `nexus-builder/youtube_workflows/models.py`:

```python
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


PublishMode = Literal["export", "private_upload"]
ReviewDecision = Literal["approve", "revise", "reject"]
RevisionTarget = Literal["concept", "script", "production_plan", "assets", "compliance"]
ProviderName = Literal["dry_run", "local", "existing_adapter", "veo"]


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
    fallback_provider: ProviderName = "dry_run"


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
    gate: Literal["concept", "script", "cost", "final"]
    message: str
    artifact: Dict[str, Any]
    decisions: List[ReviewDecision]
    revision_targets: List[RevisionTarget] = Field(default_factory=list)
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_models.py -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add nexus-builder/youtube_workflows/__init__.py nexus-builder/youtube_workflows/models.py nexus-builder/tests/youtube_workflows/test_models.py
git commit -m "feat: add youtube workflow schemas"
```

## Task 2: State Reducers

**Files:**
- Create: `/Volumes/Projects/TheNexus/nexus-builder/youtube_workflows/state.py`
- Test: `/Volumes/Projects/TheNexus/nexus-builder/tests/youtube_workflows/test_state.py`

- [ ] **Step 1: Write failing reducer tests**

Create `nexus-builder/tests/youtube_workflows/test_state.py`:

```python
from youtube_workflows.models import AssetRecord, CostEntry
from youtube_workflows.state import append_assets, append_costs, clear_pending_approval


def test_append_assets_preserves_existing_records():
    existing = [AssetRecord(scene_id="s1", asset_type="still", path="/tmp/a.png", provider="dry_run")]
    incoming = [AssetRecord(scene_id="s1", asset_type="clip", path="/tmp/a.mp4", provider="dry_run")]
    merged = append_assets(existing, incoming)
    assert [item.asset_type for item in merged] == ["still", "clip"]


def test_append_costs_preserves_zero_cost_entries():
    existing = [CostEntry(provider="dry_run", operation="still", usd=0.0, scene_id="s1")]
    incoming = [CostEntry(provider="dry_run", operation="clip", usd=0.0, scene_id="s1")]
    merged = append_costs(existing, incoming)
    assert len(merged) == 2
    assert sum(item.usd for item in merged) == 0.0


def test_clear_pending_approval_resets_review_fields():
    state_update = clear_pending_approval()
    assert state_update == {
        "pending_approval": None,
        "review_decision": None,
        "review_notes": None,
        "revision_target": None,
    }
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_state.py -v
```

Expected: FAIL with `ModuleNotFoundError` for `youtube_workflows.state`.

- [ ] **Step 3: Implement state**

Create `nexus-builder/youtube_workflows/state.py`:

```python
from __future__ import annotations

from typing import Annotated, Any, Dict, List, Optional, TypedDict

from langgraph.graph.message import add_messages

from .models import (
    ApprovalPayload,
    AssetRecord,
    ChannelProfile,
    ComplianceReport,
    Concept,
    CostEntry,
    ProductionPlan,
    ReviewDecision,
    RevisionTarget,
    Script,
    WorkflowInput,
)


def append_assets(
    existing: Optional[List[AssetRecord]],
    incoming: Optional[List[AssetRecord]],
) -> List[AssetRecord]:
    return [*(existing or []), *(incoming or [])]


def append_costs(
    existing: Optional[List[CostEntry]],
    incoming: Optional[List[CostEntry]],
) -> List[CostEntry]:
    return [*(existing or []), *(incoming or [])]


def append_warnings(
    existing: Optional[List[str]],
    incoming: Optional[List[str]],
) -> List[str]:
    return [*(existing or []), *(incoming or [])]


class YouTubeWorkflowState(TypedDict, total=False):
    messages: Annotated[List[Dict[str, Any]], add_messages]
    input: WorkflowInput
    channel_profile: ChannelProfile
    research_brief: Dict[str, Any]
    concept: Concept
    script: Script
    production_plan: ProductionPlan
    assets: Annotated[List[AssetRecord], append_assets]
    costs: Annotated[List[CostEntry], append_costs]
    warnings: Annotated[List[str], append_warnings]
    compliance: ComplianceReport
    pending_approval: Optional[ApprovalPayload]
    review_decision: Optional[ReviewDecision]
    review_notes: Optional[str]
    revision_target: Optional[RevisionTarget]
    final_output: Dict[str, Any]


def initial_state(workflow_input: WorkflowInput) -> YouTubeWorkflowState:
    return {
        "messages": [],
        "input": workflow_input,
        "assets": [],
        "costs": [],
        "warnings": [],
        "pending_approval": None,
        "review_decision": None,
        "review_notes": None,
        "revision_target": None,
    }


def clear_pending_approval() -> Dict[str, Any]:
    return {
        "pending_approval": None,
        "review_decision": None,
        "review_notes": None,
        "revision_target": None,
    }
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_state.py -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add nexus-builder/youtube_workflows/state.py nexus-builder/tests/youtube_workflows/test_state.py
git commit -m "feat: add youtube workflow state reducers"
```

## Task 3: Channel Profiles And Provider Router

**Files:**
- Create: `/Volumes/Projects/TheNexus/nexus-builder/youtube_workflows/profiles.py`
- Create: `/Volumes/Projects/TheNexus/nexus-builder/youtube_workflows/provider_router.py`
- Test: `/Volumes/Projects/TheNexus/nexus-builder/tests/youtube_workflows/test_provider_router.py`

- [ ] **Step 1: Write failing provider tests**

Create `nexus-builder/tests/youtube_workflows/test_provider_router.py`:

```python
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
    router = ProviderRouter(veo_usd_per_second=0.30)
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
    router = ProviderRouter(veo_usd_per_second=0.30)
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
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_provider_router.py -v
```

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement profiles and router**

Create `nexus-builder/youtube_workflows/profiles.py`:

```python
from __future__ import annotations

from .models import ChannelProfile


DEFAULT_PROFILE = ChannelProfile(
    id="default",
    name="Default YouTube Channel",
    voice={"tone": "clear, original, useful", "pace": "medium"},
    style_rules=[
        "Lead with the viewer value.",
        "Include original commentary, not only summary.",
        "Avoid static slideshow pacing.",
    ],
    publish_policy={"privacy_status": "private", "allow_public_upload": False},
    disclosure_policy={"require_ai_disclosure_review": True},
    provider_policy={"allow_sota": True, "max_cost_usd": 0.0},
)


PRAXIS_PROFILE = ChannelProfile(
    id="praxis",
    name="Praxis Self-Narrated Channel",
    voice={"tone": "thoughtful, technical, first-person", "pace": "measured"},
    style_rules=[
        "Praxis speaks in first person about his own architecture.",
        "Explain systems concretely through design decisions and tradeoffs.",
        "Keep the episode useful to builders of agentic systems.",
    ],
    publish_policy={"privacy_status": "private", "allow_public_upload": False},
    disclosure_policy={"require_ai_disclosure_review": True},
    provider_policy={"allow_sota": True, "max_cost_usd": 5.0},
)


_PROFILES = {
    DEFAULT_PROFILE.id: DEFAULT_PROFILE,
    PRAXIS_PROFILE.id: PRAXIS_PROFILE,
}


def get_channel_profile(profile_id: str) -> ChannelProfile:
    return _PROFILES.get(profile_id, DEFAULT_PROFILE)
```

Create `nexus-builder/youtube_workflows/provider_router.py`:

```python
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
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_provider_router.py -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add nexus-builder/youtube_workflows/profiles.py nexus-builder/youtube_workflows/provider_router.py nexus-builder/tests/youtube_workflows/test_provider_router.py
git commit -m "feat: add youtube provider routing"
```

## Task 4: Local-First LLM Roles

**Files:**
- Create: `/Volumes/Projects/TheNexus/nexus-builder/youtube_workflows/llm.py`
- Modify: `/Volumes/Projects/TheNexus/config/model_registry.yaml`
- Modify: `/Volumes/Projects/TheNexus/cortex/llm_factory.py`
- Test: `/Volumes/Projects/TheNexus/nexus-builder/tests/youtube_workflows/test_llm.py`

- [ ] **Step 1: Write failing LLM tests**

Create `nexus-builder/tests/youtube_workflows/test_llm.py`:

```python
from youtube_workflows.llm import strip_thought_blocks, youtube_role_to_model_role


def test_strip_thought_blocks_removes_gemma_thought_channel():
    text = "<|channel>thought\nprivate notes<channel|>\nFinal answer"
    assert strip_thought_blocks(text).strip() == "Final answer"


def test_strip_thought_blocks_removes_xml_think_block():
    text = "<think>private notes</think>\nVisible"
    assert strip_thought_blocks(text).strip() == "Visible"


def test_youtube_roles_use_local_first_registry_roles():
    assert youtube_role_to_model_role("youtube_scriptwriter").value == "youtube_scriptwriter"
    assert youtube_role_to_model_role("youtube_compliance").value == "youtube_compliance"
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_llm.py -v
```

Expected: FAIL because `youtube_workflows.llm` does not exist.

- [ ] **Step 3: Add YouTube roles to the Cortex model enum**

Modify `cortex/llm_factory.py` `ModelRole` by adding these enum values after `ORCHESTRATOR`:

```python
    YOUTUBE_ROUTER = "youtube_router"
    YOUTUBE_RESEARCHER = "youtube_researcher"
    YOUTUBE_STRATEGIST = "youtube_strategist"
    YOUTUBE_SCRIPTWRITER = "youtube_scriptwriter"
    YOUTUBE_PRODUCER = "youtube_producer"
    YOUTUBE_COMPLIANCE = "youtube_compliance"
```

- [ ] **Step 4: Implement LLM helper**

Create `nexus-builder/youtube_workflows/llm.py`:

```python
from __future__ import annotations

import re
from typing import Literal

from cortex.llm_factory import ModelRole, get_llm_for_role


YouTubeRole = Literal[
    "youtube_router",
    "youtube_researcher",
    "youtube_strategist",
    "youtube_scriptwriter",
    "youtube_producer",
    "youtube_compliance",
]


_THOUGHT_PATTERNS = [
    re.compile(r"<\|channel\>thought\n.*?<channel\|>\s*", re.DOTALL),
    re.compile(r"<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE),
]


def strip_thought_blocks(text: str) -> str:
    cleaned = text
    for pattern in _THOUGHT_PATTERNS:
        cleaned = pattern.sub("", cleaned)
    return cleaned


def youtube_role_to_model_role(role: YouTubeRole) -> ModelRole:
    role_map = {
        "youtube_router": ModelRole.YOUTUBE_ROUTER,
        "youtube_researcher": ModelRole.YOUTUBE_RESEARCHER,
        "youtube_strategist": ModelRole.YOUTUBE_STRATEGIST,
        "youtube_scriptwriter": ModelRole.YOUTUBE_SCRIPTWRITER,
        "youtube_producer": ModelRole.YOUTUBE_PRODUCER,
        "youtube_compliance": ModelRole.YOUTUBE_COMPLIANCE,
    }
    return role_map[role]


def get_youtube_llm(role: YouTubeRole):
    return get_llm_for_role(youtube_role_to_model_role(role))
```

- [ ] **Step 5: Add model registry roles**

Modify `config/model_registry.yaml` under `roles:` with:

```yaml
  youtube_router:
    strategy: fixed
    model: local-default
    temperature: 0.0
    description: "YouTube workflow request classification and channel/profile routing"

  youtube_researcher:
    strategy: fixed
    model: local-default
    temperature: 0.2
    description: "YouTube workflow research summarization with local-first context"

  youtube_strategist:
    strategy: fixed
    model: local-default
    temperature: 0.5
    description: "YouTube concept, audience, promise, and retention structure"

  youtube_scriptwriter:
    strategy: fixed
    model: local-default
    temperature: 0.7
    description: "YouTube scene-by-scene scriptwriting"

  youtube_producer:
    strategy: fixed
    model: local-default
    temperature: 0.3
    description: "YouTube production plans and render prompts"

  youtube_compliance:
    strategy: fixed
    model: local-default
    temperature: 0.1
    description: "YouTube AI disclosure, originality, cadence, and upload policy checks"
```

- [ ] **Step 6: Run tests and verify pass**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_llm.py -v
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add config/model_registry.yaml cortex/llm_factory.py nexus-builder/youtube_workflows/llm.py nexus-builder/tests/youtube_workflows/test_llm.py
git commit -m "feat: add local-first youtube llm roles"
```

## Task 5: Reusable Dry-Run Graph And Review Gates

**Files:**
- Create: `/Volumes/Projects/TheNexus/nexus-builder/youtube_workflows/graph.py`
- Test: `/Volumes/Projects/TheNexus/nexus-builder/tests/youtube_workflows/test_graph.py`

- [ ] **Step 1: Write failing graph tests**

Create `nexus-builder/tests/youtube_workflows/test_graph.py`:

```python
import pytest

from youtube_workflows.graph import build_youtube_graph
from youtube_workflows.models import WorkflowInput
from youtube_workflows.state import initial_state


@pytest.mark.asyncio
async def test_graph_reaches_concept_gate_in_dry_run():
    graph = build_youtube_graph()
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))
    result = await graph.ainvoke(state, {"configurable": {"thread_id": "yt-test-concept"}})
    assert result["pending_approval"]["gate"] == "concept"
    assert result["concept"].title


@pytest.mark.asyncio
async def test_graph_can_resume_to_script_gate():
    graph = build_youtube_graph()
    config = {"configurable": {"thread_id": "yt-test-script"}}
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))
    await graph.ainvoke(state, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    result = await graph.ainvoke(None, config)
    assert result["pending_approval"]["gate"] == "script"
    assert len(result["script"].scenes) >= 1
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_graph.py -v
```

Expected: FAIL because `youtube_workflows.graph` does not exist.

- [ ] **Step 3: Implement dry-run graph**

Create `nexus-builder/youtube_workflows/graph.py`:

```python
from __future__ import annotations

from typing import Any, Dict, Literal

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from .models import ApprovalPayload, ComplianceReport, Concept, ProductionPlan, SceneScript, Script
from .profiles import get_channel_profile
from .provider_router import ProviderRouter
from .state import YouTubeWorkflowState, clear_pending_approval


GATE_CONCEPT = "concept_gate"
GATE_SCRIPT = "script_gate"
GATE_COST = "cost_gate"
GATE_FINAL = "final_gate"


async def load_channel_profile(state: YouTubeWorkflowState) -> Dict[str, Any]:
    workflow_input = state["input"]
    return {"channel_profile": get_channel_profile(workflow_input.channel_profile_id)}


async def research(state: YouTubeWorkflowState) -> Dict[str, Any]:
    workflow_input = state["input"]
    return {
        "research_brief": {
            "summary": f"Dry-run research brief for: {workflow_input.prompt}",
            "sources": [],
        }
    }


async def draft_concept(state: YouTubeWorkflowState) -> Dict[str, Any]:
    workflow_input = state["input"]
    profile = state["channel_profile"]
    concept = Concept(
        title="Nexus Architecture Explainer",
        logline=f"A useful video about {workflow_input.prompt}.",
        audience="Builders and operators using The Nexus.",
        promise="Show the viewer what the system does and why the workflow matters.",
        retention_hook="Open with the concrete outcome before explaining the machinery.",
        outline=[
            "State the practical problem.",
            "Show the workflow shape.",
            "Explain where human review protects quality.",
            "Close with the next action.",
        ],
        risk_notes=list(profile.style_rules),
    )
    return {"concept": concept, **clear_pending_approval()}


async def concept_gate(state: YouTubeWorkflowState) -> Dict[str, Any]:
    payload = ApprovalPayload(
        gate="concept",
        message="Approve the concept to continue to scriptwriting.",
        artifact=state["concept"].model_dump(),
        decisions=["approve", "revise", "reject"],
        revision_targets=["concept"],
    )
    return {"pending_approval": payload}


async def write_script(state: YouTubeWorkflowState) -> Dict[str, Any]:
    concept = state["concept"]
    script = Script(
        title=concept.title,
        scenes=[
            SceneScript(
                scene_id="s1",
                narration="The Nexus turns a rough idea into a reviewed, trackable workflow.",
                visual_prompt="A dark operational dashboard with task cards and workflow lines.",
                motion_prompt="Slow push across the dashboard with subtle parallax.",
                duration_s=5,
            ),
            SceneScript(
                scene_id="s2",
                narration="Local models handle routine reasoning while premium providers stay behind approval gates.",
                visual_prompt="A local workstation connected to labeled model providers.",
                motion_prompt="Camera moves from the local node toward a highlighted cloud node.",
                duration_s=5,
                requires_sota=True,
            ),
        ],
    )
    return {"script": script, **clear_pending_approval()}


async def script_gate(state: YouTubeWorkflowState) -> Dict[str, Any]:
    payload = ApprovalPayload(
        gate="script",
        message="Approve the script to build the production plan.",
        artifact=state["script"].model_dump(),
        decisions=["approve", "revise", "reject"],
        revision_targets=["script"],
    )
    return {"pending_approval": payload}


async def production_plan(state: YouTubeWorkflowState) -> Dict[str, Any]:
    router = ProviderRouter()
    decisions = [
        router.choose_scene_provider(scene, state["input"], state["channel_profile"])
        for scene in state["script"].scenes
    ]
    plan = ProductionPlan(
        scenes=[
            {
                "scene_id": scene.scene_id,
                "provider": decision.provider,
                "visual_prompt": scene.visual_prompt,
                "motion_prompt": scene.motion_prompt,
                "duration_s": scene.duration_s,
                "estimated_cost_usd": decision.estimated_cost_usd,
                "requires_cost_approval": decision.requires_cost_approval,
            }
            for scene, decision in zip(state["script"].scenes, decisions)
        ],
        total_estimated_cost_usd=sum(decision.estimated_cost_usd for decision in decisions),
        cost_approved=False,
    )
    return {"production_plan": plan, **clear_pending_approval()}


async def cost_gate(state: YouTubeWorkflowState) -> Dict[str, Any]:
    payload = ApprovalPayload(
        gate="cost",
        message="Approve the production plan and any paid provider spend.",
        artifact=state["production_plan"].model_dump(),
        decisions=["approve", "revise", "reject"],
        revision_targets=["production_plan", "script"],
    )
    return {"pending_approval": payload}


async def compliance_review(state: YouTubeWorkflowState) -> Dict[str, Any]:
    report = ComplianceReport(
        disclosure_required=True,
        blocks_publish=False,
        warnings=["AI-generated media disclosure review is required before upload."],
    )
    return {"compliance": report}


async def final_gate(state: YouTubeWorkflowState) -> Dict[str, Any]:
    payload = ApprovalPayload(
        gate="final",
        message="Approve the final artifact for local export or private upload.",
        artifact={
            "assets": [asset.model_dump() for asset in state.get("assets", [])],
            "compliance": state["compliance"].model_dump(),
        },
        decisions=["approve", "revise", "reject"],
        revision_targets=["assets", "compliance", "script"],
    )
    return {"pending_approval": payload}


def route_review(state: YouTubeWorkflowState) -> Literal["approve", "revise", "reject"]:
    return state.get("review_decision") or "reject"


def build_youtube_graph(checkpointer=None):
    builder = StateGraph(YouTubeWorkflowState)
    builder.add_node("load_channel_profile", load_channel_profile)
    builder.add_node("research", research)
    builder.add_node("draft_concept", draft_concept)
    builder.add_node(GATE_CONCEPT, concept_gate)
    builder.add_node("write_script", write_script)
    builder.add_node(GATE_SCRIPT, script_gate)
    builder.add_node("production_plan", production_plan)
    builder.add_node(GATE_COST, cost_gate)
    builder.add_node("compliance_review", compliance_review)
    builder.add_node(GATE_FINAL, final_gate)

    builder.add_edge(START, "load_channel_profile")
    builder.add_edge("load_channel_profile", "research")
    builder.add_edge("research", "draft_concept")
    builder.add_edge("draft_concept", GATE_CONCEPT)
    builder.add_conditional_edges(
        GATE_CONCEPT,
        route_review,
        {"approve": "write_script", "revise": "draft_concept", "reject": END},
    )
    builder.add_edge("write_script", GATE_SCRIPT)
    builder.add_conditional_edges(
        GATE_SCRIPT,
        route_review,
        {"approve": "production_plan", "revise": "write_script", "reject": END},
    )
    builder.add_edge("production_plan", GATE_COST)
    builder.add_conditional_edges(
        GATE_COST,
        route_review,
        {"approve": "compliance_review", "revise": "production_plan", "reject": END},
    )
    builder.add_edge("compliance_review", GATE_FINAL)
    builder.add_conditional_edges(
        GATE_FINAL,
        route_review,
        {"approve": END, "revise": "production_plan", "reject": END},
    )

    return builder.compile(
        checkpointer=checkpointer or MemorySaver(),
        interrupt_after=[GATE_CONCEPT, GATE_SCRIPT, GATE_COST, GATE_FINAL],
    )
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_graph.py -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add nexus-builder/youtube_workflows/graph.py nexus-builder/tests/youtube_workflows/test_graph.py
git commit -m "feat: add reusable youtube workflow graph"
```

## Task 6: Asset Fan-Out And Dry-Run Assembly Path

**Files:**
- Modify: `/Volumes/Projects/TheNexus/nexus-builder/youtube_workflows/graph.py`
- Test: `/Volumes/Projects/TheNexus/nexus-builder/tests/youtube_workflows/test_graph_assets.py`

- [ ] **Step 1: Write failing asset graph test**

Create `nexus-builder/tests/youtube_workflows/test_graph_assets.py`:

```python
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

    assert result["pending_approval"]["gate"] == "final"
    asset_types = {asset.asset_type for asset in result["assets"]}
    assert {"voiceover", "still", "clip", "final_video"}.issubset(asset_types)
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_graph_assets.py -v
```

Expected: FAIL because the graph does not create dry-run asset records yet.

- [ ] **Step 3: Add dry-run asset nodes**

Modify `nexus-builder/youtube_workflows/graph.py` imports:

```python
from .models import ApprovalPayload, AssetRecord, ComplianceReport, Concept, CostEntry, ProductionPlan, SceneScript, Script
```

Add these nodes before `compliance_review`:

```python
async def fanout_assets(state: YouTubeWorkflowState) -> Dict[str, Any]:
    assets = []
    costs = []
    for scene in state["script"].scenes:
        assets.extend(
            [
                AssetRecord(
                    scene_id=scene.scene_id,
                    asset_type="voiceover",
                    path=f"/tmp/nexus-youtube/{scene.scene_id}.aiff",
                    provider="dry_run",
                ),
                AssetRecord(
                    scene_id=scene.scene_id,
                    asset_type="still",
                    path=f"/tmp/nexus-youtube/{scene.scene_id}.png",
                    provider="dry_run",
                ),
                AssetRecord(
                    scene_id=scene.scene_id,
                    asset_type="clip",
                    path=f"/tmp/nexus-youtube/{scene.scene_id}.mp4",
                    provider="dry_run",
                    metadata={"duration_s": scene.duration_s},
                ),
            ]
        )
        costs.append(CostEntry(provider="dry_run", operation="scene_assets", usd=0.0, scene_id=scene.scene_id))
    return {"assets": assets, "costs": costs}


async def reduce_assets(state: YouTubeWorkflowState) -> Dict[str, Any]:
    return {}


async def assemble_video(state: YouTubeWorkflowState) -> Dict[str, Any]:
    final = AssetRecord(
        scene_id="final",
        asset_type="final_video",
        path="/tmp/nexus-youtube/final.mp4",
        provider="dry_run",
        metadata={"scene_count": len(state["script"].scenes)},
    )
    return {
        "assets": [final],
        "final_output": {"video_path": final.path, "dry_run": True},
    }
```

In `build_youtube_graph`, add nodes:

```python
    builder.add_node("fanout_assets", fanout_assets)
    builder.add_node("reduce_assets", reduce_assets)
    builder.add_node("assemble_video", assemble_video)
```

Replace the cost approval edge:

```python
        {"approve": "fanout_assets", "revise": "production_plan", "reject": END},
```

Add asset edges:

```python
    builder.add_edge("fanout_assets", "reduce_assets")
    builder.add_edge("reduce_assets", "assemble_video")
    builder.add_edge("assemble_video", "compliance_review")
```

Remove the direct edge from `GATE_COST` approval to `compliance_review` if it remains.

- [ ] **Step 4: Run graph tests**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_graph.py tests/youtube_workflows/test_graph_assets.py -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add nexus-builder/youtube_workflows/graph.py nexus-builder/tests/youtube_workflows/test_graph_assets.py
git commit -m "feat: add dry-run youtube asset path"
```

## Task 7: FastAPI And Node Proxy Integration

**Files:**
- Create: `/Volumes/Projects/TheNexus/nexus-builder/youtube_workflows/api.py`
- Modify: `/Volumes/Projects/TheNexus/nexus-builder/main.py`
- Modify: `/Volumes/Projects/TheNexus/server/routes/langgraph.js`
- Test: `/Volumes/Projects/TheNexus/nexus-builder/tests/youtube_workflows/test_api.py`

- [ ] **Step 1: Write failing API tests**

Create `nexus-builder/tests/youtube_workflows/test_api.py`:

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

from youtube_workflows.api import router


def test_start_youtube_workflow_returns_run_id_and_gate():
    app = FastAPI()
    app.include_router(router, prefix="/api/youtube")
    client = TestClient(app)

    response = client.post("/api/youtube/runs", json={"prompt": "Explain The Nexus"})

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["run_id"].startswith("yt-")
    assert data["pending_approval"]["gate"] == "concept"


def test_get_unknown_youtube_run_returns_404():
    app = FastAPI()
    app.include_router(router, prefix="/api/youtube")
    client = TestClient(app)

    response = client.get("/api/youtube/runs/missing")

    assert response.status_code == 404
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_api.py -v
```

Expected: FAIL because `youtube_workflows.api` does not exist.

- [ ] **Step 3: Implement FastAPI router**

Create `nexus-builder/youtube_workflows/api.py`:

```python
from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .graph import build_youtube_graph
from .models import WorkflowInput
from .state import initial_state


router = APIRouter()
_graph = build_youtube_graph()
_runs: Dict[str, Dict[str, Any]] = {}


class ResumeRequest(BaseModel):
    review_decision: str
    review_notes: str | None = None
    revision_target: str | None = None


def _jsonable_state(state: Dict[str, Any]) -> Dict[str, Any]:
    out = {}
    for key, value in state.items():
        if hasattr(value, "model_dump"):
            out[key] = value.model_dump()
        elif isinstance(value, list):
            out[key] = [item.model_dump() if hasattr(item, "model_dump") else item for item in value]
        else:
            out[key] = value
    return out


@router.post("/runs")
async def start_run(body: Dict[str, Any]):
    workflow_input = WorkflowInput(**body)
    run_id = f"yt-{uuid.uuid4().hex[:10]}"
    config = {"configurable": {"thread_id": run_id}}
    result = await _graph.ainvoke(initial_state(workflow_input), config)
    _runs[run_id] = {"run_id": run_id, "config": config, "state": result}
    state = _jsonable_state(result)
    return {
        "success": True,
        "run_id": run_id,
        "pending_approval": state.get("pending_approval"),
        "state": state,
    }


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="YouTube workflow run not found")
    return {"success": True, "run_id": run_id, "state": _jsonable_state(run["state"])}


@router.post("/runs/{run_id}/resume")
async def resume_run(run_id: str, body: ResumeRequest):
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="YouTube workflow run not found")
    update = {
        "review_decision": body.review_decision,
        "review_notes": body.review_notes,
        "revision_target": body.revision_target,
        "pending_approval": None,
    }
    await _graph.aupdate_state(run["config"], update)
    result = await _graph.ainvoke(None, run["config"])
    run["state"] = result
    state = _jsonable_state(result)
    return {
        "success": True,
        "run_id": run_id,
        "pending_approval": state.get("pending_approval"),
        "state": state,
    }
```

- [ ] **Step 4: Mount Python router**

Modify `nexus-builder/main.py` imports near other routers:

```python
from youtube_workflows.api import router as youtube_workflows_router
```

After existing `app.include_router(...)` calls, add:

```python
app.include_router(youtube_workflows_router, prefix="/api/youtube", tags=["youtube-workflows"])
```

- [ ] **Step 5: Add Node proxy routes**

Modify `server/routes/langgraph.js` before business callbacks:

```javascript
    router.post('/youtube/runs', async (req, res) => {
        try {
            res.json(await lgService.proxyToLangGraph('/api/youtube/runs', {
                method: 'POST',
                body: JSON.stringify(req.body)
            }));
        } catch (error) {
            res.status(503).json({ error: 'YouTube workflow engine unavailable' });
        }
    });

    router.get('/youtube/runs/:runId', async (req, res) => {
        try {
            res.json(await lgService.proxyToLangGraph(`/api/youtube/runs/${req.params.runId}`));
        } catch (error) {
            res.status(503).json({ error: 'YouTube workflow engine unavailable' });
        }
    });

    router.post('/youtube/runs/:runId/resume', async (req, res) => {
        try {
            res.json(await lgService.proxyToLangGraph(`/api/youtube/runs/${req.params.runId}/resume`, {
                method: 'POST',
                body: JSON.stringify(req.body)
            }));
        } catch (error) {
            res.status(503).json({ error: 'YouTube workflow engine unavailable' });
        }
    });
```

- [ ] **Step 6: Run tests and syntax checks**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_api.py -v
python -m py_compile main.py youtube_workflows/api.py
node --check /Volumes/Projects/TheNexus/server/routes/langgraph.js
```

Expected: all commands PASS.

- [ ] **Step 7: Commit**

```bash
git add nexus-builder/youtube_workflows/api.py nexus-builder/main.py server/routes/langgraph.js nexus-builder/tests/youtube_workflows/test_api.py
git commit -m "feat: expose youtube workflow api"
```

## Task 8: Workflow Template And Praxis Compatibility Wrapper

**Files:**
- Create: `/Volumes/Projects/TheNexus/config/templates/workflows/youtube-production.json`
- Modify: `/Volumes/Projects/TheNexus/nexus-builder/youtube_channel_workflow.py`
- Test: `/Volumes/Projects/TheNexus/nexus-builder/tests/youtube_workflows/test_template_and_compat.py`

- [ ] **Step 1: Write failing template and compatibility tests**

Create `nexus-builder/tests/youtube_workflows/test_template_and_compat.py`:

```python
import json
from pathlib import Path

import pytest

from youtube_channel_workflow import create_initial_state, create_praxis_reusable_initial_state


def test_youtube_template_exists_and_is_dashboard_level():
    path = Path(__file__).resolve().parents[3] / "config" / "templates" / "workflows" / "youtube-production.json"
    data = json.loads(path.read_text())
    assert data["id"] == "youtube-production"
    assert data["workflow_type"] == "youtube-production"
    assert data["level"] == "project"


def test_legacy_initial_state_still_has_channel_plan():
    state = create_initial_state(dry_run=True)
    assert state["channel_plan"] == {}
    assert state["dry_run"] is True


def test_praxis_reusable_initial_state_uses_praxis_profile():
    state = create_praxis_reusable_initial_state(dry_run=True)
    assert state["input"].channel_profile_id == "praxis"
    assert state["input"].dry_run is True
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_template_and_compat.py -v
```

Expected: FAIL because the template is absent and `create_praxis_reusable_initial_state` is not defined.

- [ ] **Step 3: Add workflow template**

Create `config/templates/workflows/youtube-production.json`:

```json
{
  "id": "youtube-production",
  "name": "YouTube Production",
  "description": "Create a reviewed YouTube video using local-first cognition, human review gates, dry-run media generation, and optional approved SOTA provider escalation.",
  "level": "project",
  "workflow_type": "youtube-production",
  "stages": [
    "concept",
    "script",
    "cost",
    "assets",
    "final"
  ],
  "nodes": [
    {
      "id": "youtube-production",
      "type": "youtube_production",
      "position": {
        "x": 250,
        "y": 120
      },
      "data": {
        "label": "YouTube Production",
        "config": {
          "channel_profile_id": "default",
          "dry_run": true,
          "publish_mode": "export"
        }
      }
    }
  ],
  "edges": [],
  "conditionalEdges": []
}
```

- [ ] **Step 4: Add Praxis reusable wrapper state without changing the legacy graph entry point**

Modify `nexus-builder/youtube_channel_workflow.py` imports:

```python
from youtube_workflows.models import WorkflowInput
from youtube_workflows.state import initial_state as reusable_initial_state
```

Add this helper below `create_initial_state`:

```python
def create_praxis_reusable_initial_state(*, dry_run: bool = True):
    """Initial reusable workflow state for the Praxis channel profile."""
    return reusable_initial_state(
        WorkflowInput(
            prompt="Produce the next Praxis self-narrated YouTube episode.",
            channel_profile_id="praxis",
            dry_run=dry_run,
            publish_mode="private_upload",
            max_cost_usd=5.0,
        )
    )
```

Do not change `create_initial_state` or `run_episode` in this task. They must keep using the legacy compiled graph until the reusable graph is manually selected through the new API.

- [ ] **Step 5: Run tests**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows/test_template_and_compat.py -v
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add config/templates/workflows/youtube-production.json nexus-builder/youtube_channel_workflow.py nexus-builder/tests/youtube_workflows/test_template_and_compat.py
git commit -m "feat: add youtube workflow template"
```

## Task 9: End-To-End Verification

**Files:**
- No new files.

- [ ] **Step 1: Run all YouTube workflow tests**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/youtube_workflows -v
```

Expected: all YouTube workflow tests PASS.

- [ ] **Step 2: Run existing registry smoke test**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
pytest tests/test_tool_registry.py -v
```

Expected: PASS or existing unrelated failures only. If failures mention media tool count changing, update the expected count only after confirming no tools disappeared.

- [ ] **Step 3: Compile Python entry points**

Run:

```bash
cd /Volumes/Projects/TheNexus/nexus-builder
python -m py_compile main.py youtube_workflows/models.py youtube_workflows/state.py youtube_workflows/profiles.py youtube_workflows/provider_router.py youtube_workflows/llm.py youtube_workflows/graph.py youtube_workflows/api.py youtube_channel_workflow.py
```

Expected: no output and exit code 0.

- [ ] **Step 4: Check Node route syntax**

Run:

```bash
cd /Volumes/Projects/TheNexus
node --check server/routes/langgraph.js
```

Expected: no output and exit code 0.

- [ ] **Step 5: Inspect final git diff**

Run:

```bash
cd /Volumes/Projects/TheNexus
git status --short
git diff --stat
```

Expected: only files from this plan plus pre-existing unrelated working-tree changes. Do not stage or alter unrelated dashboard/contract changes.

- [ ] **Step 6: Final commit if verification fixes were needed**

If Task 9 required any code or test edits, commit them:

```bash
git add nexus-builder/youtube_workflows nexus-builder/tests/youtube_workflows nexus-builder/main.py nexus-builder/youtube_channel_workflow.py server/routes/langgraph.js config/model_registry.yaml config/templates/workflows/youtube-production.json
git commit -m "test: verify youtube production workflow"
```

If Task 9 required no edits, do not create an empty commit.

## Self-Review Notes

- Spec coverage: schemas, state reducers, local-first roles, provider routing, graph gates, asset path, compliance review, API/template integration, Praxis profile, and dry-run verification are all mapped to tasks.
- Live Veo 3.1 adapter verification is intentionally not implemented in this plan because the first slice is dry-run-first and paid-provider-safe. The provider router and cost gate create the controlled point where that adapter update can happen next.
- Public auto-publishing, YouTube Analytics, scheduling automation, and rich dashboard review UI remain out of scope as specified.
