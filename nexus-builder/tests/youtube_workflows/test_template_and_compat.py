import json
from pathlib import Path

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
