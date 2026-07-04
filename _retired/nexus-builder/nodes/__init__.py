"""
Nodes Package - Atomic Node Library

This package contains all atomic nodes for The Nexus workflow system.
Each subdirectory represents a category of nodes.

Directory Structure:
    nodes/
    ├── core/           # Base classes (AtomicNode, NodeExecutionContext)
    ├── research/       # Research nodes (Researcher, WebSearch, etc.)
    ├── planning/       # Planning nodes (Architect, etc.)
    ├── implementation/ # Implementation nodes (Builder, etc.)
    ├── review/         # Review nodes (Auditor, etc.)
    ├── orchestration/  # Control flow (NexusPrime, HumanApproval, etc.)
    ├── utility/        # Utilities (Summarizer, GitCommit, etc.)
    └── triggers/       # Trigger nodes (Webhook, Schedule, etc.)
"""

from .core import (
    AtomicNode,
    NodeExecutionContext,
    NodeExecutionData,
    NodeConnectionType,
)
from .core.fleet import FleetAgentNode

_LAZY_EXPORTS = {
    "ResearcherNode": (".research", "ResearcherNode"),
    "ScoperNode": (".research", "ScoperNode"),
    "VetterNode": (".research", "VetterNode"),
    "ResearchExecutorNode": (".research", "ResearchExecutorNode"),
    "SynthesizerNode": (".research", "SynthesizerNode"),
    "ArchitectNode": (".planning", "ArchitectNode"),
    "CartographerNode": (".planning", "CartographerNode"),
    "DrafterNode": (".planning", "DrafterNode"),
    "GrounderNode": (".planning", "GrounderNode"),
    "BuilderNode": (".implementation", "BuilderNode"),
    "ScoutNode": (".implementation", "ScoutNode"),
    "CoderNode": (".implementation", "CoderNode"),
    "CheckerNode": (".implementation", "CheckerNode"),
    "AuditorNode": (".review", "AuditorNode"),
    "ForensicNode": (".review", "ForensicNode"),
    "VerdictNode": (".review", "VerdictNode"),
    "NexusPrimeNode": (".orchestration", "NexusPrimeNode"),
    "HumanApprovalNode": (".orchestration", "HumanApprovalNode"),
    "ApprovalGateNode": (".orchestration", "ApprovalGateNode"),
    "SummarizerNode": (".utility", "SummarizerNode"),
    "GitCommitNode": (".utility", "GitCommitNode"),
    "AggregateResultsNode": (".utility", "AggregateResultsNode"),
}


def __getattr__(name):
    if name not in _LAZY_EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module

    module_name, attr_name = _LAZY_EXPORTS[name]
    attr = getattr(import_module(module_name, __name__), attr_name)
    globals()[name] = attr
    return attr

__all__ = [
    # Core
    "AtomicNode",
    "NodeExecutionContext",
    "NodeExecutionData", 
    "NodeConnectionType",
    "FleetAgentNode",
    
    # Research Fleet
    "ResearcherNode",
    "ScoperNode",
    "VetterNode",
    "ResearchExecutorNode",
    "SynthesizerNode",
    
    # Architect Fleet
    "ArchitectNode",
    "CartographerNode",
    "DrafterNode",
    "GrounderNode",
    
    # Builder Fleet
    "BuilderNode",
    "ScoutNode",
    "CoderNode",
    "CheckerNode",
    
    # Auditor Fleet
    "AuditorNode",
    "ForensicNode",
    "VerdictNode",
    
    # Orchestration
    "NexusPrimeNode",
    "HumanApprovalNode",
    "ApprovalGateNode",
    
    # Utility
    "SummarizerNode",
    "GitCommitNode",
    "AggregateResultsNode",
]
