"""
Global Context Service - Phase 6.5: Context Evolution

A singleton service that maintains the "source of truth" for project state.
This is the central hub that all nodes can access to get global context.

The key insight: instead of injecting everything into prompts (push model),
nodes request what they need (pull model).
"""

from dataclasses import dataclass, field
from typing import Any, Dict, Optional
from pathlib import Path
import threading


# ═══════════════════════════════════════════════════════════════════════════
# GLOBAL CONTEXT DATA CLASS
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class GlobalContext:
    """
    The immutable snapshot of global context for the current execution.
    
    This is what nodes receive when they call ctx.get_global_context().
    """
    project_id: Optional[str] = None
    task_id: Optional[str] = None
    project_path: Optional[str] = None
    project_name: str = "Unknown"
    
    # User preferences (from context_injector)
    user_preferences: Dict[str, Any] = field(default_factory=dict)
    
    # Execution metadata
    execution_id: Optional[str] = None
    run_id: Optional[str] = None
    
    # Additional context
    task_title: Optional[str] = None
    task_description: Optional[str] = None
    
    def get_project_path(self) -> Optional[str]:
        """Get the project path."""
        return self.project_path
    
    def get_project_name(self) -> str:
        """Get the project name (derived from path or explicit)."""
        if self.project_name != "Unknown":
            return self.project_name
        if self.project_path:
            return Path(self.project_path).name
        return "Unknown"
    
    def get_preference(self, key: str, default: Any = None) -> Any:
        """Get a specific user preference."""
        return self.user_preferences.get(key, default)


# ═══════════════════════════════════════════════════════════════════════════
# GLOBAL CONTEXT SERVICE (SINGLETON)
# ═══════════════════════════════════════════════════════════════════════════

class GlobalContextService:
    """
    Singleton service providing global context to all nodes.
    
    Phase 6.5: Context Evolution (Hybrid Middleware)
    
    Usage:
        # Initialize at workflow start
        gcs = GlobalContextService()
        gcs.initialize(project_id="...", task_id="...", project_path="/path/to/project")
        
        # Access from any node
        ctx = gcs.get_global_context()
        path = ctx.get_project_path()
    """
    
    _instance: Optional["GlobalContextService"] = None
    _lock = threading.Lock()
    
    def __new__(cls) -> "GlobalContextService":
        """Thread-safe singleton pattern."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        """Initialize the service (only runs once due to singleton)."""
        if self._initialized:
            return
        
        self._context: Optional[GlobalContext] = None
        self._supabase = None
        self._initialized = True
    
    def initialize(
        self,
        project_id: Optional[str] = None,
        task_id: Optional[str] = None,
        project_path: Optional[str] = None,
        user_preferences: Optional[Dict[str, Any]] = None,
        execution_id: Optional[str] = None,
        run_id: Optional[str] = None,
        task_title: Optional[str] = None,
        task_description: Optional[str] = None
    ) -> "GlobalContextService":
        """
        Initialize or update the global context for the current execution.
        
        This should be called at the start of each workflow execution.
        
        Args:
            project_id: The project UUID
            task_id: The task UUID
            project_path: Filesystem path to the project
            user_preferences: User preference dict
            execution_id: Current execution/run ID
            run_id: LangGraph run ID
            task_title: Human-readable task title
            task_description: Task description
        
        Returns:
            self for chaining
        """
        project_name = Path(project_path).name if project_path else "Unknown"
        
        self._context = GlobalContext(
            project_id=project_id,
            task_id=task_id,
            project_path=project_path,
            project_name=project_name,
            user_preferences=user_preferences or {},
            execution_id=execution_id,
            run_id=run_id,
            task_title=task_title,
            task_description=task_description
        )
        
        print(f"[GlobalContextService] Initialized for project: {project_name}")
        return self
    
    def get_global_context(self) -> GlobalContext:
        """
        Get the current global context.
        
        Returns:
            GlobalContext snapshot
        
        Raises:
            RuntimeError: If service not initialized
        """
        if self._context is None:
            # Return empty context instead of raising to be graceful
            return GlobalContext()
        return self._context
    
    def get_project_path(self) -> Optional[str]:
        """Convenience: Get the project path directly."""
        return self._context.project_path if self._context else None
    
    def get_project_id(self) -> Optional[str]:
        """Convenience: Get the project ID directly."""
        return self._context.project_id if self._context else None
    
    def get_task_id(self) -> Optional[str]:
        """Convenience: Get the task ID directly."""
        return self._context.task_id if self._context else None
    
    def get_user_preferences(self) -> Dict[str, Any]:
        """Convenience: Get user preferences directly."""
        return self._context.user_preferences if self._context else {}
    
    def update_preference(self, key: str, value: Any) -> None:
        """Update a user preference (for runtime changes)."""
        if self._context:
            self._context.user_preferences[key] = value
    
    def is_initialized(self) -> bool:
        """Check if the service has been initialized."""
        return self._context is not None
    
    def reset(self) -> None:
        """
        Reset the service for a new execution.
        
        Call this between workflow runs to ensure clean state.
        """
        self._context = None
    
    @classmethod
    def reset_instance(cls) -> None:
        """
        Reset the singleton instance entirely.
        
        Useful for testing.
        """
        with cls._lock:
            cls._instance = None


# ═══════════════════════════════════════════════════════════════════════════
# CONVENIENCE FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

def get_global_context() -> GlobalContext:
    """
    Module-level convenience function to get global context.
    
    Usage:
        from context.global_context_service import get_global_context
        ctx = get_global_context()
        path = ctx.get_project_path()
    """
    return GlobalContextService().get_global_context()
