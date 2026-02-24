"""
Unit tests for the Blackboard system.

Tests cover:
- Session creation and persistence
- Singleton pattern enforcement
- Plan read/write operations
- Finding submission with deduplication
- Thread safety under concurrent writes
- Finding parsing from markdown
"""
import pytest
import threading
from pathlib import Path

from cortex.blackboard import Blackboard
from cortex.blackboard.models import Finding, SessionInfo, SessionStatus


@pytest.fixture
def temp_blackboard(tmp_path):
    """Create a blackboard with temp directory for isolation."""
    import cortex.blackboard.blackboard as bb_module
    original_root = bb_module.BLACKBOARD_ROOT
    bb_module.BLACKBOARD_ROOT = tmp_path
    
    Blackboard.clear_cache()
    bb = Blackboard.get_or_create("test-session", "Test Topic")
    yield bb
    
    Blackboard.clear_cache()
    bb_module.BLACKBOARD_ROOT = original_root


class TestBlackboardBasics:
    """Core functionality tests."""
    
    def test_create_session(self, temp_blackboard):
        """Session creation sets up directory structure correctly."""
        bb = temp_blackboard
        assert bb.session_id == "test-session"
        assert bb.topic == "Test Topic"
        assert bb.metadata.status == SessionStatus.ACTIVE
        assert bb.session_dir.exists()
        assert (bb.session_dir / "findings").exists()
        assert (bb.session_dir / "metadata.json").exists()
    
    def test_singleton_pattern(self, tmp_path):
        """Same session_id returns same instance."""
        import cortex.blackboard.blackboard as bb_module
        bb_module.BLACKBOARD_ROOT = tmp_path
        Blackboard.clear_cache()
        
        bb1 = Blackboard.get_or_create("same-id", "Topic 1")
        bb2 = Blackboard.get_or_create("same-id", "Topic 2")
        
        # Should be the exact same object
        assert bb1 is bb2
        # Topic should NOT be updated (first creation wins)
        assert bb1.topic == "Topic 1"
    
    def test_write_and_read_plan(self, temp_blackboard):
        """Plan can be written and read back."""
        bb = temp_blackboard
        bb.write_plan("# Test Plan\n\n1. Step one\n2. Step two")
        
        plan = bb.read_plan()
        assert "Test Plan" in plan
        assert "Step one" in plan
        assert "Step two" in plan
    
    def test_submit_finding(self, temp_blackboard):
        """Finding submission creates file and updates metadata."""
        bb = temp_blackboard
        finding = bb.submit_finding(
            worker_id="test_worker",
            content="Test content for finding",
            tool_name="web_search",
            query="test query",
            tags=["test", "unit"],
        )
        
        assert finding is not None
        assert finding.worker_id == "test_worker"
        assert finding.tool_name == "web_search"
        assert bb.finding_count == 1
        assert Path(finding.file_path).exists()
    
    def test_duplicate_prevention(self, temp_blackboard):
        """Same tool_call_id is rejected on second submission."""
        bb = temp_blackboard
        
        f1 = bb.submit_finding("worker", "content 1", tool_call_id="call_123")
        f2 = bb.submit_finding("worker", "content 2", tool_call_id="call_123")
        
        assert f1 is not None
        assert f2 is None  # Duplicate blocked
        assert bb.finding_count == 1
    
    def test_get_full_context(self, temp_blackboard):
        """Full context includes plan and all findings."""
        bb = temp_blackboard
        bb.write_plan("# Research Plan\n\nInvestigate X and Y")
        bb.submit_finding("w1", "Found info about X", tool_name="search", query="what is X")
        bb.submit_finding("w2", "Found info about Y", tool_name="scrape", query="documentation for Y")
        
        context = bb.get_full_context()
        
        assert "RESEARCH PLAN" in context
        assert "Research Plan" in context
        assert "RESEARCH FINDINGS" in context
        assert "Found info about X" in context
        assert "Found info about Y" in context
        assert "[search]" in context
        assert "[scrape]" in context
    
    def test_synthesis_workflow(self, temp_blackboard):
        """Write and read synthesis, check status update."""
        bb = temp_blackboard
        
        # Add some content first
        bb.write_plan("Plan")
        bb.submit_finding("w", "Finding")
        
        # Write synthesis
        path = bb.write_synthesis("# Final Dossier\n\nConclusions here.")
        
        assert Path(path).exists()
        assert bb.metadata.status == SessionStatus.SYNTHESIZED
        
        synthesis = bb.read_synthesis()
        assert "Final Dossier" in synthesis
        assert "Conclusions" in synthesis


class TestConcurrency:
    """Thread safety tests."""
    
    def test_concurrent_findings(self, tmp_path):
        """Multiple threads can submit findings safely."""
        import cortex.blackboard.blackboard as bb_module
        bb_module.BLACKBOARD_ROOT = tmp_path
        Blackboard.clear_cache()
        
        bb = Blackboard.get_or_create("concurrent-test", "Concurrency Test")
        errors = []
        
        def submit(thread_id):
            try:
                for i in range(5):
                    bb.submit_finding(
                        worker_id=f"worker_{thread_id}",
                        content=f"Content from thread {thread_id}, iteration {i}",
                        tool_name="test_tool"
                    )
            except Exception as e:
                errors.append(e)
        
        threads = [threading.Thread(target=submit, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        
        assert len(errors) == 0, f"Errors during concurrent writes: {errors}"
        assert bb.finding_count == 20  # 4 threads * 5 findings each
        assert len(bb.get_findings()) == 20


class TestFindingParsing:
    """Markdown serialization/deserialization tests."""
    
    def test_to_and_from_markdown(self):
        """Finding can roundtrip through markdown format."""
        original = Finding(
            worker_id="test_worker",
            tool_name="web_search",
            query="test query with quotes \"here\"",
            content="# Result\n\nSome **markdown** content.",
            tags=["tag1", "tag2"],
        )
        
        md = original.to_markdown()
        parsed = Finding.from_markdown(md)
        
        assert parsed.worker_id == original.worker_id
        assert parsed.tool_name == original.tool_name
        assert parsed.content == original.content
        assert parsed.tags == original.tags
    
    def test_parse_malformed_content(self):
        """Parser handles content without frontmatter."""
        content = "Just plain text without YAML"
        finding = Finding.from_markdown(content)
        
        assert finding.content == content
        assert finding.worker_id == ""


class TestWindowsSanitization:
    """Windows path compatibility tests."""
    
    def test_illegal_chars_in_tool_name(self, temp_blackboard):
        """Tool names with illegal Windows chars are sanitized."""
        bb = temp_blackboard
        
        # Try various problematic tool names
        problematic_names = [
            "search:google",
            "file<read>",
            "path\\to\\tool",
            "query?param",
            "name*wild",
        ]
        
        for name in problematic_names:
            finding = bb.submit_finding("worker", f"Content for {name}", tool_name=name)
            assert finding is not None
            # File should exist (no Windows path errors)
            assert Path(finding.file_path).exists()
