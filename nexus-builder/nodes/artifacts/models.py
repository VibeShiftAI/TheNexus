"""
Artifact Models - Universal artifact data structures.

This module defines the core data structures for the Universal Artifact System:
- ArtifactCategory: High-level grouping for UI display
- Artifact: Universal container for any content type
"""

from dataclasses import dataclass, field
from typing import Any, Optional, Dict, List
from datetime import datetime
from enum import Enum
import uuid
import mimetypes
import os


class ArtifactCategory(Enum):
    """
    High-level categories for UI grouping.
    
    These are suggestions, not requirements. Any artifact can use
    CUSTOM category if none of the predefined ones fit.
    """
    DOCUMENT = "document"      # Markdown, text, PDFs, reports
    DATA = "data"              # JSON, YAML, structured data
    CODE = "code"              # Source files, diffs, patches
    MEDIA = "media"            # Images, charts, diagrams
    REFERENCE = "reference"    # Links, external resources
    PLAN = "plan"              # Implementation plans, specs
    RESEARCH = "research"      # Research dossiers, findings
    CUSTOM = "custom"          # User-defined / uncategorized


# Map categories to default MIME types for content type detection
CATEGORY_MIME_MAP = {
    ArtifactCategory.DOCUMENT: "text/markdown",
    ArtifactCategory.DATA: "application/json",
    ArtifactCategory.CODE: "text/x-code",
    ArtifactCategory.MEDIA: "image/png",
    ArtifactCategory.REFERENCE: "text/uri-list",
    ArtifactCategory.PLAN: "text/markdown",
    ArtifactCategory.RESEARCH: "text/markdown",
    ArtifactCategory.CUSTOM: "text/plain",
}

# Map MIME types to file extensions
MIME_EXTENSION_MAP = {
    "text/markdown": ".md",
    "text/plain": ".txt",
    "application/json": ".json",
    "text/x-code": ".txt",
    "text/uri-list": ".txt",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "text/html": ".html",
    "text/css": ".css",
    "application/javascript": ".js",
    "application/typescript": ".ts",
}


@dataclass
class Artifact:
    """
    Universal artifact container.
    
    Can hold any type of content produced by any workflow node.
    Only ONE content field should be set per artifact.
    
    Attributes:
        id: Unique identifier (auto-generated UUID)
        name: Human-readable display name
        key: Machine key for retrieval (e.g., "research_dossier")
        
        content: Text/markdown content
        content_json: Structured data (dict/list)
        content_binary: Binary data (bytes)
        file_path: Reference to file on disk
        
        category: High-level category for UI grouping
        mime_type: MIME type for content rendering
        
        producer_node_id: ID of the node instance that created this
        producer_node_type: Type ID of the node (e.g., "research_scoper")
        workflow_run_id: ID of the workflow execution run
        task_id: Associated task (optional)
        project_id: Associated project (optional)
        
        version: Version number (1-indexed, auto-incremented per key)
        parent_id: ID of previous version (for versioning chain)
        
        created_at: Timestamp of creation
        tags: User-defined tags for filtering
        metadata: Arbitrary key-value metadata
    
    Example:
        >>> artifact = Artifact(
        ...     key="research_dossier",
        ...     name="Research Dossier",
        ...     content="# Research Findings\\n...",
        ...     category=ArtifactCategory.RESEARCH,
        ...     producer_node_type="research_synthesizer"
        ... )
    """
    
    # ─── Identity ────────────────────────────────────────────────────────────
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    key: str = ""
    
    # ─── Content (only ONE should be set) ────────────────────────────────────
    content: Optional[str] = None
    content_json: Optional[Dict[str, Any]] = None
    content_binary: Optional[bytes] = None
    file_path: Optional[str] = None
    
    # ─── Metadata ────────────────────────────────────────────────────────────
    category: ArtifactCategory = ArtifactCategory.CUSTOM
    mime_type: str = ""  # Auto-detected if empty
    file_extension: str = ""  # Auto-detected if empty
    
    # ─── Provenance ──────────────────────────────────────────────────────────
    producer_node_id: str = ""
    producer_node_type: str = ""
    workflow_run_id: str = ""
    task_id: Optional[str] = None
    project_id: Optional[str] = None
    
    # ─── Versioning ──────────────────────────────────────────────────────────
    version: int = 1
    parent_id: Optional[str] = None
    
    # ─── Timestamps ──────────────────────────────────────────────────────────
    created_at: datetime = field(default_factory=datetime.now)
    
    # ─── User-Defined ────────────────────────────────────────────────────────
    tags: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        """Auto-detect mime_type and file_extension if not provided."""
        if not self.mime_type:
            self.mime_type = self._detect_mime_type()
        if not self.file_extension:
            self.file_extension = self._detect_file_extension()
    
    def _detect_mime_type(self) -> str:
        """
        Detect MIME type from content, file_path, or category.
        
        Priority:
        1. File path extension
        2. Binary magic bytes
        3. Content type (JSON detection)
        4. Category default
        """
        # 1. Check file_path extension
        if self.file_path:
            mime, _ = mimetypes.guess_type(self.file_path)
            if mime:
                return mime
        
        # 2. Check binary magic bytes
        if self.content_binary:
            if self.content_binary[:8] == b'\x89PNG\r\n\x1a\n':
                return "image/png"
            if self.content_binary[:2] == b'\xff\xd8':
                return "image/jpeg"
            if self.content_binary[:4] == b'GIF8':
                return "image/gif"
            if self.content_binary[:4] == b'RIFF' and len(self.content_binary) > 11 and self.content_binary[8:12] == b'WEBP':
                return "image/webp"
        
        # 3. Check content_json
        if self.content_json is not None:
            return "application/json"
        
        # 4. Fall back to category default
        return CATEGORY_MIME_MAP.get(self.category, "text/plain")
    
    def _detect_file_extension(self) -> str:
        """
        Detect file extension from file_path or mime_type.
        """
        # 1. Check file_path
        if self.file_path:
            _, ext = os.path.splitext(self.file_path)
            if ext:
                return ext
        
        # 2. Fall back to MIME mapping
        return MIME_EXTENSION_MAP.get(self.mime_type, ".txt")
    
    def get_content(self) -> Any:
        """
        Returns the content in its native form.
        
        Prefers: content_json > content > file_path
        """
        if self.content_json is not None:
            return self.content_json
        if self.content is not None:
            return self.content
        if self.file_path is not None:
            return f"[File: {self.file_path}]"
        if self.content_binary is not None:
            return f"[Binary: {len(self.content_binary)} bytes]"
        return None
    
    def get_preview(self, max_length: int = 200) -> str:
        """Get a truncated preview of the content for UI display."""
        content = self.get_content()
        if content is None:
            return "[Empty]"
        
        if isinstance(content, dict) or isinstance(content, list):
            import json
            preview = json.dumps(content, indent=2)
        else:
            preview = str(content)
        
        if len(preview) > max_length:
            return preview[:max_length] + "..."
        return preview
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Serialize for JSON transport.
        
        Binary content is excluded (too large for JSON).
        """
        return {
            "id": self.id,
            "name": self.name,
            "key": self.key,
            "content": self.content,
            "content_json": self.content_json,
            "file_path": self.file_path,
            "has_binary": self.content_binary is not None,
            "category": self.category.value,
            "mime_type": self.mime_type,
            "file_extension": self.file_extension,
            "producer_node_id": self.producer_node_id,
            "producer_node_type": self.producer_node_type,
            "workflow_run_id": self.workflow_run_id,
            "task_id": self.task_id,
            "project_id": self.project_id,
            "version": self.version,
            "parent_id": self.parent_id,
            "created_at": self.created_at.isoformat(),
            "tags": self.tags,
            "metadata": self.metadata,
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Artifact":
        """Deserialize from JSON."""
        # Handle category enum
        category = data.get("category", "custom")
        if isinstance(category, str):
            category = ArtifactCategory(category)
        
        # Handle datetime
        created_at = data.get("created_at")
        if isinstance(created_at, str):
            created_at = datetime.fromisoformat(created_at)
        elif created_at is None:
            created_at = datetime.now()
        
        return cls(
            id=data.get("id", str(uuid.uuid4())),
            name=data.get("name", ""),
            key=data.get("key", ""),
            content=data.get("content"),
            content_json=data.get("content_json"),
            file_path=data.get("file_path"),
            category=category,
            mime_type=data.get("mime_type", ""),  # Empty triggers auto-detection
            file_extension=data.get("file_extension", ""),  # Empty triggers auto-detection
            producer_node_id=data.get("producer_node_id", ""),
            producer_node_type=data.get("producer_node_type", ""),
            workflow_run_id=data.get("workflow_run_id", ""),
            task_id=data.get("task_id"),
            project_id=data.get("project_id"),
            version=data.get("version", 1),
            parent_id=data.get("parent_id"),
            created_at=created_at,
            tags=data.get("tags", []),
            metadata=data.get("metadata", {}),
        )
