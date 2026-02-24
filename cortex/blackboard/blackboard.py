"""
Core Blackboard implementation with thread-safe operations.

The Blackboard provides:
- Session management (create, cache, list)
- Plan writing and reading
- Finding submission with deduplication
- Synthesis compilation
- Full context retrieval for LLM consumption
"""
import json
import logging
import os
import platform
import re
import shutil
import threading
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .models import Comment, Finding, SessionInfo, SessionStatus

logger = logging.getLogger("Blackboard")

# Path resolution: blackboard.py is at TheNexus/cortex/blackboard/blackboard.py
# Go up 2 levels to TheNexus root, then into data/blackboard
_MODULE_DIR = Path(__file__).resolve().parent  # .../cortex/blackboard/
_NEXUS_ROOT = _MODULE_DIR.parent.parent  # .../TheNexus/

BLACKBOARD_ROOT = Path(os.getenv(
    "BLACKBOARD_ROOT", 
    _NEXUS_ROOT / "data" / "blackboard"
))


class Blackboard:
    """
    Shared knowledge space for multi-agent research coordination.
    
    Thread-safe via per-instance RLock and process-wide singleton cache.
    
    Usage:
        bb = Blackboard.get_or_create("session-123", topic="Neo4j Research")
        bb.write_plan("# Research Plan\\n...")
        bb.submit_finding(
            worker_id="execution_agent",
            tool_name="web_search",
            query="neo4j cypher tutorial",
            content="Found documentation at...",
            tool_call_id="call_abc123"  # For deduplication
        )
        context = bb.get_full_context()
        bb.write_synthesis(final_dossier)
    """
    
    # Process-level singleton cache
    _instances: Dict[str, "Blackboard"] = {}
    _global_lock = threading.Lock()
    
    def __init__(self, session_id: str, topic: str = ""):
        """
        Initialize a Blackboard instance.
        
        NOTE: Use get_or_create() instead of direct instantiation.
        """
        self.session_id = session_id
        self.topic = topic
        self.session_dir = BLACKBOARD_ROOT / session_id
        self.lock = threading.RLock()
        self._metadata: Optional[SessionInfo] = None
    
    # ═══════════════════════════════════════════════════════════════════════
    # FACTORY & LIFECYCLE
    # ═══════════════════════════════════════════════════════════════════════
    
    @classmethod
    def get_or_create(cls, session_id: str, topic: str = "") -> "Blackboard":
        """
        Get existing session or create new one.
        
        Thread-safe. Returns same instance for same session_id within process.
        """
        with cls._global_lock:
            if session_id in cls._instances:
                return cls._instances[session_id]
            
            instance = cls(session_id, topic)
            instance._ensure_initialized()
            cls._instances[session_id] = instance
            return instance
    
    @classmethod
    def list_sessions(cls, base_dir: Path = None) -> List[SessionInfo]:
        """List all sessions for discovery/catch-up."""
        base = base_dir or BLACKBOARD_ROOT
        sessions = []
        
        if not base.exists():
            return sessions
        
        for session_dir in base.iterdir():
            if not session_dir.is_dir():
                continue
            meta_path = session_dir / "metadata.json"
            if meta_path.exists():
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        sessions.append(SessionInfo.from_dict(json.load(f)))
                except Exception:
                    pass
        
        return sorted(sessions, key=lambda s: s.updated_at, reverse=True)
    
    @classmethod
    def clear_cache(cls):
        """Clear the instance cache. Primarily for testing."""
        with cls._global_lock:
            cls._instances.clear()
    
    def _ensure_initialized(self):
        """Create session directory and metadata if not exists."""
        with self.lock:
            if self.session_dir.exists():
                self._load_metadata()
            else:
                self.session_dir.mkdir(parents=True, exist_ok=True)
                (self.session_dir / "findings").mkdir(exist_ok=True)
                (self.session_dir / "state_versions").mkdir(exist_ok=True)
                self._metadata = SessionInfo(
                    session_id=self.session_id,
                    topic=self.topic
                )
                self._save_metadata()
                self._init_state_file()
    
    def _load_metadata(self):
        """Load session metadata from disk."""
        meta_path = self.session_dir / "metadata.json"
        if meta_path.exists():
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    self._metadata = SessionInfo.from_dict(json.load(f))
                # Update topic if provided and different
                if self.topic and self.topic != self._metadata.topic:
                    self._metadata.topic = self.topic
                    self._save_metadata()
            except Exception:
                # Fallback if corrupt
                self._metadata = SessionInfo(session_id=self.session_id, topic=self.topic)
                self._save_metadata()
    
    def _save_metadata(self):
        """Persist session metadata to disk."""
        if not self._metadata:
            return
        self._metadata.updated_at = datetime.now()
        meta_path = self.session_dir / "metadata.json"
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(self._metadata.to_dict(), f, indent=2)
    
    # ═══════════════════════════════════════════════════════════════════════
    # PLAN OPERATIONS
    # ═══════════════════════════════════════════════════════════════════════
    
    def write_plan(self, content: str, metadata: dict = None) -> str:
        """
        Write or update the research plan.
        
        Args:
            content: Plan content (markdown)
            metadata: Optional key-value pairs for frontmatter
            
        Returns:
            Absolute path to plan.md
        """
        with self.lock:
            plan_path = self.session_dir / "plan.md"
            
            header = f"""---
session_id: {self.session_id}
topic: {self.topic}
created_at: {self._metadata.created_at.isoformat() if self._metadata else datetime.now().isoformat()}
updated_at: {datetime.now().isoformat()}
"""
            if metadata:
                for k, v in metadata.items():
                    header += f"{k}: {v}\n"
            header += "---\n\n"
            
            with open(plan_path, "w", encoding="utf-8") as f:
                f.write(header + content)
            
            self._save_metadata()
            return str(plan_path)
    
    def read_plan(self) -> Optional[str]:
        """
        Read the current research plan (content only, no frontmatter).
        
        Returns:
            Plan content or None if not exists
        """
        plan_path = self.session_dir / "plan.md"
        if not plan_path.exists():
            return None
        
        with open(plan_path, "r", encoding="utf-8") as f:
            content = f.read()
        
        # Strip YAML frontmatter
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                return parts[2].strip()
        return content
    
    # ═══════════════════════════════════════════════════════════════════════
    # FINDINGS OPERATIONS
    # ═══════════════════════════════════════════════════════════════════════
    
    def submit_finding(
        self,
        worker_id: str,
        content: str,
        tool_name: str = "",
        query: str = "",
        tags: List[str] = None,
        tool_call_id: str = None,
    ) -> Optional[Finding]:
        """
        Submit a finding from a worker agent.
        
        Args:
            worker_id: Identifier of the worker/node
            content: Finding content
            tool_name: Name of the tool that produced this
            query: The input query/arguments used
            tags: Classification tags
            tool_call_id: LangGraph tool call ID for deduplication
            
        Returns:
            The created Finding, or None if duplicate (already processed)
        """
        with self.lock:
            # Deduplication check
            if tool_call_id and tool_call_id in self._metadata.processed_tool_call_ids:
                return None
            
            finding = Finding(
                worker_id=worker_id,
                tool_name=tool_name,
                query=query,
                content=content,
                tags=tags or []
            )
            
            # Update counter and generate filename
            self._metadata.finding_count += 1
            idx = self._metadata.finding_count
            
            # Robust sanitization for Windows paths - remove illegal chars
            safe_tool = re.sub(r'[<>:"/\\|?*]', '_', tool_name or "finding")
            filename = f"{idx:03d}_{safe_tool}_{finding.id}.md"
            file_path = self.session_dir / "findings" / filename
            
            # Write file
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(finding.to_markdown())
            finding.file_path = str(file_path)
            
            # Track for deduplication
            if tool_call_id:
                self._metadata.processed_tool_call_ids.append(tool_call_id)
            
            self._save_metadata()
            return finding
    
    def get_findings(
        self, 
        worker_id: str = None, 
        tool_name: str = None
    ) -> List[Finding]:
        """
        Get all findings, optionally filtered.
        
        Args:
            worker_id: Filter by worker
            tool_name: Filter by tool
            
        Returns:
            List of Finding objects, sorted by filename (creation order)
        """
        findings_dir = self.session_dir / "findings"
        findings = []
        
        if not findings_dir.exists():
            return findings
        
        for file_path in sorted(findings_dir.glob("*.md")):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    finding = Finding.from_markdown(f.read(), str(file_path))
                
                # Apply filters
                if worker_id and finding.worker_id != worker_id:
                    continue
                if tool_name and finding.tool_name != tool_name:
                    continue
                
                findings.append(finding)
            except Exception:
                # Skip corrupt files
                continue
        
        return findings
    
    # ═══════════════════════════════════════════════════════════════════════
    # SYNTHESIS OPERATIONS
    # ═══════════════════════════════════════════════════════════════════════
    
    def get_full_context(self) -> str:
        """
        Get complete context for synthesis: plan + all findings.
        
        Returns:
            Formatted markdown string suitable for LLM consumption
        """
        parts = []
        
        # Plan
        plan = self.read_plan()
        if plan:
            parts.append(f"# RESEARCH PLAN\n\n{plan}")
        
        # Findings
        findings = self.get_findings()
        if findings:
            parts.append("\n\n---\n\n# RESEARCH FINDINGS\n")
            for f in findings:
                # Truncate long queries in headers
                query_preview = f.query[:100] + "..." if len(f.query) > 100 else f.query
                parts.append(f"\n## [{f.tool_name}] {query_preview}\n\n{f.content}")
        
        return "\n".join(parts)
    
    def write_synthesis(self, content: str) -> str:
        """
        Write the final synthesis document.
        
        Args:
            content: Synthesis content (markdown)
            
        Returns:
            Absolute path to synthesis.md
        """
        with self.lock:
            synth_path = self.session_dir / "synthesis.md"
            
            header = f"""---
session_id: {self.session_id}
topic: {self.topic}
synthesized_at: {datetime.now().isoformat()}
finding_count: {self._metadata.finding_count}
---

"""
            with open(synth_path, "w", encoding="utf-8") as f:
                f.write(header + content)
            
            self._metadata.status = SessionStatus.SYNTHESIZED
            self._save_metadata()
            return str(synth_path)
    
    def read_synthesis(self) -> Optional[str]:
        """Read the synthesis document (content only)."""
        synth_path = self.session_dir / "synthesis.md"
        if not synth_path.exists():
            return None
        
        with open(synth_path, "r", encoding="utf-8") as f:
            content = f.read()
        
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                return parts[2].strip()
        return content
    
    # ═══════════════════════════════════════════════════════════════════════
    # LIVE STATE MANAGEMENT
    # ═══════════════════════════════════════════════════════════════════════

    # --- Cross-platform file locking ---

    @staticmethod
    def _lock_file(fh):
        """Acquire an exclusive file lock (msvcrt on Windows, fcntl on Unix)."""
        if platform.system() == "Windows":
            import msvcrt
            msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)

    @staticmethod
    def _unlock_file(fh):
        """Release an exclusive file lock."""
        if platform.system() == "Windows":
            import msvcrt
            try:
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass  # Already unlocked
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    # --- Line numbering helpers ---

    @staticmethod
    def _add_line_numbers(text: str) -> str:
        """Add 3-digit zero-padded line numbers to text."""
        lines = text.split("\n")
        numbered = []
        for i, line in enumerate(lines, 1):
            numbered.append(f"{i:03d}: {line}")
        return "\n".join(numbered)

    @staticmethod
    def _strip_line_numbers(text: str) -> Tuple[str, Dict[int, str]]:
        """
        Strip line numbers from text.
        
        Returns:
            Tuple of (clean_text, line_map) where line_map maps
            line_num -> original content at that line.
        """
        lines = text.split("\n")
        clean_lines = []
        line_map = {}
        for line in lines:
            match = re.match(r'^(\d{3}): (.*)$', line)
            if match:
                num = int(match.group(1))
                content = match.group(2)
                line_map[num] = content
                clean_lines.append(content)
            else:
                clean_lines.append(line)
        return "\n".join(clean_lines), line_map

    # --- Version management ---

    def _get_state_version(self) -> int:
        """Read current version from state.md frontmatter."""
        state_path = self.session_dir / "state.md"
        if not state_path.exists():
            return 0
        with open(state_path, "r", encoding="utf-8") as f:
            first_line = f.readline().strip()
        match = re.match(r'^<!-- version:(\d+) -->$', first_line)
        return int(match.group(1)) if match else 0

    def _save_version_snapshot(self, version: int):
        """Save a copy of the current state.md as a version snapshot."""
        state_path = self.session_dir / "state.md"
        versions_dir = self.session_dir / "state_versions"
        versions_dir.mkdir(exist_ok=True)
        dest = versions_dir / f"v{version}.md"
        if state_path.exists():
            shutil.copy2(str(state_path), str(dest))

    def _get_version_snapshot(self, version: int) -> Optional[str]:
        """Read a specific version snapshot."""
        snap = self.session_dir / "state_versions" / f"v{version}.md"
        if snap.exists():
            with open(snap, "r", encoding="utf-8") as f:
                return f.read()
        return None

    def _write_state_raw(self, content: str, new_version: int):
        """
        Write state.md with version header and line numbers.
        
        Saves current state as a version snapshot before overwriting.
        """
        state_path = self.session_dir / "state.md"
        
        # Snapshot current version before overwrite
        current_version = self._get_state_version()
        if current_version > 0 and state_path.exists():
            self._save_version_snapshot(current_version)
        
        # Write new content with version header and line numbers
        numbered = self._add_line_numbers(content)
        full = f"<!-- version:{new_version} -->\n{numbered}"
        
        with open(state_path, "w", encoding="utf-8") as fh:
            self._lock_file(fh)
            try:
                fh.write(full)
            finally:
                self._unlock_file(fh)

    # --- State.md template ---

    def _init_state_file(self):
        """Create initial state.md with default sections."""
        template = f"""## User_Query


## Plan


## Notes


## Comments
"""
        self._write_state_raw(template, new_version=1)

    # --- Public API ---

    def read_state(self) -> dict:
        """
        Parse state.md into a structured dict.
        
        Returns dict with:
            - Section keys (e.g. "User_Query", "Plan", "Notes")
            - "Plan" key is a List[str] of bullet items
            - Other sections are plain strings
            - "version": int — current file version
            - "line_map": Dict[int, str] — line_num -> content
            - "hashtags": List[str] — all #hashtags found
            - "comments": List[Comment] — parsed comments
            - "raw": str — the raw file content with line numbers intact
        """
        state_path = self.session_dir / "state.md"
        if not state_path.exists():
            return {"version": 0, "line_map": {}, "hashtags": [], "comments": [], "raw": ""}
        
        with open(state_path, "r", encoding="utf-8") as fh:
            self._lock_file(fh)
            try:
                raw = fh.read()
            finally:
                self._unlock_file(fh)
        
        # Extract version header
        lines = raw.split("\n")
        version = 0
        if lines and lines[0].startswith("<!-- version:"):
            match = re.match(r'^<!-- version:(\d+) -->$', lines[0])
            if match:
                version = int(match.group(1))
            lines = lines[1:]  # Remove version line
        
        # Strip line numbers
        body = "\n".join(lines)
        clean_text, line_map = self._strip_line_numbers(body)
        
        # Parse sections
        result: Dict = {"version": version, "line_map": line_map, "hashtags": [], "comments": [], "raw": raw}
        current_section = None
        current_content: List[str] = []
        comment_blocks: List[str] = []
        in_comments = False
        current_comment_block = []
        
        for line in clean_text.split("\n"):
            header_match = re.match(r'^## (.+)$', line)
            if header_match:
                # Save previous section
                if current_section and current_section != "Comments":
                    section_text = "\n".join(current_content).strip()
                    if current_section == "Plan":
                        # Parse bullet items
                        items = [l.lstrip("- ").strip() for l in section_text.split("\n") if l.strip().startswith("- ")]
                        result[current_section] = items
                    else:
                        result[current_section] = section_text
                elif in_comments and current_comment_block:
                    comment_blocks.append("\n".join(current_comment_block))
                    current_comment_block = []
                
                current_section = header_match.group(1).strip()
                current_content = []
                in_comments = (current_section == "Comments")
                continue
            
            if in_comments:
                if line.startswith("<!-- comment:"):
                    # Start of a new comment block
                    if current_comment_block:
                        comment_blocks.append("\n".join(current_comment_block))
                    current_comment_block = [line]
                elif current_comment_block:
                    current_comment_block.append(line)
            else:
                current_content.append(line)
        
        # Save last section
        if current_section and current_section != "Comments":
            section_text = "\n".join(current_content).strip()
            if current_section == "Plan":
                items = [l.lstrip("- ").strip() for l in section_text.split("\n") if l.strip().startswith("- ")]
                result[current_section] = items
            else:
                result[current_section] = section_text
        if current_comment_block:
            comment_blocks.append("\n".join(current_comment_block))
        
        # Parse comments
        for block in comment_blocks:
            comment = Comment.from_markdown(block)
            if comment:
                result["comments"].append(comment)
        
        # Extract all hashtags from the entire text
        result["hashtags"] = list(set(re.findall(r'#\w+', clean_text)))
        
        return result

    def append_step(self, agent_id: str, content: str):
        """
        Append a timestamped agent entry to state.md.
        
        Re-numbers all lines and increments the file version.
        
        Args:
            agent_id: Identifier of the agent appending
            content: Content to append
        """
        with self.lock:
            state_path = self.session_dir / "state.md"
            current_version = self._get_state_version()
            
            # Read current content (stripping version header and line numbers)
            if state_path.exists():
                with open(state_path, "r", encoding="utf-8") as f:
                    raw = f.read()
                lines = raw.split("\n")
                if lines and lines[0].startswith("<!-- version:"):
                    lines = lines[1:]
                body = "\n".join(lines)
                clean, _ = self._strip_line_numbers(body)
            else:
                clean = ""
            
            # Find insertion point (before ## Comments)
            timestamp = datetime.now().isoformat()
            entry = f"\n## [{timestamp}] {agent_id}\n{content}\n"
            
            comments_idx = clean.find("## Comments")
            if comments_idx >= 0:
                clean = clean[:comments_idx] + entry + clean[comments_idx:]
            else:
                clean += entry
            
            new_version = current_version + 1
            self._write_state_raw(clean, new_version)
            self._save_metadata()

    def add_comment(
        self,
        agent_id: str,
        content: str,
        line_ref: Optional[int] = None,
        parent_id: Optional[str] = None,
    ) -> str:
        """
        Add a comment to state.md.
        
        Args:
            agent_id: The commenting agent's ID
            content: Comment text
            line_ref: Target line number (from current version)
            parent_id: Parent comment ID for threaded replies
            
        Returns:
            The new comment's ID
        """
        with self.lock:
            current_version = self._get_state_version()
            
            comment = Comment(
                agent_id=agent_id,
                content=content,
                line_ref=line_ref,
                version_ref=current_version if line_ref is not None else None,
                parent_id=parent_id,
                hashtags=re.findall(r'#\w+', content),
            )
            
            # Read current state.md
            state_path = self.session_dir / "state.md"
            if not state_path.exists():
                self._init_state_file()
            
            with open(state_path, "r", encoding="utf-8") as f:
                raw = f.read()
            
            # Strip version header and line numbers for editing
            lines = raw.split("\n")
            if lines and lines[0].startswith("<!-- version:"):
                lines = lines[1:]
            body = "\n".join(lines)
            clean, _ = self._strip_line_numbers(body)
            
            # Append comment to ## Comments section
            comment_md = comment.to_markdown()
            
            comments_idx = clean.find("## Comments")
            if comments_idx >= 0:
                # Find end of ## Comments header line
                header_end = clean.find("\n", comments_idx)
                if header_end < 0:
                    header_end = len(clean)
                # Insert after header
                after_header = clean[header_end:]
                clean = clean[:header_end] + "\n" + comment_md + after_header
            else:
                clean += f"\n## Comments\n{comment_md}\n"
            
            # Write back (same version — comments don't bump version)
            self._write_state_raw(clean, current_version)
            logger.info(f"Comment {comment.id} added by {agent_id}")
            return comment.id

    def vote_comment(self, agent_id: str, comment_id: str, vote: str):
        """
        Vote on a comment. One vote per agent per comment.
        
        Args:
            agent_id: Voter agent ID
            comment_id: Target comment ID
            vote: "up" or "down"
        """
        if vote not in ("up", "down"):
            raise ValueError(f"Vote must be 'up' or 'down', got '{vote}'")
        
        with self.lock:
            state = self.read_state()
            comments: List[Comment] = state.get("comments", [])
            
            target = None
            for c in comments:
                if c.id == comment_id:
                    target = c
                    break
            
            if not target:
                raise ValueError(f"Comment {comment_id} not found")
            
            target.votes[agent_id] = vote
            target.score = sum(1 if v == "up" else -1 for v in target.votes.values())
            
            # Rebuild state.md with updated comment
            self._rebuild_state_with_comments(state, comments)

    def resolve_votes(self, min_score: int = 1) -> List[str]:
        """
        Resolve votes: promote winning comments into main content.
        
        Comments with score >= min_score get promoted. Their content
        is applied to the target location (version-aware). Losers
        are moved to ## Archived Comments.
        
        Args:
            min_score: Minimum score for promotion
            
        Returns:
            List of promoted comment IDs
        """
        with self.lock:
            state = self.read_state()
            comments: List[Comment] = state.get("comments", [])
            current_version = state.get("version", 0)
            promoted_ids = []
            remaining = []
            archived = []
            
            for comment in comments:
                if comment.promoted:
                    remaining.append(comment)
                    continue
                
                if comment.score >= min_score:
                    comment.promoted = True
                    promoted_ids.append(comment.id)
                    archived.append(comment)
                    logger.info(f"Promoting comment {comment.id} (score={comment.score})")
                elif comment.score < 0:
                    # Negative score — archive without promotion
                    archived.append(comment)
                    logger.info(f"Archiving rejected comment {comment.id} (score={comment.score})")
                else:
                    remaining.append(comment)
            
            if not promoted_ids and not archived:
                return []
            
            # Rebuild state: apply promoted content, update comments
            state_path = self.session_dir / "state.md"
            with open(state_path, "r", encoding="utf-8") as f:
                raw = f.read()
            
            lines = raw.split("\n")
            if lines and lines[0].startswith("<!-- version:"):
                lines = lines[1:]
            body = "\n".join(lines)
            clean, _ = self._strip_line_numbers(body)
            
            # Apply promoted comments to content using version-aware resolution
            for comment in [c for c in archived if c.promoted]:
                clean = self._apply_comment_to_content(
                    clean, comment, current_version
                )
            
            # Rebuild comments section with remaining + archived
            clean = self._strip_comments_section(clean)
            
            # Add remaining comments
            if remaining:
                clean += "\n## Comments\n"
                for c in remaining:
                    clean += c.to_markdown() + "\n"
            else:
                clean += "\n## Comments\n"
            
            # Add archived section if needed
            if archived:
                clean += "\n## Archived Comments\n"
                for c in archived:
                    status = "✅ PROMOTED" if c.promoted else "❌ REJECTED"
                    clean += f"<!-- {status} -->\n{c.to_markdown()}\n"
            
            new_version = current_version + 1
            self._write_state_raw(clean, new_version)
            self._save_metadata()
            return promoted_ids

    # --- Internal helpers for voting ---

    def _rebuild_state_with_comments(self, state: dict, comments: List[Comment]):
        """Rebuild state.md with updated comments (e.g., after vote change)."""
        state_path = self.session_dir / "state.md"
        with open(state_path, "r", encoding="utf-8") as f:
            raw = f.read()
        
        lines = raw.split("\n")
        version = self._get_state_version()
        if lines and lines[0].startswith("<!-- version:"):
            lines = lines[1:]
        body = "\n".join(lines)
        clean, _ = self._strip_line_numbers(body)
        
        # Strip existing comments section and rebuild
        clean = self._strip_comments_section(clean)
        clean += "\n## Comments\n"
        for c in comments:
            clean += c.to_markdown() + "\n"
        
        self._write_state_raw(clean, version)

    @staticmethod
    def _strip_comments_section(text: str) -> str:
        """Remove ## Comments and ## Archived Comments sections from text."""
        result_lines = []
        skip = False
        for line in text.split("\n"):
            if re.match(r'^## (Comments|Archived Comments)', line):
                skip = True
                continue
            if skip and re.match(r'^## ', line):
                skip = False
            if not skip:
                result_lines.append(line)
        return "\n".join(result_lines).rstrip()

    def _apply_comment_to_content(
        self, content: str, comment: Comment, current_version: int
    ) -> str:
        """
        Apply a promoted comment's content at the correct location.
        
        Uses version-aware line resolution: looks up the snapshot at
        comment.version_ref, finds the original line content, then
        fuzzy-matches it in the current content for correct placement.
        """
        if comment.line_ref is None:
            # General comment — append as a note
            notes_idx = content.find("## Notes")
            if notes_idx >= 0:
                header_end = content.find("\n", notes_idx)
                if header_end < 0:
                    header_end = len(content)
                insert_point = header_end
                content = (
                    content[:insert_point]
                    + f"\n[{comment.agent_id}]: {comment.content}"
                    + content[insert_point:]
                )
            return content
        
        # Version-aware line resolution
        target_line_content = None
        if comment.version_ref and comment.version_ref != current_version:
            snapshot = self._get_version_snapshot(comment.version_ref)
            if snapshot:
                _, snap_line_map = self._strip_line_numbers(snapshot)
                # Strip version header from snapshot
                snap_lines = snapshot.split("\n")
                if snap_lines and snap_lines[0].startswith("<!-- version:"):
                    snap_lines = snap_lines[1:]
                _, snap_line_map = self._strip_line_numbers("\n".join(snap_lines))
                target_line_content = snap_line_map.get(comment.line_ref)
        else:
            # Same version — direct lookup
            _, current_line_map = self._strip_line_numbers(content)
            target_line_content = current_line_map.get(comment.line_ref)
        
        if not target_line_content:
            # Fallback: append to Notes
            logger.warning(f"Could not resolve line {comment.line_ref}/v{comment.version_ref}")
            return content
        
        # Fuzzy match target_line_content in current content
        content_lines = content.split("\n")
        best_idx = -1
        best_ratio = 0.0
        for i, line in enumerate(content_lines):
            ratio = SequenceMatcher(None, target_line_content.strip(), line.strip()).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_idx = i
        
        if best_ratio >= 0.6 and best_idx >= 0:
            # Insert promoted content after the matched line
            content_lines.insert(
                best_idx + 1,
                f"[{comment.agent_id}]: {comment.content}"
            )
            return "\n".join(content_lines)
        
        logger.warning(
            f"Fuzzy match failed for comment {comment.id} "
            f"(best ratio={best_ratio:.2f})"
        )
        return content

    # ═══════════════════════════════════════════════════════════════════════
    # PROPERTIES
    # ═══════════════════════════════════════════════════════════════════════
    
    @property
    def metadata(self) -> SessionInfo:
        """Get session metadata."""
        return self._metadata
    
    @property 
    def finding_count(self) -> int:
        """Get current finding count."""
        return self._metadata.finding_count if self._metadata else 0
