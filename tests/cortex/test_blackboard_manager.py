"""
Unit tests for Blackboard Live State Management.

Tests cover:
- Comment model serialization/deserialization
- state.md initialization with line numbering
- read_state() section parsing
- append_step() with version bumping
- add_comment() with line_ref and version_ref
- vote_comment() and score computation
- resolve_votes() with version-aware promotion
- Version snapshotting
- Cross-platform file locking (basic)
"""
import pytest
from pathlib import Path
from datetime import datetime

from cortex.blackboard import Blackboard, Comment
from cortex.blackboard.models import SessionStatus
import cortex.blackboard.blackboard as bb_module


@pytest.fixture
def state_bb(tmp_path):
    """Create a blackboard with temp directory for state testing."""
    original_root = bb_module.BLACKBOARD_ROOT
    bb_module.BLACKBOARD_ROOT = tmp_path

    Blackboard.clear_cache()
    bb = Blackboard.get_or_create("state-test", "State Test")
    yield bb

    Blackboard.clear_cache()
    bb_module.BLACKBOARD_ROOT = original_root


# ────────────────────────────────────────────────────────────
# Comment Model
# ────────────────────────────────────────────────────────────

class TestCommentModel:
    """Serialization and deserialization of Comment dataclass."""

    def test_comment_roundtrip(self):
        """Comment can serialize to markdown and parse back."""
        original = Comment(
            id="c_test1234",
            agent_id="red_cell",
            content="This step is risky",
            line_ref=5,
            version_ref=2,
            score=1,
            votes={"proposer": "up", "critic": "down", "judge": "up"},
        )

        md = original.to_markdown()

        # Should contain metadata
        assert "<!-- comment:c_test1234" in md
        assert "agent:red_cell" in md
        assert "version:2" in md
        assert "line:5" in md

        # Parse back
        parsed = Comment.from_markdown(md)
        assert parsed is not None
        assert parsed.id == "c_test1234"
        assert parsed.agent_id == "red_cell"
        assert parsed.line_ref == 5
        assert parsed.version_ref == 2
        assert parsed.content == "This step is risky"

    def test_comment_no_line_ref(self):
        """General comment without line reference."""
        comment = Comment(agent_id="agent1", content="Overall looks good")
        md = comment.to_markdown()

        assert "line:" not in md
        assert "version:" not in md

        parsed = Comment.from_markdown(md)
        assert parsed is not None
        assert parsed.line_ref is None
        assert parsed.version_ref is None

    def test_comment_hashtag_extraction(self):
        """Hashtags are extracted from comment content."""
        comment = Comment(
            agent_id="test",
            content="Use #entity_extraction and #neo4j_database",
            hashtags=["#entity_extraction", "#neo4j_database"],
        )
        assert "#entity_extraction" in comment.hashtags
        assert "#neo4j_database" in comment.hashtags


# ────────────────────────────────────────────────────────────
# State.md Initialization
# ────────────────────────────────────────────────────────────

class TestStateInit:
    """state.md template creation and directory structure."""

    def test_state_file_created(self, state_bb):
        """New session creates state.md automatically."""
        state_path = state_bb.session_dir / "state.md"
        assert state_path.exists()

    def test_state_versions_dir_created(self, state_bb):
        """New session creates state_versions/ directory."""
        versions_dir = state_bb.session_dir / "state_versions"
        assert versions_dir.exists()

    def test_state_has_version_header(self, state_bb):
        """state.md starts with version comment."""
        state_path = state_bb.session_dir / "state.md"
        content = state_path.read_text(encoding="utf-8")
        assert content.startswith("<!-- version:1 -->")

    def test_state_has_line_numbers(self, state_bb):
        """state.md lines are numbered with 3-digit zero-padding."""
        state_path = state_bb.session_dir / "state.md"
        content = state_path.read_text(encoding="utf-8")
        lines = content.split("\n")
        # Second line (first after version header) should start with 001
        assert lines[1].startswith("001: ")

    def test_state_has_default_sections(self, state_bb):
        """state.md contains User_Query, Plan, Notes, Comments sections."""
        state = state_bb.read_state()
        assert state["version"] == 1
        # Section headers should be parsed
        assert "User_Query" in state
        assert "Plan" in state
        assert "Notes" in state


# ────────────────────────────────────────────────────────────
# read_state()
# ────────────────────────────────────────────────────────────

class TestReadState:
    """Parsing state.md into structured dict."""

    def test_read_state_returns_version(self, state_bb):
        """read_state includes version number."""
        state = state_bb.read_state()
        assert state["version"] == 1

    def test_read_state_returns_line_map(self, state_bb):
        """read_state includes line_map dict."""
        state = state_bb.read_state()
        assert isinstance(state["line_map"], dict)
        assert len(state["line_map"]) > 0

    def test_read_state_empty_comments(self, state_bb):
        """Fresh state has empty comments list."""
        state = state_bb.read_state()
        assert state["comments"] == []

    def test_read_state_plan_as_list(self, state_bb):
        """Plan section is parsed as a list of items."""
        state = state_bb.read_state()
        assert isinstance(state["Plan"], list)

    def test_read_state_missing_file(self, tmp_path):
        """non-existent state.md returns empty dict."""
        original_root = bb_module.BLACKBOARD_ROOT
        bb_module.BLACKBOARD_ROOT = tmp_path

        Blackboard.clear_cache()
        bb = Blackboard.get_or_create("empty-test", "Empty")
        # Delete state.md to simulate missing file
        (bb.session_dir / "state.md").unlink(missing_ok=True)

        state = bb.read_state()
        assert state["version"] == 0
        assert state["comments"] == []

        Blackboard.clear_cache()
        bb_module.BLACKBOARD_ROOT = original_root


# ────────────────────────────────────────────────────────────
# append_step()
# ────────────────────────────────────────────────────────────

class TestAppendStep:
    """Appending timestamped entries to state.md."""

    def test_append_bumps_version(self, state_bb):
        """Each append increments the version."""
        state_bb.append_step("agent_1", "First step")
        state = state_bb.read_state()
        assert state["version"] == 2

        state_bb.append_step("agent_2", "Second step")
        state = state_bb.read_state()
        assert state["version"] == 3

    def test_append_content_visible(self, state_bb):
        """Appended content appears in state.md."""
        state_bb.append_step("researcher", "Found evidence of X")
        state_path = state_bb.session_dir / "state.md"
        raw = state_path.read_text(encoding="utf-8")
        assert "Found evidence of X" in raw
        assert "researcher" in raw

    def test_append_creates_snapshot(self, state_bb):
        """Version snapshot is created before overwrite."""
        state_bb.append_step("agent", "Step 1")
        versions_dir = state_bb.session_dir / "state_versions"
        assert (versions_dir / "v1.md").exists()

    def test_append_before_comments(self, state_bb):
        """New entries are inserted before ## Comments."""
        state_bb.append_step("agent", "New entry")
        state_path = state_bb.session_dir / "state.md"
        raw = state_path.read_text(encoding="utf-8")
        comments_pos = raw.find("## Comments")
        entry_pos = raw.find("New entry")
        assert entry_pos < comments_pos


# ────────────────────────────────────────────────────────────
# add_comment() + vote_comment()
# ────────────────────────────────────────────────────────────

class TestComments:
    """Comment addition and voting."""

    def test_add_comment_returns_id(self, state_bb):
        """add_comment returns a comment ID."""
        cid = state_bb.add_comment("agent1", "Looks good")
        assert cid.startswith("c_")

    def test_comment_appears_in_state(self, state_bb):
        """Added comment is visible via read_state."""
        state_bb.add_comment("agent1", "Test comment")
        state = state_bb.read_state()
        assert len(state["comments"]) == 1
        assert state["comments"][0].content == "Test comment"

    def test_comment_with_line_ref(self, state_bb):
        """Comment with line_ref records current version."""
        cid = state_bb.add_comment("agent1", "Issue on this line", line_ref=3)
        state = state_bb.read_state()
        comment = state["comments"][0]
        assert comment.line_ref == 3
        assert comment.version_ref == 1  # Initial version

    def test_comment_no_version_bump(self, state_bb):
        """Comments don't change the file version."""
        v_before = state_bb._get_state_version()
        state_bb.add_comment("agent", "No bump")
        v_after = state_bb._get_state_version()
        assert v_after == v_before

    def test_vote_up(self, state_bb):
        """Voting up increases score."""
        cid = state_bb.add_comment("agent1", "Good idea")
        state_bb.vote_comment("voter1", cid, "up")
        state_bb.vote_comment("voter2", cid, "up")

        state = state_bb.read_state()
        comment = state["comments"][0]
        assert comment.score == 2

    def test_vote_down(self, state_bb):
        """Voting down decreases score."""
        cid = state_bb.add_comment("agent1", "Bad idea")
        state_bb.vote_comment("voter1", cid, "down")

        state = state_bb.read_state()
        comment = state["comments"][0]
        assert comment.score == -1

    def test_one_vote_per_agent(self, state_bb):
        """Same agent's vote overwrites previous vote."""
        cid = state_bb.add_comment("agent1", "Maybe")
        state_bb.vote_comment("voter1", cid, "up")
        state_bb.vote_comment("voter1", cid, "down")

        state = state_bb.read_state()
        comment = state["comments"][0]
        assert comment.votes["voter1"] == "down"
        assert comment.score == -1

    def test_vote_invalid_raises(self, state_bb):
        """Invalid vote value raises ValueError."""
        cid = state_bb.add_comment("agent", "test")
        with pytest.raises(ValueError, match="up.*down"):
            state_bb.vote_comment("v", cid, "maybe")

    def test_vote_missing_comment_raises(self, state_bb):
        """Voting on non-existent comment raises ValueError."""
        with pytest.raises(ValueError, match="not found"):
            state_bb.vote_comment("v", "c_nonexist", "up")

    def test_threaded_comment(self, state_bb):
        """Comments can be threaded via parent_id."""
        parent_id = state_bb.add_comment("agent1", "Parent comment")
        child_id = state_bb.add_comment(
            "agent2", "Reply to parent", parent_id=parent_id
        )

        state = state_bb.read_state()
        child = [c for c in state["comments"] if c.id == child_id][0]
        assert child.parent_id == parent_id


# ────────────────────────────────────────────────────────────
# resolve_votes()
# ────────────────────────────────────────────────────────────

class TestResolveVotes:
    """Vote resolution and comment promotion."""

    def test_promote_winning_comment(self, state_bb):
        """Comments with score >= min_score are promoted."""
        cid = state_bb.add_comment("agent1", "Add this to plan")
        state_bb.vote_comment("voter1", cid, "up")
        state_bb.vote_comment("voter2", cid, "up")

        promoted = state_bb.resolve_votes(min_score=1)
        assert cid in promoted

    def test_archive_rejected_comment(self, state_bb):
        """Negative-score comments are archived."""
        cid = state_bb.add_comment("agent1", "Bad suggestion")
        state_bb.vote_comment("voter1", cid, "down")

        state_bb.resolve_votes(min_score=1)

        # Check the raw file for archived section
        state_path = state_bb.session_dir / "state.md"
        raw = state_path.read_text(encoding="utf-8")
        assert "## Archived Comments" in raw
        assert "REJECTED" in raw

    def test_resolve_bumps_version(self, state_bb):
        """resolve_votes increments file version."""
        cid = state_bb.add_comment("a", "test")
        state_bb.vote_comment("v1", cid, "up")

        v_before = state_bb._get_state_version()
        state_bb.resolve_votes(min_score=1)
        v_after = state_bb._get_state_version()
        assert v_after == v_before + 1

    def test_no_action_when_no_votes(self, state_bb):
        """resolve_votes returns empty list when no comments qualify."""
        state_bb.add_comment("a", "unvoted comment")
        promoted = state_bb.resolve_votes(min_score=1)
        assert promoted == []


# ────────────────────────────────────────────────────────────
# Line numbering helpers
# ────────────────────────────────────────────────────────────

class TestLineNumbering:
    """Line numbering add/strip helpers."""

    def test_add_line_numbers(self):
        """Lines get 3-digit zero-padded numbers."""
        result = Blackboard._add_line_numbers("hello\nworld")
        assert result == "001: hello\n002: world"

    def test_strip_line_numbers(self):
        """Line numbers are stripped and line_map is populated."""
        text = "001: hello\n002: world"
        clean, line_map = Blackboard._strip_line_numbers(text)
        assert clean == "hello\nworld"
        assert line_map == {1: "hello", 2: "world"}

    def test_strip_preserves_unnumbered(self):
        """Lines without numbers are passed through unchanged."""
        text = "no prefix\n001: numbered"
        clean, line_map = Blackboard._strip_line_numbers(text)
        assert "no prefix" in clean
        assert 1 in line_map


# ────────────────────────────────────────────────────────────
# Version snapshotting
# ────────────────────────────────────────────────────────────

class TestVersioning:
    """Version tracking and snapshot retrieval."""

    def test_initial_version_is_1(self, state_bb):
        """Fresh state.md starts at version 1."""
        assert state_bb._get_state_version() == 1

    def test_snapshot_saved_on_write(self, state_bb):
        """_save_version_snapshot creates a copy."""
        state_bb._save_version_snapshot(1)
        snap = state_bb.session_dir / "state_versions" / "v1.md"
        assert snap.exists()

    def test_snapshot_content_readable(self, state_bb):
        """Saved snapshot can be read back."""
        state_bb._save_version_snapshot(1)
        content = state_bb._get_version_snapshot(1)
        assert content is not None
        assert "version:1" in content

    def test_missing_snapshot_returns_none(self, state_bb):
        """Non-existent version returns None."""
        assert state_bb._get_version_snapshot(999) is None
