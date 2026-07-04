"""
Shared state for passing human review decisions between
the GraphEngine interrupt/resume mechanism and downstream nodes.

This avoids coupling nodes directly to the GraphEngine while
allowing hunk decisions from the user to reach the file_writer.
"""

from typing import Dict, Any, Optional

# Maps run_id -> user's approved doc_changes
# Set by GraphEngine.resume_run(), read by DocFileWriterNode
_hunk_decisions: Dict[str, Dict[str, Any]] = {}
_latest_run_id: Optional[str] = None


def set_hunk_decisions(run_id: str, doc_changes: Dict[str, Any]):
    """Store user's per-hunk decisions for a run."""
    global _latest_run_id
    _hunk_decisions[run_id] = doc_changes
    _latest_run_id = run_id


def get_hunk_decisions(run_id: str) -> Optional[Dict[str, Any]]:
    """Get user's per-hunk decisions for a specific run (does not clear)."""
    return _hunk_decisions.get(run_id)


def get_latest_hunk_decisions() -> Optional[Dict[str, Any]]:
    """Get the most recent hunk decisions (fallback when run_id is unknown)."""
    if _latest_run_id:
        return _hunk_decisions.get(_latest_run_id)
    return None


def clear_hunk_decisions(run_id: str):
    """Clear decisions after they've been consumed."""
    _hunk_decisions.pop(run_id, None)
