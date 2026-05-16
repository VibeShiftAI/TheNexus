from pathlib import Path

import pytest

from youtube_workflows.praxis_research import gather_praxis_research


@pytest.mark.asyncio
async def test_praxis_research_collects_internal_evidence():
    project_root = Path(__file__).resolve().parents[2]

    brief = await gather_praxis_research(
        prompt="Create an introduction video about Praxis",
        project_root=project_root,
    )

    source_types = {item.source_type for item in brief.evidence}
    assert brief.source_scope == "praxis_internal"
    assert "tool_registry" in source_types
    assert "codebase" in source_types
    assert "git" in source_types
    tool_evidence = next(item for item in brief.evidence if item.source_type == "tool_registry")
    assert "veo_animate" in tool_evidence.excerpt
    assert "tts_generate" in tool_evidence.excerpt
    assert any("Praxis" in claim or "workflow" in claim for claim in brief.claims)
    assert brief.summary


@pytest.mark.asyncio
async def test_praxis_research_keeps_excerpts_compact():
    project_root = Path(__file__).resolve().parents[2]

    brief = await gather_praxis_research(
        prompt="Create an introduction video about Praxis",
        project_root=project_root,
    )

    assert brief.evidence
    assert all(len(item.excerpt) <= 500 for item in brief.evidence)
