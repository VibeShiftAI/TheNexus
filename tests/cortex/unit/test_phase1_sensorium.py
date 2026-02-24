import pytest
from cortex.sensorium.state import StateManager
from cortex.sensorium.filters import HeuristicFilter

from cortex.sensorium.models import IngestionSource, MediaType

from datetime import datetime

@pytest.mark.unit
def test_heuristic_filter_clickbait():
    f = HeuristicFilter()
    
    # Test Clickbait
    # Test Clickbait
    bad_source = IngestionSource(
        content="SHOCKING! You won't believe this INSANE AI trick! It is MIND-BLOWING!" + " " * 100,
        source_url="http://bad.com",
        media_type=MediaType.RSS,
        publication_date=datetime.now()
    )
    result_bad = f.filter(bad_source)
    assert result_bad.passed is False, f"Expected False (Blocked), got True. Score: {result_bad.clickbait_score}, Flags: {result_bad.flags}"
    assert any("clickbait" in flag for flag in result_bad.flags), f"No clickbait flags found. Flags: {result_bad.flags}"

    # Test Good Content
    good_source = IngestionSource(
        content="Analysis of Transformer Attention mechanisms in deep learning.",
        source_url="http://good.com",
        media_type=MediaType.RSS,
        publication_date=datetime.now()
    )
    # HeuristicFilter also checks length (<100 chars is junk). So we need longer content for "Good".
    good_source.content += " " * 100 
    
    result_good = f.filter(good_source)
    assert result_good.passed is True

@pytest.mark.unit
def test_deduplication(tmp_path):
    # Use tmp_path fixture for isolated file I/O
    f = tmp_path / "state.json"
    mgr = StateManager(filepath=str(f))
    
    assert mgr.is_new("abc") is True
    mgr.mark_seen("abc")
    mgr.save()
    
    # Reload
    mgr2 = StateManager(filepath=str(f))
    assert mgr2.is_new("abc") is False
