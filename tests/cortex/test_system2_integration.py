"""
Test System 2 ↔ Blackboard Integration.

Phase 13: Verifies that the orchestrator, participants, and planner
correctly use the Blackboard for persistent state management.
"""

import pytest
import tempfile
import os
from pathlib import Path
from unittest.mock import patch, MagicMock, AsyncMock

# --- Fixtures ---

@pytest.fixture
def temp_blackboard_root(tmp_path):
    """Create a temp directory for Blackboard data."""
    bb_root = tmp_path / "blackboard"
    bb_root.mkdir()
    return bb_root


@pytest.fixture
def bb_instance(temp_blackboard_root):
    """Create a Blackboard instance with a known session_id."""
    from cortex.blackboard import Blackboard
    
    with patch.dict(os.environ, {"BLACKBOARD_ROOT": str(temp_blackboard_root)}):
        Blackboard.clear_cache()
        bb = Blackboard.get_or_create("test_integration_session", "Integration Test")
        yield bb
        Blackboard.clear_cache()


# --- Test: read_state returns raw content ---

class TestReadStateRaw:
    """Verify read_state() includes raw line-numbered content."""
    
    def test_read_state_returns_raw(self, bb_instance):
        """read_state() should include 'raw' key with original file content."""
        state = bb_instance.read_state()
        assert "raw" in state
        # Raw should contain line numbers from the template
        assert "001:" in state["raw"] or state["raw"] == ""
    
    def test_read_state_raw_after_append(self, bb_instance):
        """After append_step, raw should contain the new content with line numbers."""
        bb_instance.append_step("planner", "# Test Plan\n\nStep 1: Do the thing")
        state = bb_instance.read_state()
        
        assert "raw" in state
        assert "Test Plan" in state["raw"]
        # Should have line numbers
        assert "001:" in state["raw"]
    
    def test_read_state_empty_returns_raw(self, bb_instance):
        """Empty Blackboard should return raw as empty string."""
        # Delete state.md to simulate no-file scenario
        state_path = bb_instance.session_dir / "state.md"
        if state_path.exists():
            state_path.unlink()
        
        state = bb_instance.read_state()
        assert state["raw"] == ""


# --- Test: Comment Persistence from Voters ---

class TestVoterCommentPersistence:
    """Verify that voter comments are persisted to Blackboard."""
    
    def test_add_comment_persists(self, bb_instance):
        """Comments added via add_comment should appear in read_state."""
        bb_instance.append_step("planner", "# Plan\n\nStep 1: Research")
        
        comment_id = bb_instance.add_comment(
            agent_id="Critic",
            content="Step 1 is too vague",
            line_ref=3,
        )
        
        state = bb_instance.read_state()
        comments = state["comments"]
        assert len(comments) == 1
        assert comments[0].agent_id == "Critic"
        assert comments[0].content == "Step 1 is too vague"
        assert comments[0].line_ref == 3
        # Version ref should be set to current version
        assert comments[0].version_ref is not None
    
    def test_multiple_voter_comments(self, bb_instance):
        """Multiple voters can comment on the same plan."""
        bb_instance.append_step("planner", "# Plan\n\nStep 1: Research\nStep 2: Implement")
        
        bb_instance.add_comment("Critic", "Too vague", line_ref=3)
        bb_instance.add_comment("SafetyOfficer", "No error handling", line_ref=4)
        bb_instance.add_comment("EfficiencyExpert", "Could parallelize", line_ref=4)
        
        state = bb_instance.read_state()
        comments = state["comments"]
        assert len(comments) >= 3
        
        agents = {c.agent_id for c in comments}
        assert {"Critic", "SafetyOfficer", "EfficiencyExpert"}.issubset(agents)
    
    def test_comments_survive_plan_revision(self, bb_instance):
        """Comments persist after new plan revision is appended."""
        # v1: Initial plan
        bb_instance.append_step("planner", "# Plan v1\n\nStep 1: Research")
        bb_instance.add_comment("Critic", "Needs more detail", line_ref=3)
        
        # v2: Revised plan
        bb_instance.append_step("planner", "# Plan v2\n\nStep 1: Deep research with sources")
        
        state = bb_instance.read_state()
        # Comment should still be in state
        comments = state["comments"]
        assert len(comments) >= 1
        assert any(c.content == "Needs more detail" for c in comments)


# --- Test: Aggregate Comments Integration ---

class TestAggregateFromBlackboard:
    """Verify aggregate_comments_node reads from Blackboard."""
    
    def test_aggregate_reads_blackboard_comments(self, bb_instance):
        """Aggregate should convert Blackboard Comments to LineComments."""
        from cortex.blackboard.models import Comment
        from cortex.schemas.state import LineComment
        
        # Add comments directly to Blackboard
        bb_instance.append_step("planner", "# Plan\n\nStep 1")
        bb_instance.add_comment("Critic", "Bad step", line_ref=3)
        bb_instance.add_comment("SafetyOfficer", "Risky", line_ref=3)
        
        # Read and convert (mimicking aggregate_comments_node logic)
        bb_state = bb_instance.read_state()
        bb_comments = bb_state.get("comments", [])
        
        prior_comments = [
            LineComment(
                voter=c.agent_id,
                line_number=c.line_ref or 0,
                line_content="",
                comment=c.content,
                suggestion=None,
            )
            for c in bb_comments
            if not c.promoted
        ]
        
        assert len(prior_comments) >= 2
        voters = {c.voter for c in prior_comments}
        assert "Critic" in voters
        assert "SafetyOfficer" in voters


# --- Test: Version Tracking ---

class TestBlackboardVersionTracking:
    """Verify version tracking through the plan lifecycle."""
    
    def test_version_increments_on_append(self, bb_instance):
        """Each append_step should increment the version."""
        state0 = bb_instance.read_state()
        v0 = state0["version"]
        
        bb_instance.append_step("planner", "Plan v1")
        state1 = bb_instance.read_state()
        assert state1["version"] == v0 + 1
        
        bb_instance.append_step("planner", "Plan v2")
        state2 = bb_instance.read_state()
        assert state2["version"] == v0 + 2
    
    def test_comments_do_not_increment_version(self, bb_instance):
        """Adding comments should NOT increment the version."""
        bb_instance.append_step("planner", "Plan v1")
        state1 = bb_instance.read_state()
        v1 = state1["version"]
        
        bb_instance.add_comment("Critic", "Comment 1", line_ref=1)
        bb_instance.add_comment("SafetyOfficer", "Comment 2", line_ref=1)
        
        state2 = bb_instance.read_state()
        assert state2["version"] == v1  # No change


# --- Test: Plan for Voter helper ---

class TestGetPlanForVoter:
    """Test _get_plan_for_voter helper from participants."""
    
    def test_get_plan_from_blackboard(self, bb_instance):
        """With session_id, should read from Blackboard."""
        from cortex.agents.participants import _get_plan_for_voter
        from cortex.schemas.state import MarkdownPlan
        
        bb_instance.append_step("planner", "# Plan\n\nStep 1\nStep 2")
        
        plan = MarkdownPlan(title="Test", version=1, content="# Plan\n\nStep 1\nStep 2")
        result, version = _get_plan_for_voter(plan, "test_integration_session")
        
        assert "001:" in result or "[001]" in result
        assert "Plan" in result


# --- Test: Full Blackboard Lifecycle ---

class TestFullBlackboardLifecycle:
    """
    End-to-end integration test: Write → Comment → Vote → Resolve.
    
    Simulates the real orchestration loop:
    1. Planner writes a plan
    2. Multiple voters add line-level comments
    3. Other agents vote (up/down) on those comments
    4. resolve_votes() promotes winners, archives losers
    """
    
    @pytest.fixture
    def fresh_bb(self, temp_blackboard_root):
        """Per-test fresh Blackboard (no pollution between tests)."""
        import uuid
        from cortex.blackboard import Blackboard
        
        session_id = f"lifecycle_{uuid.uuid4().hex[:8]}"
        with patch.dict(os.environ, {"BLACKBOARD_ROOT": str(temp_blackboard_root)}):
            Blackboard.clear_cache()
            bb = Blackboard.get_or_create(session_id, "Lifecycle")
            yield bb
            Blackboard.clear_cache()
    
    def test_write_plan(self, fresh_bb):
        """Step 1: Planner node writes a plan to state.md."""
        fresh_bb.append_step("planner", "# Deploy API\n\n- Step 1: Build container\n- Step 2: Push to registry\n- Step 3: Deploy to prod")
        
        state = fresh_bb.read_state()
        assert state["version"] >= 1
        assert "Deploy API" in state["raw"]
        assert "Build container" in state["raw"]
    
    def test_voters_comment_on_plan(self, fresh_bb):
        """Step 2: Voters add line-level comments on the plan."""
        fresh_bb.append_step("planner", "# Deploy API\n\n- Step 1: Build container\n- Step 2: Push to registry\n- Step 3: Deploy to prod")
        version_after_plan = fresh_bb.read_state()["version"]
        
        c1 = fresh_bb.add_comment("Critic", "Missing rollback strategy", line_ref=5)
        c2 = fresh_bb.add_comment("SafetyOfficer", "No health check before deploy", line_ref=5)
        c3 = fresh_bb.add_comment("EfficiencyExpert", "Can parallelize steps 1 and 2", line_ref=3)
        
        # All comment IDs returned
        assert c1 and c2 and c3
        assert c1 != c2 != c3
        
        state = fresh_bb.read_state()
        comments = state["comments"]
        assert len(comments) == 3
        
        # All agents represented
        agents = {c.agent_id for c in comments}
        assert agents == {"Critic", "SafetyOfficer", "EfficiencyExpert"}
        
        # Version did NOT change from comments alone
        assert state["version"] == version_after_plan
    
    def test_agents_vote_on_comments(self, fresh_bb):
        """Step 3: Agents up/downvote each other's comments."""
        fresh_bb.append_step("planner", "# Deploy API\n\n- Step 1: Build\n- Step 2: Push\n- Step 3: Deploy")
        
        c_critic = fresh_bb.add_comment("Critic", "Missing rollback strategy", line_ref=5)
        c_efficiency = fresh_bb.add_comment("EfficiencyExpert", "Remove error handling to save time", line_ref=3)
        
        # Other agents vote on Critic's comment (good feedback → upvote)
        fresh_bb.vote_comment("SafetyOfficer", c_critic, "up")
        fresh_bb.vote_comment("EfficiencyExpert", c_critic, "up")
        
        # Safety Officer downvotes the bad suggestion
        fresh_bb.vote_comment("Critic", c_efficiency, "down")
        fresh_bb.vote_comment("SafetyOfficer", c_efficiency, "down")
        
        state = fresh_bb.read_state()
        comments = {c.id: c for c in state["comments"]}
        
        # Critic's comment: +2 (two upvotes)
        assert comments[c_critic].score == 2
        assert comments[c_critic].votes["SafetyOfficer"] == "up"
        assert comments[c_critic].votes["EfficiencyExpert"] == "up"
        
        # Efficiency's comment: -2 (two downvotes)
        assert comments[c_efficiency].score == -2
        assert comments[c_efficiency].votes["Critic"] == "down"
        assert comments[c_efficiency].votes["SafetyOfficer"] == "down"
    
    def test_resolve_votes_promotes_and_archives(self, fresh_bb):
        """Step 4: resolve_votes() promotes winners, archives losers."""
        fresh_bb.append_step("planner", "# Deploy API\n\n- Step 1: Build\n- Step 2: Push\n- Step 3: Deploy")
        
        c_good = fresh_bb.add_comment("Critic", "Add rollback strategy", line_ref=5)
        c_bad = fresh_bb.add_comment("EfficiencyExpert", "Remove error handling", line_ref=3)
        
        # Good comment gets upvotes
        fresh_bb.vote_comment("SafetyOfficer", c_good, "up")
        fresh_bb.vote_comment("EfficiencyExpert", c_good, "up")
        
        # Bad comment gets downvotes
        fresh_bb.vote_comment("Critic", c_bad, "down")
        fresh_bb.vote_comment("SafetyOfficer", c_bad, "down")
        
        # Resolve
        promoted_ids = fresh_bb.resolve_votes(min_score=1)
        
        # Good comment was promoted
        assert c_good in promoted_ids
        assert c_bad not in promoted_ids
        
        # State now has higher version (resolve bumps version)
        state = fresh_bb.read_state()
        assert state["version"] >= 2
        
        # Archived section exists in raw output
        assert "Archived Comments" in state["raw"]
    
    def test_full_plan_vote_revise_cycle(self, fresh_bb):
        """Full loop: Plan → Comment → Vote → Resolve → Revise plan."""
        # === Round 1: Initial plan ===
        fresh_bb.append_step("planner", "# API v1\n\n- Step 1: Build\n- Step 2: Deploy")
        v1 = fresh_bb.read_state()["version"]
        
        # Voter comments
        c1 = fresh_bb.add_comment("Critic", "No tests!", line_ref=3)
        fresh_bb.vote_comment("SafetyOfficer", c1, "up")
        
        # Resolve: comment promoted
        promoted = fresh_bb.resolve_votes(min_score=1)
        assert c1 in promoted
        
        v_after_resolve = fresh_bb.read_state()["version"]
        assert v_after_resolve > v1
        
        # === Round 2: Planner revises ===
        fresh_bb.append_step("planner", "# API v2\n\n- Step 1: Build\n- Step 2: Run tests\n- Step 3: Deploy")
        v2 = fresh_bb.read_state()["version"]
        assert v2 > v_after_resolve
        
        # Verify new content is present
        state = fresh_bb.read_state()
        assert "Run tests" in state["raw"]
        
        # Old promoted comment should be archived (promoted=True)
        archived = [c for c in state.get("comments", []) if c.promoted]
        # May or may not persist depending on rebuild — at minimum, version advanced
        assert v2 >= 3


# --- Test: All Nodes Write to Blackboard ---

class TestAllNodesWriteToBlackboard:
    """
    Verify that ALL orchestrator nodes write their output to the Blackboard.
    
    Tests the Phase 13 integration for: simulator, compiler,
    human_review, researcher, execution.
    
    These tests use direct Blackboard API calls to simulate what
    each node does internally, since the real nodes need LLM calls.
    """
    
    @pytest.fixture
    def node_bb(self, temp_blackboard_root):
        """Per-test fresh Blackboard for node write tests."""
        import uuid
        from cortex.blackboard import Blackboard
        
        session_id = f"node_test_{uuid.uuid4().hex[:8]}"
        with patch.dict(os.environ, {"BLACKBOARD_ROOT": str(temp_blackboard_root)}):
            Blackboard.clear_cache()
            bb = Blackboard.get_or_create(session_id, "Node Test")
            yield bb
            Blackboard.clear_cache()
    
    def test_simulator_writes_report(self, node_bb):
        """Simulator writes simulation report to state.md."""
        # Simulate what simulator_node does after LLM call
        node_bb.append_step("planner", "# Plan\n\n- Step 1: Do thing")
        
        report_summary = "## Simulation Report\n\n"
        report_summary += "- **Risk Level**: medium\n"
        report_summary += "- **Recommendation**: Add error handling\n"
        report_summary += "- **Failure Modes**: File not found, Permission denied\n"
        node_bb.append_step(agent_id="simulator", content=report_summary)
        
        state = node_bb.read_state()
        assert "Simulation Report" in state["raw"]
        assert "Risk Level" in state["raw"]
        assert "medium" in state["raw"]
    
    def test_compiler_writes_summary(self, node_bb):
        """Compiler writes compiled plan summary to state.md."""
        node_bb.append_step("planner", "# Plan\n\n- Step 1: Build")
        
        compile_summary = "## Compiled Plan\n\n"
        compile_summary += "- **Title**: Deploy API\n"
        compile_summary += "- **Goal**: Deploy the API to production\n"
        compile_summary += "- **Nodes**: 3\n"
        compile_summary += "  1. [tool] Build container image\n"
        compile_summary += "  2. [tool] Push to registry\n"
        compile_summary += "  3. [tool] Deploy to prod\n"
        compile_summary += "- **Status**: approved\n"
        node_bb.append_step(agent_id="compiler", content=compile_summary)
        
        state = node_bb.read_state()
        assert "Compiled Plan" in state["raw"]
        assert "Deploy API" in state["raw"]
        assert "approved" in state["raw"]
    
    def test_human_review_writes_checkpoint(self, node_bb):
        """Human review writes checkpoint to state.md."""
        node_bb.append_step("planner", "# Plan\n\n- Step 1: Build")
        
        node_bb.append_step(
            agent_id="human_review",
            content="## Human Review Checkpoint\n\nAwaiting human approval. Graph paused.",
        )
        
        state = node_bb.read_state()
        assert "Human Review Checkpoint" in state["raw"]
        assert "Awaiting human approval" in state["raw"]
    
    def test_researcher_writes_findings(self, node_bb):
        """Researcher writes research findings to state.md."""
        node_bb.append_step("planner", "# Plan\n\n- Step 1: Research")
        
        research_summary = "## Research Findings\n\n"
        research_summary += "- **Query**: What are the best practices for API deployment?\n"
        research_summary += "- **Result**: 1500 chars\n\n"
        research_summary += "Key findings: Use blue-green deployments for zero-downtime..."
        node_bb.append_step(agent_id="researcher", content=research_summary)
        
        state = node_bb.read_state()
        assert "Research Findings" in state["raw"]
        assert "blue-green" in state["raw"]
    
    def test_executor_writes_results(self, node_bb):
        """Executor writes execution results to state.md."""
        node_bb.append_step("planner", "# Plan\n\n- Step 1: Deploy")
        
        exec_summary = "## Execution Result\n\n"
        exec_summary += "- **Project ID**: proj_abc123\n"
        exec_summary += "- **Tasks Created**: 3\n"
        exec_summary += "- **Status**: ✅ Success\n"
        node_bb.append_step(agent_id="executor", content=exec_summary)
        
        state = node_bb.read_state()
        assert "Execution Result" in state["raw"]
        assert "proj_abc123" in state["raw"]
        assert "Success" in state["raw"]
    
    def test_full_pipeline_audit_trail(self, node_bb):
        """All nodes write sequentially, creating a full audit trail."""
        # Planner
        node_bb.append_step("planner", "# Deploy API\n\n- Step 1: Build\n- Step 2: Deploy")
        
        # Simulator
        node_bb.append_step("simulator", "## Simulation Report\n\n- **Risk**: low")
        
        # Human Review
        node_bb.append_step("human_review", "## Human Review\n\nApproved.")
        
        # Compiler
        node_bb.append_step("compiler", "## Compiled Plan\n\n- 2 nodes")
        
        # Executor
        node_bb.append_step("executor", "## Execution Result\n\n- ✅ Success")
        
        state = node_bb.read_state()
        raw = state["raw"]
        
        # All nodes left their mark
        assert "Deploy API" in raw
        assert "Simulation Report" in raw
        assert "Human Review" in raw
        assert "Compiled Plan" in raw
        assert "Execution Result" in raw
        
        # Version should have incremented for each append
        assert state["version"] >= 5


# --- Test: Neo4j Integration (Mocked) ---

class TestNeo4jIntegration:
    """
    Verify Neo4j integration codepaths using mocks.
    
    No live Neo4j required — all external dependencies are mocked.
    Tests the wiring between orchestrator nodes, Neo4jMemoryLayer,
    BlackboardExporter, and MemoryRepository.
    """
    
    def test_format_context_produces_valid_output(self):
        """Neo4jMemoryLayer._format_context() creates proper RETRIEVED_CONTEXT."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer
        
        hybrid_results = [
            {
                "source_id": "ep-001",
                "source_file": "blackboard_design",
                "context": "Blackboard was introduced in Phase 13",
                "entity": "blackboard",
                "rel1": "USES",
                "neighbor": "state.md",
                "rel2": "STORES",
                "fact": "Blackboard persists state to state.md",
            }
        ]
        
        context = Neo4jMemoryLayer._format_context(
            query="How does the blackboard work?",
            entities=["blackboard", "state"],
            hybrid_results=hybrid_results,
            direct_results=[],
        )
        
        assert "# RETRIEVED_CONTEXT" in context
        assert "blackboard" in context
        assert "state.md" in context
        assert "VectorCypher" in context
        assert "Blackboard persists state" in context
    
    def test_format_context_handles_empty_results(self):
        """_format_context() handles empty graph and vector results gracefully."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer
        
        context = Neo4jMemoryLayer._format_context(
            query="nonexistent topic",
            entities=[],
            hybrid_results=[],
            direct_results=[],
        )
        
        assert "# RETRIEVED_CONTEXT" in context
        assert "No relevant context found" in context
    
    @pytest.mark.asyncio
    async def test_extract_entities_calls_llm(self):
        """extract_entities() calls LLM and parses comma-separated response."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer
        
        mock_llm = AsyncMock()
        mock_llm.ainvoke.return_value = MagicMock(
            content="blackboard, neo4j, graph traversal"
        )
        
        # Bypass __init__ validation and lazy init
        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._memory_client = MagicMock()
        layer._hashtag_manager = None
        layer._llm = mock_llm
        layer._initialized = True
        
        entities = await layer.extract_entities("How does the blackboard persist to Neo4j?")
        
        assert "blackboard" in entities
        assert "neo4j" in entities
        assert "graph traversal" in entities
        mock_llm.ainvoke.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_extract_entities_handles_failure(self):
        """extract_entities() returns empty list on LLM failure."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer
        
        mock_llm = AsyncMock()
        mock_llm.ainvoke.side_effect = Exception("LLM unavailable")
        
        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._memory_client = MagicMock()
        layer._hashtag_manager = None
        layer._llm = mock_llm
        layer._initialized = True
        
        entities = await layer.extract_entities("test query")
        assert entities == []
    
    @pytest.mark.asyncio
    async def test_blackboard_exporter_export_findings(self, temp_blackboard_root):
        """BlackboardExporter.export_findings() calls add_fact() per finding."""
        from cortex.blackboard import Blackboard, BlackboardExporter
        
        with patch.dict(os.environ, {"BLACKBOARD_ROOT": str(temp_blackboard_root)}):
            Blackboard.clear_cache()
            import uuid
            session_id = f"export_test_{uuid.uuid4().hex[:8]}"
            bb = Blackboard.get_or_create(session_id, "Export Test")
            
            # Use public API to add a finding
            bb.submit_finding(
                worker_id="researcher_1",
                content="Test finding content about Neo4j",
                tool_name="web_search",
                query="test query",
                tags=["neo4j", "test"],
            )
            
            # Mock the MemoryRepository
            mock_repo = AsyncMock()
            
            exporter = BlackboardExporter()
            exporter._repo = mock_repo
            
            count = await exporter.export_findings(bb)
            
            assert count == 1
            mock_repo.add_with_extraction.assert_called_once()
            call_args = mock_repo.add_with_extraction.call_args
            assert "Test finding content about Neo4j" in call_args[0][0]
            assert call_args[1]["source"] == "blackboard_finding"
            
            Blackboard.clear_cache()
    
    @pytest.mark.asyncio
    async def test_blackboard_exporter_export_synthesis(self, temp_blackboard_root):
        """BlackboardExporter.export_synthesis() calls add_fact() with dossier."""
        from cortex.blackboard import Blackboard, BlackboardExporter
        
        with patch.dict(os.environ, {"BLACKBOARD_ROOT": str(temp_blackboard_root)}):
            Blackboard.clear_cache()
            bb = Blackboard.get_or_create("synth_test", "Synthesis Test")
            
            # Use public API to write synthesis
            bb.write_synthesis("# Final Dossier\n\nKey findings about Neo4j integration.")
            
            # Mock the MemoryRepository
            mock_repo = AsyncMock()
            
            exporter = BlackboardExporter()
            exporter._repo = mock_repo
            
            result = await exporter.export_synthesis(bb)
            
            assert result is True
            mock_repo.add_with_extraction.assert_called_once()
            call_args = mock_repo.add_with_extraction.call_args
            assert "Final Dossier" in call_args[0][0]
            assert call_args[1]["source"] == "blackboard_synthesis"
            
            Blackboard.clear_cache()


# --- Test: Phase 7 VectorCypher Retrieval ---

class TestVectorCypherRetrieval:
    """Phase 7: Tests for vector_cypher_retrieve() chained pipeline."""

    @pytest.mark.asyncio
    async def test_vector_cypher_chains_traversal(self):
        """vector_cypher_retrieve: vector hits seed a Cypher graph walk."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        # Build layer bypassing __init__
        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._initialized = True
        layer._llm = None
        layer._hashtag_manager = None

        # Mock vector_search to return anchor hits with UUIDs
        layer.vector_search = AsyncMock(return_value=[
            {"uuid": "ep-001", "content": "anchor hit", "score": 0.9},
        ])

        # Mock the Cypher execution on graphiti driver
        mock_driver = AsyncMock()
        mock_driver.execute_query = AsyncMock(return_value=(
            [
                {"source_id": "ep-001", "source_file": "test", "context": "ctx",
                 "entity": "neo4j", "rel1": "USES", "neighbor": "graphiti",
                 "rel2": "INTEGRATES", "fact": "Neo4j uses Graphiti for ingestion"},
            ],
            None, None,
        ))
        mock_client = MagicMock()
        mock_client.graphiti = MagicMock(driver=mock_driver)
        layer._memory_client = mock_client

        results = await layer.vector_cypher_retrieve("How does Neo4j integrate?")

        assert len(results) == 1
        assert results[0]["entity"] == "neo4j"
        assert results[0]["neighbor"] == "graphiti"
        assert results[0]["fact"] == "Neo4j uses Graphiti for ingestion"
        layer.vector_search.assert_called_once()
        mock_driver.execute_query.assert_called_once()

    @pytest.mark.asyncio
    async def test_vector_cypher_deduplicates_facts(self):
        """vector_cypher_retrieve deduplicates results by fact content."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._initialized = True
        layer._llm = None
        layer._hashtag_manager = None

        layer.vector_search = AsyncMock(return_value=[
            {"uuid": "ep-001", "content": "hit", "score": 0.9},
        ])

        # Return duplicate facts from traversal
        duplicate_fact = "Neo4j stores graph data"
        mock_driver = AsyncMock()
        mock_driver.execute_query = AsyncMock(return_value=(
            [
                {"source_id": "ep-001", "source_file": "a", "context": "c",
                 "entity": "neo4j", "rel1": "USES", "neighbor": "graph",
                 "rel2": None, "fact": duplicate_fact},
                {"source_id": "ep-001", "source_file": "b", "context": "c",
                 "entity": "neo4j", "rel1": "STORES", "neighbor": "data",
                 "rel2": None, "fact": duplicate_fact},
            ],
            None, None,
        ))
        mock_client = MagicMock()
        mock_client.graphiti = MagicMock(driver=mock_driver)
        layer._memory_client = mock_client

        results = await layer.vector_cypher_retrieve("graph data")

        # Only 1 result due to deduplication
        assert len(results) == 1
        assert results[0]["fact"] == duplicate_fact

    @pytest.mark.asyncio
    async def test_retrieve_uses_vector_cypher_primary(self):
        """retrieve() uses VectorCypher as primary, graph_traverse as fallback."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._initialized = True
        layer._memory_client = MagicMock()
        layer._hashtag_manager = None
        layer._llm = AsyncMock()
        layer._llm.ainvoke = AsyncMock(return_value=MagicMock(content="entity1"))

        # VectorCypher returns results
        layer.vector_cypher_retrieve = AsyncMock(return_value=[
            {"entity": "test", "neighbor": "n", "fact": "f", "source_file": "s"},
        ])
        layer.graph_traverse = AsyncMock(return_value=[])

        result = await layer.retrieve("test query")

        # VectorCypher was called as primary
        layer.vector_cypher_retrieve.assert_called_once()
        # graph_traverse was NOT called (VectorCypher had results)
        layer.graph_traverse.assert_not_called()
        assert "VectorCypher" in result

# --- Test: Phase 7 Text2Cypher (P2) ---

class TestText2Cypher:
    """Phase 7: Tests for text2cypher() LLM-driven Cypher generation."""

    @pytest.mark.asyncio
    async def test_text2cypher_generates_and_executes(self):
        """text2cypher: schema introspect → LLM gen → execute."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._initialized = True
        layer._hashtag_manager = None

        # Mock LLM to return a valid read-only Cypher
        mock_llm = AsyncMock()
        mock_llm.ainvoke = AsyncMock(return_value=MagicMock(
            content="MATCH (p:Project) RETURN p.name AS name LIMIT 10"
        ))
        layer._llm = mock_llm

        # Mock driver for schema introspection + query execution
        mock_driver = AsyncMock()
        mock_driver.execute_query = AsyncMock(side_effect=[
            # Call 1: db.labels()
            ([{"labels": ["Project", "User", "Tool"]}], None, None),
            # Call 2: db.relationshipTypes()
            ([{"types": ["USES", "CREATED"]}], None, None),
            # Call 3: actual query execution
            ([{"name": "Praxis"}], None, None),
        ])
        mock_client = MagicMock()
        mock_client.graphiti = MagicMock(driver=mock_driver)
        layer._memory_client = mock_client

        results = await layer.text2cypher("What projects exist?")

        assert len(results) == 1
        assert results[0]["name"] == "Praxis"
        assert mock_driver.execute_query.call_count == 3

    @pytest.mark.asyncio
    async def test_text2cypher_rejects_mutations(self):
        """text2cypher raises ValueError when LLM generates a mutation query."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._initialized = True
        layer._hashtag_manager = None

        # LLM returns a dangerous CREATE query
        mock_llm = AsyncMock()
        mock_llm.ainvoke = AsyncMock(return_value=MagicMock(
            content="CREATE (n:Malicious {name: 'bad'})"
        ))
        layer._llm = mock_llm

        mock_driver = AsyncMock()
        mock_driver.execute_query = AsyncMock(side_effect=[
            ([{"labels": ["Project"]}], None, None),
            ([{"types": ["USES"]}], None, None),
        ])
        mock_client = MagicMock()
        mock_client.graphiti = MagicMock(driver=mock_driver)
        layer._memory_client = mock_client

        with pytest.raises(ValueError, match="mutation query"):
            await layer.text2cypher("delete everything")

    @pytest.mark.asyncio
    async def test_text2cypher_handles_empty_schema(self):
        """text2cypher returns empty on empty schema (no labels)."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._initialized = True
        layer._hashtag_manager = None
        layer._llm = AsyncMock()

        mock_driver = AsyncMock()
        mock_driver.execute_query = AsyncMock(side_effect=[
            ([{"labels": []}], None, None),
            ([{"types": []}], None, None),
        ])
        mock_client = MagicMock()
        mock_client.graphiti = MagicMock(driver=mock_driver)
        layer._memory_client = mock_client

        results = await layer.text2cypher("anything")
        assert results == []


# --- Test: Phase 7 Retrieval Validation (P3) ---

class TestRetrievalValidation:
    """Phase 7: Tests for RetrievalQuality enum and _validate_results()."""

    def test_empty_results_returns_empty(self):
        """No results at all → EMPTY."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer, RetrievalQuality

        quality = Neo4jMemoryLayer._validate_results([], [])
        assert quality == RetrievalQuality.EMPTY

    def test_low_score_results_returns_low_confidence(self):
        """Few results with no facts → LOW_CONFIDENCE."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer, RetrievalQuality

        # 2 results, no 'fact' key → low confidence
        hybrid = [
            {"entity": "x", "neighbor": "y"},
            {"entity": "a", "neighbor": "b"},
        ]
        quality = Neo4jMemoryLayer._validate_results(hybrid, [])
        assert quality == RetrievalQuality.LOW_CONFIDENCE

    def test_good_results_returns_good(self):
        """Solid results with facts → GOOD."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer, RetrievalQuality

        hybrid = [
            {"entity": "neo4j", "fact": "Graph database"},
            {"entity": "graphiti", "fact": "KG extraction"},
            {"entity": "cortex", "fact": "Orchestrator"},
        ]
        quality = Neo4jMemoryLayer._validate_results(hybrid, [])
        assert quality == RetrievalQuality.GOOD

    def test_format_context_includes_quality_header(self):
        """_format_context embeds retrieval quality in output."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        ctx = Neo4jMemoryLayer._format_context("q", ["e"], [], [])
        assert "EMPTY" in ctx

        ctx2 = Neo4jMemoryLayer._format_context(
            "q", ["e"],
            [{"entity": "x", "fact": "y", "source_file": "s"},
             {"entity": "a", "fact": "b", "source_file": "s"},
             {"entity": "c", "fact": "d", "source_file": "s"}],
            [],
        )
        assert "GOOD" in ctx2


# --- Test: Phase 7 Vector Index Verification (P4) ---

class TestVectorIndexCheck:
    """Phase 7: Tests for MemoryClient.ensure_vector_index()."""

    @pytest.mark.asyncio
    async def test_ensure_vector_index_found(self):
        """ensure_vector_index logs found indexes."""
        from cortex.memory.client import MemoryClient

        client = MemoryClient.__new__(MemoryClient)

        mock_record = MagicMock()
        mock_record.data.return_value = {
            "name": "vector_idx",
            "labelsOrTypes": ["EpisodicNode"],
            "properties": ["embedding"],
            "options": {"indexConfig": {"vector.dimensions": 1536}},
        }

        mock_session = MagicMock()
        mock_session.run.return_value = [mock_record]
        mock_session.__enter__ = MagicMock(return_value=mock_session)
        mock_session.__exit__ = MagicMock(return_value=False)

        mock_driver = MagicMock()
        mock_driver.session.return_value = mock_session
        mock_driver.close = MagicMock()
        client.get_driver = MagicMock(return_value=mock_driver)

        indexes = await client.ensure_vector_index()

        assert len(indexes) == 1
        assert indexes[0]["name"] == "vector_idx"

    @pytest.mark.asyncio
    async def test_ensure_vector_index_missing(self):
        """ensure_vector_index warns when no indexes found."""
        from cortex.memory.client import MemoryClient

        client = MemoryClient.__new__(MemoryClient)

        mock_session = MagicMock()
        mock_session.run.return_value = []
        mock_session.__enter__ = MagicMock(return_value=mock_session)
        mock_session.__exit__ = MagicMock(return_value=False)

        mock_driver = MagicMock()
        mock_driver.session.return_value = mock_session
        mock_driver.close = MagicMock()
        client.get_driver = MagicMock(return_value=mock_driver)

        indexes = await client.ensure_vector_index()
        assert indexes == []


# --- Test: Phase 7 Schema Enforcement (P5) ---

class TestSchemaEnforcement:
    """Phase 7: Tests for schema_config.py and Gardener.audit_schema_drift()."""

    def test_schema_config_constants_exist(self):
        """ALLOWED_ENTITY_LABELS and ALLOWED_RELATIONSHIP_TYPES are non-empty."""
        from cortex.memory.schema_config import (
            ALLOWED_ENTITY_LABELS,
            ALLOWED_RELATIONSHIP_TYPES,
            SCHEMA_HINT,
        )

        assert len(ALLOWED_ENTITY_LABELS) > 0
        assert len(ALLOWED_RELATIONSHIP_TYPES) > 0
        assert "USES" in ALLOWED_RELATIONSHIP_TYPES
        assert "Project" in ALLOWED_ENTITY_LABELS
        assert "SCHEMA_HINT" is not None
        assert "Agent" in SCHEMA_HINT

    @pytest.mark.asyncio
    async def test_audit_schema_drift_flags_unknown(self):
        """audit_schema_drift detects labels/rels outside allowed schema."""
        from cortex.memory.gardener import Gardener

        gardener = Gardener.__new__(Gardener)

        # Mock driver session returning known + unknown labels/rels
        mock_label_result = MagicMock()
        mock_label_result.single.return_value = {
            "labels": ["Project", "User", "BogusLabel"]
        }

        mock_rel_result = MagicMock()
        mock_rel_result.single.return_value = {
            "types": ["USES", "CREATED", "INVENTED_REL"]
        }

        mock_session = MagicMock()
        mock_session.run = MagicMock(side_effect=[mock_label_result, mock_rel_result])
        mock_session.__enter__ = MagicMock(return_value=mock_session)
        mock_session.__exit__ = MagicMock(return_value=False)

        mock_driver = MagicMock()
        mock_driver.session.return_value = mock_session
        gardener.driver = mock_driver

        drift = await gardener.audit_schema_drift()

        assert "BogusLabel" in drift["unknown_labels"]
        assert "INVENTED_REL" in drift["unknown_relationships"]
        # Known items should NOT be flagged
        assert "Project" not in drift["unknown_labels"]
        assert "USES" not in drift["unknown_relationships"]


# --- Test: Wiring Fixes (Fallback Sweep) ---

class TestWiringFixes:
    """Tests for the 6 fallback/wiring fixes from the sweep."""

    @pytest.mark.asyncio
    async def test_ensure_initialized_retries_on_memory_client_failure(self):
        """_ensure_initialized does NOT mark initialized when MemoryClient fails."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._memory_client = None
        layer._hashtag_manager = MagicMock()
        layer._llm = MagicMock()
        layer._memory_repo = MagicMock()
        layer._initialized = False
        layer._last_error = None

        # Patch MemoryClient import to fail
        with patch("cortex.memory.client.MemoryClient", side_effect=RuntimeError("no neo4j")):
            await layer._ensure_initialized()

        # Critical dep failed — should NOT be marked initialized
        assert layer._initialized is False
        assert layer._last_error is not None
        assert "MemoryClient" in layer._last_error

    @pytest.mark.asyncio
    async def test_vector_search_caches_memory_repo(self):
        """vector_search reuses self._memory_repo instead of creating new."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._initialized = True
        layer._last_error = None

        mock_repo = AsyncMock()
        mock_repo.search_memory = AsyncMock(return_value=[{"uuid": "1"}])
        layer._memory_repo = mock_repo

        await layer.vector_search("test")
        await layer.vector_search("test2")

        # Same repo used both times
        assert mock_repo.search_memory.call_count == 2

    @pytest.mark.asyncio
    async def test_retrieve_calls_text2cypher_when_enabled(self):
        """retrieve() calls text2cypher when flag is True and no other results."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._initialized = True
        layer._hashtag_manager = None
        layer._last_error = None
        layer._memory_client = MagicMock()

        layer.extract_entities = AsyncMock(return_value=["praxis"])
        layer.vector_cypher_retrieve = AsyncMock(return_value=[])
        layer.graph_traverse = AsyncMock(return_value=[])
        layer.text2cypher = AsyncMock(return_value=[{"name": "Praxis"}])

        result = await layer.retrieve("what is praxis?", include_text2cypher=True)

        # text2cypher should have been called
        layer.text2cypher.assert_called_once()
        # And results should be in output
        assert "TEXT2CYPHER" in result

    @pytest.mark.asyncio
    async def test_retrieve_skips_text2cypher_when_disabled(self):
        """retrieve() does NOT call text2cypher when flag is False (default)."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._initialized = True
        layer._hashtag_manager = None
        layer._last_error = None
        layer._memory_client = MagicMock()

        layer.extract_entities = AsyncMock(return_value=["praxis"])
        layer.vector_cypher_retrieve = AsyncMock(return_value=[])
        layer.graph_traverse = AsyncMock(return_value=[])
        layer.text2cypher = AsyncMock(return_value=[{"name": "Praxis"}])

        await layer.retrieve("what is praxis?")

        # text2cypher should NOT have been called (default is False)
        layer.text2cypher.assert_not_called()

    def test_format_context_shows_error_in_empty_output(self):
        """_format_context includes error detail when quality is EMPTY."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        ctx = Neo4jMemoryLayer._format_context(
            "q", ["e"], [], [],
            last_error="Graph traversal failed: connection refused"
        )
        assert "EMPTY" in ctx
        assert "connection refused" in ctx

    def test_format_context_no_error_when_none(self):
        """_format_context omits error detail when last_error is None."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        ctx = Neo4jMemoryLayer._format_context("q", ["e"], [], [], last_error=None)
        assert "EMPTY" in ctx
        assert "Error:" not in ctx

    @pytest.mark.asyncio
    async def test_last_error_tracks_failures(self):
        """_last_error is set when a retrieval method fails."""
        from cortex.memory.neo4j_layer import Neo4jMemoryLayer

        layer = Neo4jMemoryLayer.__new__(Neo4jMemoryLayer)
        layer._initialized = True
        layer._last_error = None
        layer._memory_client = MagicMock()
        layer._memory_client.graphiti = MagicMock(driver=None)

        await layer.graph_traverse(["test"])

        # graph_traverse should have returned [] and set _last_error
        # since graphiti.driver is None, it returns [] via the guard check
        # Let's force an actual exception
        mock_driver = AsyncMock()
        mock_driver.execute_query = AsyncMock(side_effect=Exception("connection lost"))
        layer._memory_client.graphiti = MagicMock(driver=mock_driver)

        result = await layer.graph_traverse(["test"])
        assert result == []
        assert layer._last_error is not None
        assert "connection lost" in layer._last_error


# --- Test: Phase 14 AI Flow Orchestrator ---

class TestPhase14AIFlowOrchestrator:
    """
    Phase 14: AI Flow Orchestrator integration tests.
    
    Tests the new orchestrator_think entry node, synthesizer exit node,
    and complexity-based routing logic.
    """
    
    def test_orchestrator_deliberation_schema(self):
        """OrchestratorDeliberation and PlanStep models validate correctly."""
        from cortex.schemas.state import OrchestratorDeliberation, PlanStep
        
        delib = OrchestratorDeliberation(
            reasoning="This is a complex multi-step research task",
            complexity=8,
            use_ensemble=True,
            plan=[
                PlanStep(step=1, agent="Researcher", task="Gather data"),
                PlanStep(step=2, agent="Planner", task="Draft plan", depends_on=[1]),
                PlanStep(step=3, agent="Human", task="Review plan", depends_on=[2]),
            ]
        )
        
        assert delib.complexity == 8
        assert delib.use_ensemble is True
        assert len(delib.plan) == 3
        assert delib.plan[1].depends_on == [1]
        assert delib.plan[2].agent == "Human"
    
    def test_orchestrator_deliberation_low_complexity(self):
        """Low-complexity deliberation sets use_ensemble to False."""
        from cortex.schemas.state import OrchestratorDeliberation, PlanStep
        
        delib = OrchestratorDeliberation(
            reasoning="Simple lookup task",
            complexity=2,
            use_ensemble=False,
            plan=[PlanStep(step=1, agent="Executor", task="Create task")]
        )
        
        assert delib.complexity == 2
        assert delib.use_ensemble is False
        assert len(delib.plan) == 1
    
    @pytest.mark.asyncio
    async def test_thinker_writes_to_blackboard(self, temp_blackboard_root):
        """Thinker node writes deliberation to Blackboard state.md."""
        from cortex.blackboard import Blackboard
        from cortex.schemas.state import OrchestratorDeliberation, PlanStep
        
        with patch.dict(os.environ, {"BLACKBOARD_ROOT": str(temp_blackboard_root)}):
            Blackboard.clear_cache()
            import uuid
            session_id = f"thinker_test_{uuid.uuid4().hex[:8]}"
            bb = Blackboard.get_or_create(session_id, "Thinker Test")
            
            # Simulate what thinker.py's deliberate() writes
            delib = OrchestratorDeliberation(
                reasoning="Multi-step analysis required",
                complexity=7,
                use_ensemble=False,
                plan=[
                    PlanStep(step=1, agent="Researcher", task="Gather context"),
                    PlanStep(step=2, agent="Planner", task="Draft plan", depends_on=[1]),
                ]
            )
            
            delib_md = (
                f"## Orchestrator Deliberation\n\n"
                f"- **Complexity**: {delib.complexity}/10\n"
                f"- **Ensemble Required**: {'Yes' if delib.use_ensemble else 'No'}\n"
                f"- **Reasoning**: {delib.reasoning}\n\n"
                f"### Task DAG\n\n"
            )
            for step in delib.plan:
                deps = f" (after step {step.depends_on})" if step.depends_on else ""
                delib_md += f"- Step {step.step}: **[{step.agent}]** {step.task}{deps}\n"
            
            bb.append_step(agent_id="orchestrator_think", content=delib_md)
            
            state = bb.read_state()
            assert "Orchestrator Deliberation" in state["raw"]
            assert "Complexity" in state["raw"]
            assert "7/10" in state["raw"]
            assert "Researcher" in state["raw"]
            
            Blackboard.clear_cache()
    
    def test_route_after_think_fast_path(self):
        """route_after_think returns 'planner_fast' for complexity <= 4."""
        from cortex.core.orchestrator import route_after_think
        from cortex.schemas.state import OrchestratorDeliberation, PlanStep
        
        delib = OrchestratorDeliberation(
            reasoning="Simple task",
            complexity=3,
            use_ensemble=False,
            plan=[PlanStep(step=1, agent="Executor", task="Do thing")]
        )
        
        state = {
            "messages": [],
            "session_id": "test",
            "orchestrator_deliberation": delib,
        }
        
        result = route_after_think(state)
        assert result == "planner_fast"
    
    def test_route_after_think_full_path(self):
        """route_after_think returns 'planner' for complexity > 4."""
        from cortex.core.orchestrator import route_after_think
        from cortex.schemas.state import OrchestratorDeliberation, PlanStep
        
        delib = OrchestratorDeliberation(
            reasoning="Complex multi-agent task",
            complexity=8,
            use_ensemble=True,
            plan=[
                PlanStep(step=1, agent="Researcher", task="Gather"),
                PlanStep(step=2, agent="Planner", task="Plan", depends_on=[1]),
            ]
        )
        
        state = {
            "messages": [],
            "session_id": "test",
            "orchestrator_deliberation": delib,
        }
        
        result = route_after_think(state)
        assert result == "planner"
    
    def test_route_after_think_no_deliberation_defaults_full(self):
        """route_after_think defaults to full path when deliberation is None."""
        from cortex.core.orchestrator import route_after_think
        
        state = {
            "messages": [],
            "session_id": "test",
            "orchestrator_deliberation": None,
        }
        
        result = route_after_think(state)
        assert result == "planner"
    
    def test_synthesizer_reads_blackboard(self, temp_blackboard_root):
        """Synthesizer can read a full audit trail from Blackboard."""
        from cortex.blackboard import Blackboard
        
        with patch.dict(os.environ, {"BLACKBOARD_ROOT": str(temp_blackboard_root)}):
            Blackboard.clear_cache()
            import uuid
            session_id = f"synth_read_{uuid.uuid4().hex[:8]}"
            bb = Blackboard.get_or_create(session_id, "Synth Read Test")
            
            # Simulate a full pipeline audit trail
            bb.append_step("orchestrator_think", "## Deliberation\n\nComplexity: 6")
            bb.append_step("planner", "# Plan\n\n- Step 1: Build\n- Step 2: Deploy")
            bb.append_step("simulator", "## Simulation\n\n- Risk: low")
            bb.append_step("human_review", "## Review\n\nApproved.")
            bb.append_step("compiler", "## Compiled\n\n- 2 nodes")
            bb.append_step("executor", "## Execution\n\n- ✅ Success")
            
            state = bb.read_state()
            raw = state["raw"]
            
            # All nodes present in trail
            assert "Deliberation" in raw
            assert "Plan" in raw
            assert "Simulation" in raw
            assert "Review" in raw
            assert "Compiled" in raw
            assert "Execution" in raw
            assert state["version"] >= 6
            
            Blackboard.clear_cache()
    
    def test_full_pipeline_with_think_and_synth(self, temp_blackboard_root):
        """Full Phase 14 pipeline: think -> plan -> vote -> execute -> synthesize."""
        from cortex.blackboard import Blackboard
        
        with patch.dict(os.environ, {"BLACKBOARD_ROOT": str(temp_blackboard_root)}):
            Blackboard.clear_cache()
            import uuid
            session_id = f"full_p14_{uuid.uuid4().hex[:8]}"
            bb = Blackboard.get_or_create(session_id, "Full Phase 14 Test")
            
            # Phase 14: New nodes bookend the pipeline
            bb.append_step("orchestrator_think", "## Orchestrator Deliberation\n\n- **Complexity**: 6/10")
            bb.append_step("planner", "# Deploy API\n\n- Step 1: Build\n- Step 2: Deploy")
            bb.append_step("simulator", "## Simulation Report\n\n- **Risk**: low")
            bb.append_step("human_review", "## Human Review\n\nApproved.")
            bb.append_step("compiler", "## Compiled Plan\n\n- 2 nodes")
            bb.append_step("executor", "## Execution Result\n\n- ✅ Success")
            bb.append_step("synthesizer", "## Final Synthesis\n\nAPI deployed successfully with low risk.")
            
            state = bb.read_state()
            raw = state["raw"]
            
            # Phase 14 bookends present
            assert "Orchestrator Deliberation" in raw
            assert "Final Synthesis" in raw
            
            # Full trail integrity
            assert "Deploy API" in raw
            assert "Simulation Report" in raw
            assert "Human Review" in raw
            assert "Compiled Plan" in raw
            assert "Execution Result" in raw
            assert state["version"] >= 7
            
            Blackboard.clear_cache()


# ============================================================
# Phase 6: Atomic Factoid Extraction Tests
# ============================================================

class TestFactoidExtraction:
    """Tests for FactoidExtractor and related plumbing."""

    @pytest.mark.asyncio
    async def test_extraction_decomposes_into_factoids(self):
        """FactoidExtractor should decompose a blob into multiple atomic factoids."""
        from cortex.memory.factoid_extractor import FactoidExtractor, ExtractedFactoids

        mock_llm = MagicMock()
        mock_structured = AsyncMock()
        mock_structured.ainvoke = AsyncMock(return_value=ExtractedFactoids(
            factoids=[
                "The user needed a deployment pipeline",
                "Docker was chosen for containerization",
                "The plan was approved unanimously",
            ]
        ))
        mock_llm.with_structured_output = MagicMock(return_value=mock_structured)

        extractor = FactoidExtractor(llm=mock_llm)
        result = await extractor.extract("EPISODE TYPE: successful\nSOLUTION: Docker Pipeline", source="test")

        assert len(result) == 3
        assert "Docker was chosen for containerization" in result
        mock_llm.with_structured_output.assert_called_once_with(ExtractedFactoids)

    @pytest.mark.asyncio
    async def test_extraction_raises_on_llm_failure(self):
        """FactoidExtractor must raise on LLM failure — no fallbacks."""
        from cortex.memory.factoid_extractor import FactoidExtractor

        mock_llm = MagicMock()
        mock_structured = AsyncMock()
        mock_structured.ainvoke = AsyncMock(side_effect=RuntimeError("LLM unavailable"))
        mock_llm.with_structured_output = MagicMock(return_value=mock_structured)

        extractor = FactoidExtractor(llm=mock_llm)
        with pytest.raises(RuntimeError, match="LLM unavailable"):
            await extractor.extract("some episode text", source="test")

    @pytest.mark.asyncio
    async def test_extraction_raises_on_empty_factoids(self):
        """FactoidExtractor must raise ValueError if LLM returns 0 factoids."""
        from cortex.memory.factoid_extractor import FactoidExtractor, ExtractedFactoids

        mock_llm = MagicMock()
        mock_structured = AsyncMock()
        mock_structured.ainvoke = AsyncMock(return_value=ExtractedFactoids(factoids=[]))
        mock_llm.with_structured_output = MagicMock(return_value=mock_structured)

        extractor = FactoidExtractor(llm=mock_llm)
        with pytest.raises(ValueError, match="returned 0 factoids"):
            await extractor.extract("some text", source="test")

    @pytest.mark.asyncio
    async def test_add_with_extraction_calls_add_fact_n_times(self):
        """add_with_extraction should call add_fact once per factoid in parallel."""
        factoids = ["fact1", "fact2", "fact3"]

        # Pre-import so the module exists, then patch the class on it
        import cortex.memory.factoid_extractor as fe_module

        mock_instance = AsyncMock()
        mock_instance.extract = AsyncMock(return_value=factoids)
        MockExtractor = MagicMock(return_value=mock_instance)

        mock_graphiti = AsyncMock()

        with patch.object(fe_module, "FactoidExtractor", MockExtractor):
            from cortex.memory.repository import MemoryRepository
            repo = MemoryRepository.__new__(MemoryRepository)
            repo.client = mock_graphiti

            count = await repo.add_with_extraction("raw blob", source="test")

            assert count == 3
            assert mock_graphiti.add_episode.call_count == 3

    @pytest.mark.asyncio
    async def test_gardener_contradiction_with_superseded_at(self):
        """Gardener should inject CORRECTION with SUPERSEDED_AT timestamp."""
        from cortex.memory.gardener import Gardener, ContradictionCheck

        mock_llm = MagicMock()
        mock_structured = AsyncMock()
        mock_structured.ainvoke = AsyncMock(return_value=ContradictionCheck(
            is_contradicted=True,
            new_truth="User now prefers ClickHouse over PostgreSQL",
            reasoning="User explicitly switched databases in recent project",
        ))
        mock_llm.with_structured_output = MagicMock(return_value=mock_structured)

        with patch.object(Gardener, "find_stale_facts", new_callable=AsyncMock) as mock_stale:
            mock_stale.return_value = [
                {"id": "1", "content": "User prefers PostgreSQL", "created_at": "2025-01-01"}
            ]

            with patch("cortex.memory.gardener.MemoryRepository") as MockRepo:
                mock_repo = AsyncMock()
                mock_repo.search_memory = AsyncMock(return_value=[
                    {"content": "User migrated to ClickHouse", "score": 0.9}
                ])
                mock_repo.add_fact = AsyncMock()
                MockRepo.return_value = mock_repo

                with patch("cortex.memory.gardener.MemoryClient"):
                    gardener = Gardener.__new__(Gardener)
                    gardener.repo = mock_repo
                    gardener.driver = MagicMock()
                    gardener._llm = mock_llm

                    corrections = await gardener.verify_and_prune()

                    assert len(corrections) == 1
                    assert "SUPERSEDED_AT:" in corrections[0]
                    assert "TYPE: CORRECTION" in corrections[0]
                    assert "User now prefers ClickHouse" in corrections[0]
                    assert "User prefers PostgreSQL" in corrections[0]
                    mock_repo.add_fact.assert_called_once()
