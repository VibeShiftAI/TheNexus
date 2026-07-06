"""
Blackboard System - Research coordination state backend.

Provides a shared knowledge space for multi-agent research workflows.
The Lead Researcher writes Plans, Worker agents write Findings,
and the Synthesizer compiles them into a final Dossier.

Persistence: Local filesystem (data/blackboard/)
Export: Neo4j via Graphiti (MemoryRepository)
"""
from .models import Comment, Finding, SessionInfo, SessionStatus
from .blackboard import Blackboard, BLACKBOARD_ROOT

__all__ = [
    "Comment",
    "Finding",
    "SessionInfo", 
    "SessionStatus",
    "Blackboard",
    "BLACKBOARD_ROOT",
]

