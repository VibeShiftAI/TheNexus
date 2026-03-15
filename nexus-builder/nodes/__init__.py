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

from .research import (
    ResearcherNode,
    ScoperNode, 
    VetterNode,
    ResearchExecutorNode,
    SynthesizerNode,
)
from .planning import (
    ArchitectNode,
    CartographerNode,
    DrafterNode,
    GrounderNode,
)
from .implementation import (
    BuilderNode,
    ScoutNode,
    CoderNode,
    CheckerNode,
)
from .review import (
    AuditorNode,
    ForensicNode,
    VerdictNode,
)
from .orchestration import (
    NexusPrimeNode,
    HumanApprovalNode,
    ApprovalGateNode,
)
from .utility import (
    SummarizerNode,
    GitCommitNode,
    AggregateResultsNode,
)

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

