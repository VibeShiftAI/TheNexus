"""
Artifacts Package - Universal Artifact System for The Nexus.

This package provides a universal, format-agnostic artifact system that allows
any workflow node to produce and consume artifacts of any type.

Key Components:
    - Artifact: Universal container for any content (text, JSON, binary, files)
    - ArtifactCategory: High-level categories for UI grouping
    - ArtifactStore: Thread-safe registry with versioning and discovery

Usage:
    >>> from nodes.artifacts import Artifact, ArtifactStore, ArtifactCategory
    >>> 
    >>> # Create a store for a workflow run
    >>> store = ArtifactStore(workflow_run_id="run-123")
    >>> 
    >>> # Store an artifact
    >>> store.store_simple(
    ...     key="research_dossier",
    ...     content="# Research Findings\\n...",
    ...     category=ArtifactCategory.RESEARCH
    ... )
    >>> 
    >>> # Retrieve an artifact
    >>> dossier = store.get_content("research_dossier")
"""

from .models import Artifact, ArtifactCategory
from .store import ArtifactStore

__all__ = [
    "Artifact",
    "ArtifactCategory", 
    "ArtifactStore",
]
