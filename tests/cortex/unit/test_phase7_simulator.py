"""
Phase 7 Unit Tests - The Simulator (Inner Theatre)

Phase 12 Update: Now uses MarkdownPlan instead of ProjectPlan.
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock
from cortex.agents.simulator import simulate_plan, simulator_node
from cortex.schemas.state import (
    System2State, 
    MarkdownPlan,
    SimulationReport
)


@pytest.fixture
def mock_plan():
    """Create a test Markdown plan (Phase 12)."""
    return MarkdownPlan(
        title="Test Deployment Plan",
        content="""# Test Deployment Plan

## Goal
Deploy a web service.

## Steps
### Step 1: Build Docker Image
- **Type**: tool
- **Tool**: build
- **Description**: Build Docker image from Dockerfile

### Step 2: Push to Registry
- **Type**: tool
- **Tool**: push
- **Description**: Push image to container registry

### Step 3: Deploy to Kubernetes
- **Type**: tool
- **Tool**: deploy
- **Description**: Deploy to Kubernetes cluster
""",
        version=1,
        rationale=None
    )


@pytest.fixture
def mock_state(mock_plan):
    """Create a test state with a Markdown plan (Phase 12)."""
    return {
        "messages": [{"content": "Deploy the web service"}],
        "markdown_plan": mock_plan,
        "compiled_plan": None,
        "current_plan": None,
        "votes": [],
        "prior_comments": [],
        "revision_count": 0,
        "simulation_report": None,
        "research_context": None
    }


@pytest.mark.unit
@pytest.mark.asyncio
async def test_simulator_identifies_missing_tools(mock_state):
    """
    Test that the simulator identifies missing tools in a plan.
    """
    # Mock the LLM to return a report with missing tools
    mock_report = SimulationReport(
        failure_modes=["Kubernetes cluster not configured"],
        missing_tools=["kubectl", "docker"],
        risk_level="high",
        recommendation="Install kubectl and docker before proceeding"
    )
    
    with patch("cortex.agents.simulator.llm_factory") as mock_factory:
        mock_model = MagicMock()
        structured_runner = AsyncMock()
        structured_runner.ainvoke.return_value = mock_report
        mock_model.with_structured_output.return_value = structured_runner
        mock_factory.get_model.return_value = mock_model
        
        result = await simulate_plan(mock_state)
        
        assert "simulation_report" in result
        report = result["simulation_report"]
        assert report.risk_level == "high"
        assert "kubectl" in report.missing_tools
        assert "docker" in report.missing_tools


@pytest.mark.unit
@pytest.mark.asyncio
async def test_simulator_flags_high_risk(mock_state):
    """
    Test that the simulator correctly flags high-risk plans.
    """
    mock_report = SimulationReport(
        failure_modes=["Data loss if migration fails", "No rollback plan"],
        missing_tools=[],
        risk_level="high",
        recommendation="Add rollback mechanism before proceeding"
    )
    
    with patch("cortex.agents.simulator.llm_factory") as mock_factory:
        mock_model = MagicMock()
        structured_runner = AsyncMock()
        structured_runner.ainvoke.return_value = mock_report
        mock_model.with_structured_output.return_value = structured_runner
        mock_factory.get_model.return_value = mock_model
        
        result = await simulate_plan(mock_state)
        
        report = result["simulation_report"]
        assert report.risk_level == "high"
        assert len(report.failure_modes) == 2


@pytest.mark.unit
@pytest.mark.asyncio
async def test_simulator_approves_solid_plan(mock_state):
    """
    Test that the simulator approves a solid plan with low risk.
    """
    mock_report = SimulationReport(
        failure_modes=[],
        missing_tools=[],
        risk_level="low",
        recommendation="Proceed"
    )
    
    with patch("cortex.agents.simulator.llm_factory") as mock_factory:
        mock_model = MagicMock()
        structured_runner = AsyncMock()
        structured_runner.ainvoke.return_value = mock_report
        mock_model.with_structured_output.return_value = structured_runner
        mock_factory.get_model.return_value = mock_model
        
        result = await simulate_plan(mock_state)
        
        report = result["simulation_report"]
        assert report.risk_level == "low"
        assert report.recommendation == "Proceed"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_simulator_handles_no_plan():
    """
    Test that the simulator handles missing plan gracefully.
    """
    state = {
        "messages": [],
        "markdown_plan": None,
        "compiled_plan": None,
        "current_plan": None,
        "votes": [],
        "revision_count": 0
    }
    
    result = await simulate_plan(state)
    
    assert result["simulation_report"] is None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_simulator_node_wrapper(mock_state):
    """
    Test the simulator_node wrapper function.
    """
    mock_report = SimulationReport(
        failure_modes=[],
        missing_tools=[],
        risk_level="low",
        recommendation="Proceed"
    )
    
    with patch("cortex.agents.simulator.llm_factory") as mock_factory:
        mock_model = MagicMock()
        structured_runner = AsyncMock()
        structured_runner.ainvoke.return_value = mock_report
        mock_model.with_structured_output.return_value = structured_runner
        mock_factory.get_model.return_value = mock_model
        
        # Use the imported function reference, not the wrapper
        from cortex.agents.simulator import simulate_plan
        result = await simulate_plan(mock_state)
        
        assert "simulation_report" in result
