from youtube_workflows.models import AssetRecord, CostEntry
from youtube_workflows.state import append_assets, append_costs, clear_pending_approval


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


def test_clear_pending_approval_resets_review_fields():
    state_update = clear_pending_approval()
    assert state_update == {
        "pending_approval": None,
        "review_decision": None,
        "review_notes": None,
        "revision_target": None,
    }
