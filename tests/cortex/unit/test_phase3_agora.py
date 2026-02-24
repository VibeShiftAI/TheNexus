import pytest
from unittest.mock import patch
from cortex.agora.graph import build_agora_graph
from cortex.agora.state import Proposal, Critique, Verdict

@pytest.mark.unit
@pytest.mark.asyncio
async def test_debate_loop_logic(mock_pydantic_llm):
    """
    Scenario:
    1. Proposer submits Weak Idea.
    2. Red Cell critiques.
    3. Judge REJECTS.
    4. Proposer submits Strong Idea.
    5. Red Cell critiques.
    6. Judge APPROVES.
    """
    # Define Data Objects
    prop_weak = Proposal(author="A", content="Weak", citations=[], confidence=0.5)
    prop_strong = Proposal(author="A", content="Strong", citations=[], confidence=0.9)
    crit_harsh = Critique(author="B", target_proposal_index=0, content="Bad", severity=0.9, fallacies=[])
    crit_mild = Critique(author="B", target_proposal_index=1, content="Ok", severity=0.1, fallacies=[])
    verd_reject = Verdict(approved=False, score=0.2, reasoning="Retry", feedback="Fix it")
    verd_approve = Verdict(approved=True, score=0.9, reasoning="Good", feedback="")

    # Mock the Factory to return our sequence of responses
    with patch("cortex.agora.nodes.llm_factory") as mock_factory:
        # We assume the nodes call: Proposer, then RedCell, then Judge
        # Iteration 1:
        m_prop = mock_pydantic_llm([prop_weak, prop_strong]) # Returns weak, then strong
        m_red = mock_pydantic_llm([crit_harsh, crit_mild])   # Returns harsh, then mild
        m_judge = mock_pydantic_llm([verd_reject, verd_approve]) # Returns reject, then approve
        
        # Route calls to specific mocks based on role
        def side_effect(role):
            if role == "proposer": return m_prop
            if role == "red_cell": return m_red
            if role == "judge": return m_judge
        mock_factory.get_model.side_effect = side_effect

        # Run Graph
        graph = build_agora_graph()
        result = await graph.ainvoke({
            "topic": "Test", "iteration_count": 0, "proposals": [], "critiques": [], "verdict": None
        })
        
        # Verify it looped exactly once (2 iterations total)
        assert result["iteration_count"] == 2
        assert result["verdict"]["approved"] is True
