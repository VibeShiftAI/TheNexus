from youtube_workflows.models import AssetRecord, CostEntry, WorkflowInput
from youtube_workflows.state import (
    append_assets,
    append_costs,
    append_warnings,
    clear_pending_approval,
    initial_state,
)


def test_append_assets_preserves_existing_records():
    existing = [
        AssetRecord(
            scene_id="s1",
            asset_type="still",
            path="/tmp/a.png",
            provider="dry_run",
        )
    ]
    incoming = [
        AssetRecord(
            scene_id="s1",
            asset_type="clip",
            path="/tmp/a.mp4",
            provider="dry_run",
        )
    ]
    merged = append_assets(existing, incoming)
    assert [item.asset_type for item in merged] == ["still", "clip"]


def test_append_costs_preserves_zero_cost_entries():
    existing = [CostEntry(provider="dry_run", operation="still", usd=0.0, scene_id="s1")]
    incoming = [CostEntry(provider="dry_run", operation="clip", usd=0.0, scene_id="s1")]
    merged = append_costs(existing, incoming)
    assert len(merged) == 2
    assert sum(item.usd for item in merged) == 0.0


def test_append_reducers_accept_none_inputs():
    asset = AssetRecord(
        scene_id="s1",
        asset_type="still",
        path="/tmp/a.png",
        provider="dry_run",
    )
    cost = CostEntry(provider="dry_run", operation="still", usd=0.0, scene_id="s1")

    assert append_assets(None, [asset]) == [asset]
    assert append_assets([asset], None) == [asset]
    assert append_costs(None, [cost]) == [cost]
    assert append_costs([cost], None) == [cost]
    assert append_warnings(None, ["warning"]) == ["warning"]
    assert append_warnings(["warning"], None) == ["warning"]


def test_append_reducers_do_not_mutate_existing_lists():
    existing_assets = [
        AssetRecord(
            scene_id="s1",
            asset_type="still",
            path="/tmp/a.png",
            provider="dry_run",
        )
    ]
    asset = AssetRecord(
        scene_id="s1",
        asset_type="clip",
        path="/tmp/a.mp4",
        provider="dry_run",
    )
    existing_costs = [
        CostEntry(provider="dry_run", operation="still", usd=0.0, scene_id="s1")
    ]
    cost = CostEntry(provider="dry_run", operation="clip", usd=0.0, scene_id="s1")
    existing_warnings = ["a"]

    assert append_assets(existing_assets, [asset]) == [*existing_assets, asset]
    assert existing_assets == [
        AssetRecord(
            scene_id="s1",
            asset_type="still",
            path="/tmp/a.png",
            provider="dry_run",
        )
    ]
    assert append_costs(existing_costs, [cost]) == [*existing_costs, cost]
    assert existing_costs == [
        CostEntry(provider="dry_run", operation="still", usd=0.0, scene_id="s1")
    ]
    assert append_warnings(existing_warnings, ["b"]) == ["a", "b"]
    assert existing_warnings == ["a"]


def test_initial_state_sets_review_and_reducer_defaults():
    workflow_input = WorkflowInput(prompt="Demo")
    state = initial_state(workflow_input)

    assert state["input"] is workflow_input
    assert state["assets"] == []
    assert state["costs"] == []
    assert state["warnings"] == []
    assert state["pending_approval"] is None
    assert state["review_decision"] is None
    assert state["review_notes"] is None
    assert state["revision_target"] is None


def test_clear_pending_approval_resets_review_fields():
    state_update = clear_pending_approval()
    assert state_update == {
        "pending_approval": None,
        "review_decision": None,
        "review_notes": None,
        "revision_target": None,
    }
