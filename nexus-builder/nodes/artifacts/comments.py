"""
Artifact Comments - Inline commenting system for artifact review.

This module provides the data structures and storage for GitHub-style
inline comments on artifacts during human-in-the-loop review.

Supports both database persistence (Supabase) and in-memory fallback.
"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
from datetime import datetime
import uuid


@dataclass
class InlineComment:
    """
    A comment attached to a specific line in an artifact.
    
    Supports threaded replies for discussion during review.
    
    Attributes:
        id: Unique comment identifier
        artifact_id: ID of the artifact this comment belongs to
        line_number: 1-indexed line number (0 = general/file-level comment)
        content: The comment text (markdown supported)
        author: Author identifier (user ID or "system")
        parent_id: ID of parent comment (for replies)
        created_at: Timestamp of creation
        resolved: Whether this comment thread has been resolved
        replies: Nested reply comments (populated in-memory)
    """
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    artifact_id: str = ""
    line_number: int = 0  # 1-indexed, 0 = general/file-level comment
    content: str = ""
    author: str = "user"
    parent_id: Optional[str] = None
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    resolved: bool = False
    replies: List["InlineComment"] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        """Serialize for JSON transport."""
        return {
            "id": self.id,
            "artifact_id": self.artifact_id,
            "line_number": self.line_number,
            "content": self.content,
            "author": self.author,
            "parent_id": self.parent_id,
            "created_at": self.created_at,
            "resolved": self.resolved,
            "replies": [r.to_dict() for r in self.replies],
        }
    
    def to_db_dict(self) -> Dict[str, Any]:
        """Serialize for database storage (no replies, those are separate rows)."""
        return {
            "id": self.id,
            "artifact_id": self.artifact_id,
            "line_number": self.line_number,
            "content": self.content,
            "author": self.author,
            "parent_id": self.parent_id,
            "resolved": self.resolved,
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "InlineComment":
        """Deserialize from JSON or database record."""
        replies_data = data.get("replies", [])
        replies = [cls.from_dict(r) for r in replies_data] if replies_data else []
        
        return cls(
            id=data.get("id", str(uuid.uuid4())),
            artifact_id=data.get("artifact_id", ""),
            line_number=data.get("line_number", 0),
            content=data.get("content", ""),
            author=data.get("author", "user"),
            parent_id=data.get("parent_id"),
            created_at=data.get("created_at", datetime.utcnow().isoformat()),
            resolved=data.get("resolved", False),
            replies=replies,
        )


class CommentStore:
    """
    Comment storage with database persistence and in-memory fallback.
    
    Uses Supabase for persistence when configured, otherwise falls back
    to in-memory storage (useful for development/testing).
    """
    
    def __init__(self, use_db: bool = False):
        """
        Initialize comment store.
        
        Args:
            use_db: Reserved for future database persistence (not currently used)
        """
        self._use_db = use_db
        self._supabase = None
        
        # In-memory storage (comments are ephemeral per-session)
        self._comments: Dict[str, List[InlineComment]] = {}
        self._comment_index: Dict[str, InlineComment] = {}
    
    @property
    def is_persistent(self) -> bool:
        """Check if using database persistence."""
        return self._supabase is not None
    
    # ═══════════════════════════════════════════════════════════════
    # ASYNC DATABASE OPERATIONS
    # ═══════════════════════════════════════════════════════════════
    
    async def add_comment_async(
        self, 
        artifact_id: str, 
        line_number: int, 
        content: str, 
        author: str = "user",
        parent_id: str = None
    ) -> InlineComment:
        """Add a new comment (async, uses database if available)."""
        comment = InlineComment(
            artifact_id=artifact_id,
            line_number=line_number,
            content=content,
            author=author,
            parent_id=parent_id,
        )
        
        if self._supabase:
            try:
                await self._supabase.insert_comment(comment.to_db_dict())
            except Exception as e:
                print(f"[CommentStore] DB insert failed, using memory: {e}")
        
        # Always store in memory for fast access
        self._store_in_memory(comment)
        return comment
    
    async def get_comments_async(self, artifact_id: str) -> List[InlineComment]:
        """Get all comments for an artifact (async, uses database if available)."""
        if self._supabase:
            try:
                db_comments = await self._supabase.get_comments_for_artifact(artifact_id)
                return self._build_comment_tree(db_comments)
            except Exception as e:
                print(f"[CommentStore] DB fetch failed, using memory: {e}")
        
        return self._get_from_memory(artifact_id)
    
    async def resolve_comment_async(self, comment_id: str) -> bool:
        """Mark a comment as resolved (async)."""
        if self._supabase:
            try:
                await self._supabase.update_comment(comment_id, {"resolved": True})
            except Exception as e:
                print(f"[CommentStore] DB update failed: {e}")
        
        # Update in memory
        comment = self._comment_index.get(comment_id)
        if comment:
            comment.resolved = True
            return True
        return False
    
    async def unresolve_comment_async(self, comment_id: str) -> bool:
        """Re-open a resolved comment (async)."""
        if self._supabase:
            try:
                await self._supabase.update_comment(comment_id, {"resolved": False})
            except Exception as e:
                print(f"[CommentStore] DB update failed: {e}")
        
        comment = self._comment_index.get(comment_id)
        if comment:
            comment.resolved = False
            return True
        return False
    
    async def add_reply_async(
        self, 
        comment_id: str, 
        content: str, 
        author: str = "user"
    ) -> Optional[InlineComment]:
        """Add a reply to an existing comment (async)."""
        parent = self._comment_index.get(comment_id)
        if not parent:
            return None
        
        reply = InlineComment(
            artifact_id=parent.artifact_id,
            line_number=parent.line_number,
            content=content,
            author=author,
            parent_id=comment_id,
        )
        
        if self._supabase:
            try:
                await self._supabase.insert_comment(reply.to_db_dict())
            except Exception as e:
                print(f"[CommentStore] DB insert failed: {e}")
        
        parent.replies.append(reply)
        self._comment_index[reply.id] = reply
        return reply
    
    async def delete_comment_async(self, comment_id: str) -> bool:
        """Delete a comment and its replies (async)."""
        if self._supabase:
            try:
                await self._supabase.delete_comment(comment_id)
            except Exception as e:
                print(f"[CommentStore] DB delete failed: {e}")
        
        return self._delete_from_memory(comment_id)
    
    # ═══════════════════════════════════════════════════════════════
    # SYNC OPERATIONS (for backward compatibility)
    # ═══════════════════════════════════════════════════════════════
    
    def add_comment(
        self, 
        artifact_id: str, 
        line_number: int, 
        content: str, 
        author: str = "user"
    ) -> InlineComment:
        """Add a new comment (sync, in-memory only)."""
        comment = InlineComment(
            artifact_id=artifact_id,
            line_number=line_number,
            content=content,
            author=author,
        )
        self._store_in_memory(comment)
        return comment
    
    def get_comments(self, artifact_id: str) -> List[InlineComment]:
        """Get all comments for an artifact (sync, in-memory only)."""
        return self._get_from_memory(artifact_id)
    
    def get_comment(self, comment_id: str) -> Optional[InlineComment]:
        """Get a single comment by ID."""
        return self._comment_index.get(comment_id)
    
    def resolve_comment(self, comment_id: str) -> bool:
        """Mark a comment as resolved (sync)."""
        comment = self._comment_index.get(comment_id)
        if comment:
            comment.resolved = True
            return True
        return False
    
    def unresolve_comment(self, comment_id: str) -> bool:
        """Re-open a resolved comment (sync)."""
        comment = self._comment_index.get(comment_id)
        if comment:
            comment.resolved = False
            return True
        return False
    
    def add_reply(
        self, 
        comment_id: str, 
        content: str, 
        author: str = "user"
    ) -> Optional[InlineComment]:
        """Add a reply to an existing comment (sync)."""
        parent = self._comment_index.get(comment_id)
        if not parent:
            return None
        
        reply = InlineComment(
            artifact_id=parent.artifact_id,
            line_number=parent.line_number,
            content=content,
            author=author,
            parent_id=comment_id,
        )
        
        parent.replies.append(reply)
        self._comment_index[reply.id] = reply
        return reply
    
    def delete_comment(self, comment_id: str) -> bool:
        """Delete a comment and all its replies (sync)."""
        return self._delete_from_memory(comment_id)
    
    def clear_artifact_comments(self, artifact_id: str) -> int:
        """Delete all comments for an artifact."""
        comments = self._comments.get(artifact_id, [])
        count = len(comments)
        
        for comment in comments:
            if comment.id in self._comment_index:
                del self._comment_index[comment.id]
            for reply in comment.replies:
                if reply.id in self._comment_index:
                    del self._comment_index[reply.id]
        
        if artifact_id in self._comments:
            del self._comments[artifact_id]
        
        return count
    
    def get_stats(self) -> Dict[str, Any]:
        """Get storage statistics."""
        total_comments = sum(len(comments) for comments in self._comments.values())
        total_replies = sum(
            sum(len(c.replies) for c in comments) 
            for comments in self._comments.values()
        )
        return {
            "artifact_count": len(self._comments),
            "comment_count": total_comments,
            "reply_count": total_replies,
            "index_size": len(self._comment_index),
            "is_persistent": self.is_persistent,
        }
    
    # ═══════════════════════════════════════════════════════════════
    # INTERNAL HELPERS
    # ═══════════════════════════════════════════════════════════════
    
    def _store_in_memory(self, comment: InlineComment):
        """Store a comment in the in-memory index."""
        if comment.artifact_id not in self._comments:
            self._comments[comment.artifact_id] = []
        
        self._comments[comment.artifact_id].append(comment)
        self._comment_index[comment.id] = comment
    
    def _get_from_memory(self, artifact_id: str) -> List[InlineComment]:
        """Get comments from in-memory storage."""
        comments = self._comments.get(artifact_id, [])
        return sorted(comments, key=lambda c: (c.line_number, c.created_at))
    
    def _delete_from_memory(self, comment_id: str) -> bool:
        """Delete a comment from in-memory storage."""
        comment = self._comment_index.get(comment_id)
        if not comment:
            return False
        
        del self._comment_index[comment_id]
        for reply in comment.replies:
            if reply.id in self._comment_index:
                del self._comment_index[reply.id]
        
        if comment.artifact_id in self._comments:
            self._comments[comment.artifact_id] = [
                c for c in self._comments[comment.artifact_id] 
                if c.id != comment_id
            ]
        
        return True
    
    def _build_comment_tree(self, db_comments: List[Dict]) -> List[InlineComment]:
        """
        Build a tree of comments from flat database records.
        Groups replies under their parent comments.
        """
        comments_by_id: Dict[str, InlineComment] = {}
        root_comments: List[InlineComment] = []
        
        # First pass: create all comment objects
        for db_comment in db_comments:
            comment = InlineComment.from_dict(db_comment)
            comments_by_id[comment.id] = comment
            self._comment_index[comment.id] = comment
        
        # Second pass: build tree structure
        for comment in comments_by_id.values():
            if comment.parent_id and comment.parent_id in comments_by_id:
                parent = comments_by_id[comment.parent_id]
                parent.replies.append(comment)
            else:
                root_comments.append(comment)
        
        # Update in-memory cache
        if root_comments:
            artifact_id = root_comments[0].artifact_id
            self._comments[artifact_id] = root_comments
        
        return sorted(root_comments, key=lambda c: (c.line_number, c.created_at))


# Global instance (singleton pattern)
comment_store = CommentStore()
