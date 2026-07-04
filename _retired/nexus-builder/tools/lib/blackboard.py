"""
Blackboard Tools - NexusTool implementations for shared state management.

Tools for interacting with the Blackboard's live state.md file:
- read_state: Read and parse the current state
- append_step: Append a timestamped agent entry
- add_comment: Add a comment targeting a specific line
- vote_comment: Vote up/down on a comment
- resolve_votes: Promote winning comments into content
- query_knowledge_graph: Hybrid retrieval from Neo4j
- sync_hashtags: Synchronize #hashtags with Neo4j entities
"""
import logging
from typing import Any, Dict, Optional

from tools.interface import NexusTool, ToolCategory, ToolMetadata

logger = logging.getLogger("BlackboardTools")


# Dual-import pattern for cross-project dependencies
def _get_blackboard(session_id: str):
    """Import and return a Blackboard instance. Handles cross-project paths."""
    try:
        from cortex.blackboard import Blackboard
    except ImportError:
        import sys
        from pathlib import Path
        cortex_root = Path(__file__).resolve().parent.parent.parent  # tools/lib -> nexus-builder -> project root
        if str(cortex_root) not in sys.path:
            sys.path.insert(0, str(cortex_root))
        from cortex.blackboard import Blackboard
    return Blackboard.get_or_create(session_id)


def _get_hashtag_manager():
    """Import and return a HashtagManager instance."""
    try:
        from cortex.blackboard import HashtagManager
    except ImportError:
        import sys
        from pathlib import Path
        cortex_root = Path(__file__).resolve().parent.parent.parent  # tools/lib -> nexus-builder -> project root
        if str(cortex_root) not in sys.path:
            sys.path.insert(0, str(cortex_root))
        from cortex.blackboard import HashtagManager
    return HashtagManager()


class ReadStateTool(NexusTool):
    """Read and parse the blackboard state.md into a structured dict."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="read_state",
            description=(
                "Read the current state.md from a blackboard session. "
                "Returns sections (User_Query, Plan, Notes), version number, "
                "line_map, comments, and #hashtags."
            ),
            category=ToolCategory.BLACKBOARD,
            can_auto_execute=True,
            requires_permission=False,
            tags=["#blackboard", "#state", "#read", "#research"],
        )
    
    async def execute(self, context: Dict[str, Any], session_id: str) -> Dict[str, Any]:
        bb = _get_blackboard(session_id)
        state = bb.read_state()
        # Serialize comments for JSON transport
        state["comments"] = [
            {
                "id": c.id,
                "agent_id": c.agent_id,
                "content": c.content,
                "line_ref": c.line_ref,
                "version_ref": c.version_ref,
                "score": c.score,
                "votes": c.votes,
                "parent_id": c.parent_id,
            }
            for c in state.get("comments", [])
        ]
        return state


class AppendStepTool(NexusTool):
    """Append a timestamped agent entry to state.md."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="append_step",
            description=(
                "Append a timestamped entry from an agent to the state.md. "
                "Increments file version and re-numbers all lines."
            ),
            category=ToolCategory.BLACKBOARD,
            can_auto_execute=True,
            requires_permission=False,
            tags=["#blackboard", "#state", "#write", "#step"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        session_id: str, agent_id: str, content: str
    ) -> Dict[str, Any]:
        bb = _get_blackboard(session_id)
        bb.append_step(agent_id=agent_id, content=content)
        return {"status": "ok", "version": bb._get_state_version()}


class AddCommentTool(NexusTool):
    """Add a version-aware comment to state.md."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="add_comment",
            description=(
                "Add a comment to a blackboard session's state.md. "
                "Comments can target a specific line number (from the current version). "
                "The version is recorded for future reference resolution."
            ),
            category=ToolCategory.BLACKBOARD,
            can_auto_execute=True,
            requires_permission=False,
            tags=["#blackboard", "#comment", "#vote", "#collaboration"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        session_id: str, agent_id: str, content: str,
        line_ref: Optional[int] = None,
        parent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        bb = _get_blackboard(session_id)
        comment_id = bb.add_comment(
            agent_id=agent_id,
            content=content,
            line_ref=line_ref,
            parent_id=parent_id,
        )
        return {"status": "ok", "comment_id": comment_id}


class VoteCommentTool(NexusTool):
    """Vote up or down on a comment."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="vote_comment",
            description=(
                "Cast an up or down vote on a comment in a blackboard session. "
                "One vote per agent per comment. Updates the comment's score."
            ),
            category=ToolCategory.BLACKBOARD,
            can_auto_execute=True,
            requires_permission=False,
            tags=["#blackboard", "#vote", "#comment", "#consensus"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        session_id: str, agent_id: str, comment_id: str, vote: str,
    ) -> Dict[str, Any]:
        bb = _get_blackboard(session_id)
        bb.vote_comment(agent_id=agent_id, comment_id=comment_id, vote=vote)
        return {"status": "ok"}


class ResolveVotesTool(NexusTool):
    """Resolve votes: promote winners, archive losers."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="resolve_votes",
            description=(
                "Resolve votes on all comments. Comments with score >= min_score "
                "are promoted into the main body (version-aware placement). "
                "Negative-score comments are archived."
            ),
            category=ToolCategory.BLACKBOARD,
            can_auto_execute=False,
            requires_permission=True,
            tags=["#blackboard", "#vote", "#resolve", "#consensus"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        session_id: str, min_score: int = 1,
    ) -> Dict[str, Any]:
        bb = _get_blackboard(session_id)
        promoted = bb.resolve_votes(min_score=min_score)
        return {"status": "ok", "promoted_ids": promoted, "count": len(promoted)}


class QueryKnowledgeGraphTool(NexusTool):
    """Hybrid retrieval from Neo4j knowledge graph."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="query_knowledge_graph",
            description=(
                "Run hybrid retrieval against the Neo4j knowledge graph. "
                "Extracts entities from the query, cross-references with #hashtags, "
                "performs graph traversal, and optional vector search. "
                "Returns a formatted RETRIEVED_CONTEXT string."
            ),
            category=ToolCategory.BLACKBOARD,
            can_auto_execute=True,
            requires_permission=False,
            tags=["#memory", "#graph", "#retrieval", "#neo4j", "#rag"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        query: str, include_vector: bool = True,
    ) -> Dict[str, Any]:
        try:
            from cortex.memory.neo4j_layer import Neo4jMemoryLayer
        except ImportError:
            import sys
            from pathlib import Path
            cortex_root = Path(__file__).resolve().parent.parent.parent  # tools/lib -> nexus-builder -> project root
            if str(cortex_root) not in sys.path:
                sys.path.insert(0, str(cortex_root))
            from cortex.memory.neo4j_layer import Neo4jMemoryLayer
        
        layer = Neo4jMemoryLayer()
        result = await layer.retrieve(query, include_vector=include_vector)
        return {"context": result}


class SyncHashtagsTool(NexusTool):
    """Synchronize #hashtags with Neo4j Entity nodes."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="sync_hashtags",
            description=(
                "Pull Entity nodes from Neo4j and update the local hashtag manifest. "
                "Returns the number of hashtags synced."
            ),
            category=ToolCategory.BLACKBOARD,
            can_auto_execute=True,
            requires_permission=False,
            tags=["#hashtag", "#neo4j", "#sync", "#entity"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
    ) -> Dict[str, Any]:
        try:
            from cortex.memory.client import MemoryClient
        except ImportError:
            import sys
            from pathlib import Path
            cortex_root = Path(__file__).resolve().parent.parent.parent  # tools/lib -> nexus-builder -> project root
            if str(cortex_root) not in sys.path:
                sys.path.insert(0, str(cortex_root))
            from cortex.memory.client import MemoryClient
        
        manager = _get_hashtag_manager()
        client = MemoryClient()
        
        count = await manager.sync_from_graph(client.graphiti.driver)
        return {
            "status": "ok",
            "synced_count": count,
            "total_hashtags": manager.count,
        }

class FactCheckTool(NexusTool):
    """Trigger fact checking on a document against source text."""
    
    @property
    def metadata(self) -> ToolMetadata:
        return ToolMetadata(
            name="fact_check",
            description=(
                "Verify a document's claims against source text. "
                "Checks every sentence for supporting evidence and marks "
                "unverified claims. Returns a FactCheckReport with verdicts."
            ),
            category=ToolCategory.VERIFICATION,
            can_auto_execute=True,
            requires_permission=False,
            tags=["#blackboard", "#verification", "#fact_check", "#research"],
        )
    
    async def execute(
        self, context: Dict[str, Any],
        session_id: str,
        document_content: str,
        doc_type: str = "synthesis",
        source_text: Optional[str] = None,
    ) -> Dict[str, Any]:
        bb = _get_blackboard(session_id)
        bb_state = bb.read_state()
        
        # Use provided source_text or fall back to Blackboard raw content
        actual_source = source_text or bb_state.get("raw", "")
        
        if not actual_source:
            return {
                "status": "skipped",
                "reason": "No source text available",
            }
        
        # Import and run the Cortex fact check agent
        try:
            from cortex.agents.fact_check import fact_check_document
            from cortex.schemas.state import (
                DocumentType, DocumentRef, FactCheckRequest,
            )
        except ImportError:
            import sys
            from pathlib import Path
            cortex_root = Path(__file__).resolve().parent.parent.parent  # tools/lib -> nexus-builder -> project root
            if str(cortex_root) not in sys.path:
                sys.path.insert(0, str(cortex_root))
            from cortex.agents.fact_check import fact_check_document
            from cortex.schemas.state import (
                DocumentType, DocumentRef, FactCheckRequest,
            )
        
        import uuid
        doc = DocumentRef(
            doc_id=str(uuid.uuid4()),
            doc_type=DocumentType(doc_type),
            session_id=session_id,
            content=document_content,
            source_agent="nexus_tool",
        )
        
        # Build minimal state for the agent
        state = {
            "session_id": session_id,
            "fact_check_request": FactCheckRequest(
                document=doc,
                source_text=actual_source,
            ),
            "messages": [],
        }
        
        result = await fact_check_document(state)
        report = result.get("fact_check_report")
        
        if report:
            return {
                "status": "ok",
                "total_sentences": report.total_sentences,
                "supported_count": report.supported_count,
                "unverified_count": report.unverified_count,
                "validated_content": report.validated_content,
            }
        return {"status": "error", "reason": "No report generated"}


def register_tools(registry) -> None:
    """Register all blackboard tools with the ToolRegistry."""
    registry.register(ReadStateTool())
    registry.register(AppendStepTool())
    registry.register(AddCommentTool())
    registry.register(VoteCommentTool())
    registry.register(ResolveVotesTool())
    registry.register(QueryKnowledgeGraphTool())
    registry.register(SyncHashtagsTool())
    registry.register(FactCheckTool())
