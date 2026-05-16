import pytest

from youtube_workflows.graph import build_youtube_graph
from youtube_workflows.models import WorkflowInput
from youtube_workflows.state import initial_state


@pytest.mark.asyncio
async def test_graph_reaches_concept_gate_in_dry_run():
    graph = build_youtube_graph()
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))
    result = await graph.ainvoke(state, {"configurable": {"thread_id": "yt-test-concept"}})
    assert result["pending_approval"].gate == "concept"
    assert result["concept"].title


@pytest.mark.asyncio
async def test_graph_can_resume_to_script_gate():
    graph = build_youtube_graph()
    config = {"configurable": {"thread_id": "yt-test-script"}}
    state = initial_state(WorkflowInput(prompt="Explain The Nexus architecture"))
    await graph.ainvoke(state, config)
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
