from pathlib import Path

import pytest

from youtube_workflows.praxis_research import gather_praxis_research
from youtube_workflows import praxis_research


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


@pytest.mark.asyncio
async def test_praxis_chat_research_posts_to_regular_chat_channel(monkeypatch):
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "response": "Praxis found tool registry evidence, workflow gates, and local model routing.",
                "conversationId": "conv-1",
                "assistantMessageId": "msg-1",
            }

    class FakeClient:
        def __init__(self, timeout):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, json):
            captured["url"] = url
            captured["json"] = json
            return FakeResponse()

    monkeypatch.setattr(praxis_research.httpx, "AsyncClient", FakeClient)

    brief = await praxis_research.gather_praxis_chat_research(
        "Please create an introduction video about Praxis",
        project_root=Path(__file__).resolve().parents[2],
    )

    assert captured["url"].endswith("/api/ai/chat")
    assert captured["json"]["mode"] == "praxis"
    assert "Do not draft the video concept yet" in captured["json"]["message"]
    assert brief.evidence[0].source_type == "praxis_chat"
    assert brief.evidence[0].metadata["conversation_id"] == "conv-1"
    assert "tool registry evidence" in brief.summary
