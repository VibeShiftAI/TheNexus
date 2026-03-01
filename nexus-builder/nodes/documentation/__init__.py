"""
Documentation Nodes - Atomic nodes for the Documentation Writer workflow.

These nodes bridge the doc-writer LangGraph into the registry system,
making them visible in the workflow builder and agent manager.
"""

from .explorer import DocExplorerNode
from .drafter import DocDrafterNode
from .review_gate import DocReviewGateNode
from .file_writer import DocFileWriterNode

__all__ = [
    "DocExplorerNode",
    "DocDrafterNode",
    "DocReviewGateNode",
    "DocFileWriterNode",
]
