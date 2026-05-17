import pytest

from youtube_workflows import graph as graph_module
from youtube_workflows.graph import build_youtube_graph
from youtube_workflows.models import ResearchBrief, ResearchEvidence, WorkflowInput
from youtube_workflows.state import initial_state


class FakeStrategist:
    async def ainvoke(self, prompt):
        return type(
            "Response",
            (),
            {
                "content": """
                {
                  "title": "Meet Praxis: The Nexus Operator",
                  "logline": "Praxis researches his own tools, memory, and workflow machinery before explaining how he helps build inside The Nexus.",
                  "audience": "Builders evaluating Praxis as a hands-on collaborator.",
                  "promise": "Show the concrete faculties Praxis can use: local reasoning, project context, code search, workflow gates, and media production.",
                  "retention_hook": "Start with Praxis investigating himself in the repo before the voiceover introduces him.",
                  "outline": [
                    "Open on Praxis gathering internal evidence about his own capabilities.",
                    "Explain the local-first reasoning loop and when cloud providers are used.",
                    "Show the approval gates that keep generated media intentional.",
                    "Close by positioning the channel as a documentary of Praxis learning himself."
                  ],
                  "risk_notes": ["Avoid generic assistant claims; cite internal workflow evidence."]
                }
                """,
            },
        )()


class FakeStrategistWithObjectOutline:
    async def ainvoke(self, prompt):
        return type(
            "Response",
            (),
            {
                "content": """
                {
                  "title": "Praxis Investigates Himself",
                  "logline": "Praxis opens the repo, tools, and workflow gates to explain what he can actually do inside The Nexus.",
                  "audience": "People deciding whether Praxis is a real collaborator.",
                  "promise": "Show Praxis using internal evidence to explain his faculties without hype.",
                  "retention_hook": "The first beat is Praxis auditing his own capabilities before the audience hears the thesis.",
                  "outline": [
                    {"beat": "Open with Praxis searching his own tool registry.", "purpose": "Prove the premise visually."},
                    {"beat": "Show workflow gates and local model routing.", "purpose": "Explain how the system stays controlled."}
                  ],
                  "risk_notes": [{"note": "Avoid claiming autonomous publishing without approval."}]
                }
                """,
            },
        )()


@pytest.fixture(autouse=True)
def fake_research(monkeypatch):
    async def _fake_gather(prompt, *args, **kwargs):
        return ResearchBrief(
            summary=f"Praxis chat research for {prompt}",
            evidence=[
                ResearchEvidence(
                    source_type="praxis_chat",
                    title="Praxis chat research response",
                    excerpt="Praxis used the regular chat channel to inspect his tools and workflow context.",
                )
            ],
            claims=["Praxis can research through the regular chat channel."],
            gaps=[],
            angle_notes=["Make Praxis the subject of the episode."],
        )

    monkeypatch.setattr(graph_module, "gather_praxis_research", _fake_gather)


@pytest.mark.asyncio
async def test_graph_reaches_research_gate_first():
    graph = build_youtube_graph()
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))
    result = await graph.ainvoke(state, {"configurable": {"thread_id": "yt-test-research"}})
    assert result["pending_approval"].gate == "research"
    assert result["research_brief"].summary
    assert result["pending_approval"].artifact["summary"] == result["research_brief"].summary
    assert result["research_brief"].source_scope == "praxis_internal"


@pytest.mark.asyncio
async def test_graph_reaches_concept_gate_after_research_approval():
    graph = build_youtube_graph()
    config = {"configurable": {"thread_id": "yt-test-concept"}}
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))

    await graph.ainvoke(state, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    result = await graph.ainvoke(None, config)

    assert result["pending_approval"].gate == "concept"
    assert result["concept"].title
    assert any("internal Praxis evidence" in note for note in result["concept"].risk_notes)


@pytest.mark.asyncio
async def test_draft_concept_uses_youtube_strategist_llm(monkeypatch):
    monkeypatch.setattr(graph_module, "get_youtube_llm", lambda role: FakeStrategist())

    graph = build_youtube_graph()
    state = initial_state(
        WorkflowInput(
            prompt="Please create an introduction video about Praxis",
            dry_run=False,
            max_cost_usd=5,
        )
    )
    config = {"configurable": {"thread_id": "yt-test-llm-concept"}}
    await graph.ainvoke(state, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    result = await graph.ainvoke(None, config)

    assert result["pending_approval"].gate == "concept"
    assert result["concept"].title == "Meet Praxis: The Nexus Operator"
    assert "researches his own tools" in result["concept"].logline
    assert "Please create an introduction video about Praxis" not in result["concept"].logline


@pytest.mark.asyncio
async def test_draft_concept_normalizes_object_outline_from_local_llm(monkeypatch):
    monkeypatch.setattr(graph_module, "get_youtube_llm", lambda role: FakeStrategistWithObjectOutline())

    graph = build_youtube_graph()
    state = initial_state(
        WorkflowInput(
            prompt="Please create an introduction video about Praxis",
            dry_run=False,
            max_cost_usd=5,
        )
    )
    config = {"configurable": {"thread_id": "yt-test-object-outline"}}
    await graph.ainvoke(state, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    result = await graph.ainvoke(None, config)

    assert result["concept"].title == "Praxis Investigates Himself"
    assert result["concept"].outline == [
        "Open with Praxis searching his own tool registry. Prove the premise visually.",
        "Show workflow gates and local model routing. Explain how the system stays controlled.",
    ]
    assert "Avoid claiming autonomous publishing without approval." in result["concept"].risk_notes


@pytest.mark.asyncio
async def test_graph_can_resume_to_script_gate():
    graph = build_youtube_graph()
    config = {"configurable": {"thread_id": "yt-test-script"}}
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))
    await graph.ainvoke(state, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    result = await graph.ainvoke(None, config)
    assert result["pending_approval"].gate == "script"
    assert len(result["script"].scenes) >= 1


@pytest.mark.asyncio
async def test_graph_clears_review_decision_before_final_gate():
    graph = build_youtube_graph()
    config = {"configurable": {"thread_id": "yt-test-final-clean"}}
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))

    await graph.ainvoke(state, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    await graph.ainvoke(None, config)
    await graph.aupdate_state(config, {"review_decision": "approve", "pending_approval": None})
    result = await graph.ainvoke(None, config)

    assert result["pending_approval"].gate == "final"
    assert result["review_decision"] is None


@pytest.mark.asyncio
async def test_graph_reject_clears_pending_approval_state():
    graph = build_youtube_graph()
    config = {"configurable": {"thread_id": "yt-test-reject-clean"}}
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))

    await graph.ainvoke(state, config)
    await graph.aupdate_state(config, {"review_decision": "reject"})
    result = await graph.ainvoke(None, config)

    assert result["pending_approval"] is None
    assert result["review_decision"] is None
