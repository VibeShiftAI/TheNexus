import pytest

from youtube_workflows import graph as graph_module
from youtube_workflows.models import ResearchBrief, ResearchEvidence


class FakeYouTubeLLM:
    def __init__(self, role):
        self.role = role

    async def ainvoke(self, prompt):
        if self.role == "youtube_scriptwriter":
            content = """
            {
              "title": "Praxis Explains The Nexus",
              "scenes": [
                {
                  "scene_id": "s1",
                  "narration": "Praxis opens with the internal research brief and turns it into an evidence-led story.",
                  "visual_prompt": "Praxis reviewing internal research evidence and workflow gates on The Nexus dashboard.",
                  "motion_prompt": "Slow push across research cards into the workflow graph.",
                  "duration_s": 6,
                  "requires_sota": false,
                  "provider_preference": "local"
                }
              ],
              "metadata": {"source": "youtube_scriptwriter"}
            }
            """
        else:
            content = """
            {
              "title": "Praxis Explains The Nexus",
              "logline": "Praxis uses internal research evidence to explain how The Nexus turns ideas into reviewed workflows.",
              "audience": "Builders and operators evaluating Praxis.",
              "promise": "Show concrete workflow evidence instead of generic assistant claims.",
              "retention_hook": "Open with Praxis inspecting his own project evidence.",
              "outline": [
                "Open with the internal research brief.",
                "Show the workflow gates and local-first model routing.",
                "Explain how reviewed scripts become production plans.",
                "Close with the approval path before media generation."
              ],
              "risk_notes": ["Review claims against internal Praxis evidence."]
            }
            """
        return type("Response", (), {"content": content})()


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
    monkeypatch.setattr(graph_module, "get_youtube_llm", lambda role: FakeYouTubeLLM(role))
