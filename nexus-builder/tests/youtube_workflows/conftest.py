import pytest

from youtube_workflows import graph as graph_module
from youtube_workflows.models import ResearchBrief, ResearchEvidence


@pytest.fixture(autouse=True)
def fake_youtube_research(monkeypatch):
    async def _fake_gather(prompt, *args, **kwargs):
        return ResearchBrief(
            summary=f"Praxis chat research for {prompt}",
            evidence=[
                ResearchEvidence(
                    source_type="praxis_chat",
                    title="Praxis chat research response",
                    excerpt="Praxis researched through the regular chat channel.",
                )
            ],
            claims=["Praxis can research through the regular chat channel."],
            gaps=[],
            angle_notes=["Make Praxis the subject of the episode."],
        )

    monkeypatch.setattr(graph_module, "gather_praxis_research", _fake_gather)
