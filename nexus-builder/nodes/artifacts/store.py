"""
Artifact Store - Central registry for workflow artifacts.

Provides thread-safe storage with:
- CRUD operations
- Versioning (same key → auto-increment version)
- Query/discovery capabilities
- Backward compatibility with state["outputs"] pattern
"""

from typing import Dict, List, Optional, Any
import threading

from .models import Artifact, ArtifactCategory


class ArtifactStore:
    """
    Central artifact registry for a workflow execution.
    
    Thread-safe storage with query capabilities.
    Can be backed by memory (default) or external store.
    
    Usage:
        >>> store = ArtifactStore(workflow_run_id="run-123")
        >>> store.store_simple("dossier", "# Research...", category=ArtifactCategory.RESEARCH)
        >>> doc = store.get_by_key("dossier")
        >>> print(doc.content)
    """
    
    def __init__(self, workflow_run_id: str = "", task_id: str = "", project_id: str = ""):
        """
        Initialize an artifact store.
        
        Args:
            workflow_run_id: ID of the workflow execution run
            task_id: Optional task ID for all artifacts
            project_id: Optional project ID for all artifacts
        """
        self.workflow_run_id = workflow_run_id
        self.task_id = task_id
        self.project_id = project_id
        
        self._artifacts: Dict[str, Artifact] = {}  # id -> Artifact
        self._by_key: Dict[str, List[str]] = {}    # key -> [ids] (versions)
        self._lock = threading.Lock()
    
    # ═══════════════════════════════════════════════════════════════════════
    # WRITE OPERATIONS
    # ═══════════════════════════════════════════════════════════════════════
    
    def store(self, artifact: Artifact) -> Artifact:
        """
        Store an artifact. Returns the stored artifact with generated ID.
        
        If an artifact with the same key exists, this creates a new version.
        """
        with self._lock:
            # Auto-set context if not set
            if not artifact.workflow_run_id:
                artifact.workflow_run_id = self.workflow_run_id
            if not artifact.task_id and self.task_id:
                artifact.task_id = self.task_id
            if not artifact.project_id and self.project_id:
                artifact.project_id = self.project_id
            
            # Handle versioning
            existing_ids = self._by_key.get(artifact.key, [])
            if existing_ids:
                artifact.version = len(existing_ids) + 1
                artifact.parent_id = existing_ids[-1]
            
            # Store
            self._artifacts[artifact.id] = artifact
            
            # Index by key
            if artifact.key not in self._by_key:
                self._by_key[artifact.key] = []
            self._by_key[artifact.key].append(artifact.id)
            
            return artifact
    
    def store_simple(
        self,
        key: str,
        content: Any,
        name: str = "",
        category: ArtifactCategory = ArtifactCategory.CUSTOM,
        producer_node_id: str = "",
        producer_node_type: str = "",
        tags: Optional[List[str]] = None,
        **metadata
    ) -> Artifact:
        """
        Convenience method to store content without building Artifact manually.
        
        Automatically detects content type (str vs dict vs bytes).
        
        Args:
            key: Machine key for retrieval
            content: The content (str, dict, list, or bytes)
            name: Human-readable name (defaults to formatted key)
            category: ArtifactCategory for grouping
            producer_node_id: ID of producing node
            producer_node_type: Type of producing node
            tags: Optional list of tags
            **metadata: Additional key-value metadata
        
        Returns:
            The stored Artifact with generated ID
        """
        artifact = Artifact(
            key=key,
            name=name or key.replace("_", " ").title(),
            category=category,
            producer_node_id=producer_node_id,
            producer_node_type=producer_node_type,
            tags=tags or [],
            metadata=metadata,
        )
        
        # Auto-detect content type
        if isinstance(content, dict) or isinstance(content, list):
            artifact.content_json = content
            artifact.mime_type = "application/json"
        elif isinstance(content, bytes):
            artifact.content_binary = content
            artifact.mime_type = "application/octet-stream"
        elif isinstance(content, str):
            artifact.content = content
            # Guess markdown vs plain text
            artifact.mime_type = "text/markdown" if content.strip().startswith("#") else "text/plain"
        else:
            # Fallback: convert to string
            artifact.content = str(content)
            artifact.mime_type = "text/plain"
        
        return self.store(artifact)
    
    # ═══════════════════════════════════════════════════════════════════════
    # READ OPERATIONS
    # ═══════════════════════════════════════════════════════════════════════
    
    def get(self, artifact_id: str) -> Optional[Artifact]:
        """Get artifact by ID."""
        return self._artifacts.get(artifact_id)
    
    def get_by_key(self, key: str, version: int = -1) -> Optional[Artifact]:
        """
        Get artifact by key.
        
        Args:
            key: The artifact key
            version: Version number (1-indexed), or -1 for latest
            
        Returns:
            Artifact or None if not found
        """
        ids = self._by_key.get(key, [])
        if not ids:
            return None
        
        if version > 0 and version <= len(ids):
            target_id = ids[version - 1]  # 1-indexed to 0-indexed
        else:
            target_id = ids[-1]  # Latest
            
        return self._artifacts.get(target_id)
    
    def get_content(self, key: str, default: Any = None) -> Any:
        """
        Shorthand to get just the content of an artifact by key.
        
        Args:
            key: The artifact key
            default: Value to return if artifact not found
            
        Returns:
            The artifact content or default
        """
        artifact = self.get_by_key(key)
        if artifact:
            return artifact.get_content()
        return default
    
    def list_all(self) -> List[Artifact]:
        """List all artifacts in the store (latest versions only)."""
        latest = []
        for key in self._by_key:
            artifact = self.get_by_key(key)
            if artifact:
                latest.append(artifact)
        return latest
    
    def list_keys(self) -> List[str]:
        """List all unique artifact keys."""
        return list(self._by_key.keys())
    
    def query(
        self,
        category: Optional[ArtifactCategory] = None,
        producer_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
        key_prefix: Optional[str] = None,
    ) -> List[Artifact]:
        """
        Query artifacts by criteria.
        
        Args:
            category: Filter by category
            producer_type: Filter by producer node type
            tags: Filter by tags (all must match)
            key_prefix: Filter by key prefix
            
        Returns:
            List of matching artifacts (latest versions)
        """
        results = []
        for artifact in self.list_all():
            if category and artifact.category != category:
                continue
            if producer_type and artifact.producer_node_type != producer_type:
                continue
            if tags and not all(t in artifact.tags for t in tags):
                continue
            if key_prefix and not artifact.key.startswith(key_prefix):
                continue
            results.append(artifact)
        return results
    
    def exists(self, key: str) -> bool:
        """Check if an artifact with the given key exists."""
        return key in self._by_key
    
    def get_version_count(self, key: str) -> int:
        """Get the number of versions for a key."""
        return len(self._by_key.get(key, []))
    
    # ═══════════════════════════════════════════════════════════════════════
    # SERIALIZATION
    # ═══════════════════════════════════════════════════════════════════════
    
    def to_dict(self) -> Dict[str, Any]:
        """Serialize entire store for transport."""
        return {
            "workflow_run_id": self.workflow_run_id,
            "task_id": self.task_id,
            "project_id": self.project_id,
            "artifact_count": len(self._artifacts),
            "artifacts": [a.to_dict() for a in self.list_all()]
        }
    
    def to_legacy_outputs(self) -> Dict[str, Any]:
        """
        Convert to legacy outputs format for backward compatibility.
        
        Maps artifact keys to their content for use with existing
        state["outputs"] consumers.
        
        Returns:
            Dict mapping keys to content values
        """
        outputs = {}
        for key in self._by_key:
            artifact = self.get_by_key(key)
            if artifact:
                outputs[key] = artifact.get_content()
        return outputs
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ArtifactStore":
        """Deserialize from JSON."""
        store = cls(
            workflow_run_id=data.get("workflow_run_id", ""),
            task_id=data.get("task_id", ""),
            project_id=data.get("project_id", ""),
        )
        
        for artifact_data in data.get("artifacts", []):
            artifact = Artifact.from_dict(artifact_data)
            store.store(artifact)
        
        return store
    
    # ═══════════════════════════════════════════════════════════════════════
    # UTILITY
    # ═══════════════════════════════════════════════════════════════════════
    
    def clear(self):
        """Clear all artifacts from the store."""
        with self._lock:
            self._artifacts.clear()
            self._by_key.clear()
    
    def __len__(self) -> int:
        """Return number of unique artifact keys."""
        return len(self._by_key)
    
    def __contains__(self, key: str) -> bool:
        """Check if key exists."""
        return self.exists(key)
    
    def __repr__(self) -> str:
        return f"ArtifactStore(run={self.workflow_run_id}, keys={len(self._by_key)})"
