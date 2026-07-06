"""
Data models for the Blackboard system.

These models define the structure for:
- Finding: Individual research results from worker agents
- SessionInfo: Metadata about a blackboard session
- SessionStatus: Lifecycle states for sessions
"""
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional
import re
import uuid


@dataclass
class Comment:
    """
    A comment on a blackboard state file.
    
    Comments can target specific lines and track their file version
    so edits that shift line numbers don't break references.
    
    Attributes:
        id: Unique identifier ("c_" + 8-char UUID prefix)
        agent_id: Which agent authored this comment
        content: The comment text
        line_ref: Line number this comment targets (None = general comment)
        version_ref: File version the line_ref applies to
        parent_id: Parent comment ID for threaded replies
        votes: Map of agent_id -> "up"|"down"
        score: Net vote score (up - down)
        timestamp: When the comment was created
        hashtags: Extracted #hashtag references
        promoted: True if content was absorbed into main body
    """
    id: str = field(default_factory=lambda: f"c_{str(uuid.uuid4())[:8]}")
    agent_id: str = ""
    content: str = ""
    line_ref: Optional[int] = None
    version_ref: Optional[int] = None
    parent_id: Optional[str] = None
    votes: Dict[str, str] = field(default_factory=dict)
    score: int = 0
    timestamp: datetime = field(default_factory=datetime.now)
    hashtags: List[str] = field(default_factory=list)
    promoted: bool = False

    def to_markdown(self) -> str:
        """Serialize comment to markdown with HTML comment metadata."""
        parent = self.parent_id or "none"
        line_part = f" line:{self.line_ref}" if self.line_ref is not None else ""
        ver_part = f" version:{self.version_ref}" if self.version_ref is not None else ""
        ref_label = f" @L{self.line_ref}/v{self.version_ref}" if self.line_ref is not None else ""
        
        meta = f"<!-- comment:{self.id} agent:{self.agent_id} parent:{parent} score:{self.score}{ver_part}{line_part} -->"
        
        vote_parts = []
        for agent, vote in self.votes.items():
            emoji = "👍" if vote == "up" else "👎"
            vote_parts.append(f"{emoji} {agent}")
        vote_line = f"\n> {' | '.join(vote_parts)}" if vote_parts else ""
        
        return f"{meta}\n> **{self.agent_id}**{ref_label} ({self.timestamp.isoformat()}): {self.content}{vote_line}"

    @classmethod
    def from_markdown(cls, text: str) -> Optional["Comment"]:
        """Parse a comment from markdown block (metadata line + blockquote)."""
        lines = text.strip().split("\n")
        if not lines or not lines[0].startswith("<!-- comment:"):
            return None
        
        # Parse metadata from HTML comment
        meta_line = lines[0]
        meta_match = re.search(
            r'comment:(\S+)\s+agent:(\S+)\s+parent:(\S+)\s+score:(-?\d+)'
            r'(?:\s+version:(\d+))?(?:\s+line:(\d+))?',
            meta_line
        )
        if not meta_match:
            return None
        
        comment = cls(
            id=meta_match.group(1),
            agent_id=meta_match.group(2),
            parent_id=meta_match.group(3) if meta_match.group(3) != "none" else None,
            score=int(meta_match.group(4)),
            version_ref=int(meta_match.group(5)) if meta_match.group(5) else None,
            line_ref=int(meta_match.group(6)) if meta_match.group(6) else None,
        )
        
        # Parse content from blockquote
        content_lines = [l for l in lines[1:] if l.startswith(">")]
        if content_lines:
            # First line has agent name and content
            first = content_lines[0].lstrip("> ").strip()
            # Strip the **agent** @ref (timestamp): prefix
            content_match = re.search(r'\):\s*(.+)', first)
            if content_match:
                comment.content = content_match.group(1).strip()
            
            # Parse timestamp
            ts_match = re.search(r'\(([^)]+)\)', first)
            if ts_match:
                try:
                    comment.timestamp = datetime.fromisoformat(ts_match.group(1))
                except ValueError:
                    pass
            
            # Parse votes from subsequent lines
            for vote_line in content_lines[1:]:
                clean = vote_line.lstrip("> ").strip()
                for part in clean.split("|"):
                    part = part.strip()
                    if part.startswith("👍"):
                        agent = part.replace("👍", "").strip()
                        comment.votes[agent] = "up"
                    elif part.startswith("👎"):
                        agent = part.replace("👎", "").strip()
                        comment.votes[agent] = "down"
        
        # Extract hashtags
        comment.hashtags = re.findall(r'#\w+', comment.content)
        
        return comment


class SessionStatus(Enum):
    """Lifecycle status of a blackboard session."""
    ACTIVE = "active"           # Research in progress
    SYNTHESIZED = "synthesized" # Dossier compiled, not yet exported
    EXPORTED = "exported"       # Findings sent to Neo4j
    FAILED = "failed"           # Error during processing


@dataclass
class Finding:
    """
    A single research finding from a worker agent.
    
    Attributes:
        id: Unique identifier (8-char UUID prefix)
        worker_id: Which node produced this finding (e.g., "execution_agent")
        tool_name: Tool that generated the content (e.g., "web_search")
        query: The input query/args that produced this finding
        content: The actual finding content (text, markdown)
        tags: Classification tags for filtering
        timestamp: When the finding was captured
        file_path: Absolute path to the .md file (set after write)
    """
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    worker_id: str = ""
    tool_name: str = ""
    query: str = ""
    content: str = ""
    tags: List[str] = field(default_factory=list)
    timestamp: datetime = field(default_factory=datetime.now)
    file_path: Optional[str] = None

    def to_markdown(self) -> str:
        """Serialize finding to markdown with YAML frontmatter."""
        tags_str = str(self.tags)
        # Escape quotes and newlines in query to prevent YAML breakage
        safe_query = self.query.replace('"', '\\"').replace('\n', ' ')[:500]
        return f"""---
id: {self.id}
worker: {self.worker_id}
tool: {self.tool_name}
query: "{safe_query}"
tags: {tags_str}
timestamp: {self.timestamp.isoformat()}
---

{self.content}
"""

    @classmethod
    def from_markdown(cls, content: str, file_path: str = None) -> "Finding":
        """Parse a finding from markdown file content."""
        finding = cls(file_path=file_path)
        
        if not content.startswith("---"):
            finding.content = content
            return finding
        
        parts = content.split("---", 2)
        if len(parts) < 3:
            finding.content = content
            return finding
        
        # Parse YAML frontmatter (simple key: value parsing)
        frontmatter = parts[1].strip()
        for line in frontmatter.split("\n"):
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            key = key.strip()
            value = value.strip().strip('"')
            
            if key == "id":
                finding.id = value
            elif key == "worker":
                finding.worker_id = value
            elif key == "tool":
                finding.tool_name = value
            elif key == "query":
                finding.query = value
            elif key == "tags":
                try:
                    finding.tags = eval(value) if value.startswith("[") else [value]
                except Exception:
                    finding.tags = [value] if value else []
            elif key == "timestamp":
                try:
                    finding.timestamp = datetime.fromisoformat(value)
                except Exception:
                    pass
        
        finding.content = parts[2].strip()
        return finding


@dataclass
class SessionInfo:
    """
    Metadata for a blackboard session.
    
    Stored in metadata.json at session root.
    """
    session_id: str
    topic: str
    status: SessionStatus = SessionStatus.ACTIVE
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    finding_count: int = 0
    
    # Optional linkage to other systems
    cortex_thread_id: Optional[str] = None
    nexus_task_id: Optional[str] = None
    
    # Tracking for duplicate prevention
    processed_tool_call_ids: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Serialize to JSON-compatible dict."""
        return {
            "session_id": self.session_id,
            "topic": self.topic,
            "status": self.status.value,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "finding_count": self.finding_count,
            "cortex_thread_id": self.cortex_thread_id,
            "nexus_task_id": self.nexus_task_id,
            "processed_tool_call_ids": self.processed_tool_call_ids,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SessionInfo":
        """Deserialize from dict."""
        return cls(
            session_id=data["session_id"],
            topic=data["topic"],
            status=SessionStatus(data.get("status", "active")),
            created_at=datetime.fromisoformat(data.get("created_at", datetime.now().isoformat())),
            updated_at=datetime.fromisoformat(data.get("updated_at", datetime.now().isoformat())),
            finding_count=data.get("finding_count", 0),
            cortex_thread_id=data.get("cortex_thread_id"),
            nexus_task_id=data.get("nexus_task_id"),
            processed_tool_call_ids=data.get("processed_tool_call_ids", []),
        )
