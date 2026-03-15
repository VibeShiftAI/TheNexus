"""
Workflow Static Data - Phase 7.5: Static Data Persistence

Implements persistent storage for polling nodes, inspired by n8n's staticData pattern.

Key Concepts:
1. ObservableDict - Tracks when data changes via __dataChanged flag
2. StaticDataManager - Manages scoped storage (global vs per-node) with DB persistence
3. Only persists when data actually changes (efficiency)

Reference:
- packages/workflow/src/workflow.ts (L218 getStaticData)
- packages/workflow/src/observable-object.ts

Use Case: Polling triggers remember "last checked ID" between executions.
"""

from typing import Any, Dict, Optional
from datetime import datetime
import json
import threading


# ═══════════════════════════════════════════════════════════════════════════
# OBSERVABLE DICT (Python equivalent of n8n's ObservableObject)
# ═══════════════════════════════════════════════════════════════════════════

class ObservableDict(dict):
    """
    A dict that tracks when its data has been modified.
    
    Reference: packages/workflow/src/observable-object.ts
    
    The __dataChanged flag is set to True whenever:
    - A key is set
    - A key is deleted
    - Any nested ObservableDict is modified
    
    This allows efficient persistence - only save when data actually changed.
    """
    
    def __init__(self, *args, parent: Optional["ObservableDict"] = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._data_changed = False
        self._parent = parent
        
        # Make nested dicts observable too
        for key in list(self.keys()):
            value = super().__getitem__(key)
            if isinstance(value, dict) and not isinstance(value, ObservableDict):
                super().__setitem__(key, ObservableDict(value, parent=self))
    
    @property
    def __dataChanged(self) -> bool:
        """Check if data has changed."""
        return self._data_changed
    
    @__dataChanged.setter
    def __dataChanged(self, value: bool):
        """Set data changed flag."""
        self._data_changed = value
    
    def _mark_changed(self):
        """Mark this dict (or parent) as changed."""
        if self._parent:
            self._parent._mark_changed()
        else:
            self._data_changed = True
    
    def __setitem__(self, key, value):
        """Track changes on item set."""
        # Wrap nested dicts
        if isinstance(value, dict) and not isinstance(value, ObservableDict):
            value = ObservableDict(value, parent=self)
        
        self._mark_changed()
        super().__setitem__(key, value)
    
    def __delitem__(self, key):
        """Track changes on item delete."""
        self._mark_changed()
        super().__delitem__(key)
    
    def update(self, *args, **kwargs):
        """Track changes on update."""
        self._mark_changed()
        super().update(*args, **kwargs)
    
    def pop(self, *args):
        """Track changes on pop."""
        self._mark_changed()
        return super().pop(*args)
    
    def clear(self):
        """Track changes on clear."""
        self._mark_changed()
        super().clear()
    
    def reset_changed(self):
        """Reset the changed flag after persisting."""
        self._data_changed = False
    
    def has_changed(self) -> bool:
        """Check if data has changed since last reset."""
        return self._data_changed


# ═══════════════════════════════════════════════════════════════════════════
# STATIC DATA MANAGER
# ═══════════════════════════════════════════════════════════════════════════

class StaticDataManager:
    """
    Manages static data persistence for workflows.
    
    Reference: packages/workflow/src/workflow.ts (getStaticData)
    
    Static data is:
    - Saved with the workflow
    - Persisted across all executions
    - Scoped either globally or per-node
    
    Use Cases:
    - Polling triggers storing "last checked ID"
    - Rate limiting (last request timestamp)
    - Incremental sync cursors
    """
    
    def __init__(self, workflow_id: str, supabase_client=None):
        """
        Initialize static data manager.
        
        Args:
            workflow_id: The workflow ID for scoping
            supabase_client: Supabase client for persistence
        """
        self.workflow_id = workflow_id
        self.db_client = supabase_client  # SQLiteClient instance (backward-compat param name)
        self._static_data: Dict[str, ObservableDict] = {}
        self._lock = threading.Lock()
        self._loaded = False
    
    async def load_from_db(self) -> None:
        """
        Load static data from database.
        
        Should be called once at workflow start.
        """
        if self._loaded or not self.db_client:
            return
        
        try:
            db = await self.db_client._get_db()
            async with db.execute(
                "SELECT * FROM workflow_static_data WHERE workflow_id = ?",
                (self.workflow_id,)
            ) as cursor:
                rows = await cursor.fetchall()
            
            for row in rows or []:
                key = row.get("scope_key", "global") if isinstance(row, dict) else "global"
                import json as _json
                raw_data = row.get("data", "{}") if isinstance(row, dict) else "{}"
                data = _json.loads(raw_data) if isinstance(raw_data, str) else (raw_data or {})
                self._static_data[key] = ObservableDict(data)
            
            self._loaded = True
            print(f"[StaticDataManager] Loaded {len(self._static_data)} scopes for workflow {self.workflow_id}")
        
        except Exception as e:
            print(f"[StaticDataManager] Load error: {e}")
    
    def get_static_data(self, scope_type: str, node_name: Optional[str] = None) -> ObservableDict:
        """
        Get static data for a scope.
        
        Args:
            scope_type: "global" or "node"
            node_name: Required if scope_type is "node"
        
        Returns:
            ObservableDict for the scope
        
        Reference: packages/workflow/src/workflow.ts L218
        """
        if scope_type == "global":
            key = "global"
        elif scope_type == "node":
            if not node_name:
                raise ValueError("Node name required for 'node' scope type")
            key = f"node:{node_name}"
        else:
            raise ValueError(f"Unknown scope type: {scope_type}. Use 'global' or 'node'")
        
        with self._lock:
            if key not in self._static_data:
                self._static_data[key] = ObservableDict()
            return self._static_data[key]
    
    def get_global_static_data(self) -> ObservableDict:
        """Convenience: Get global static data."""
        return self.get_static_data("global")
    
    def get_node_static_data(self, node_name: str) -> ObservableDict:
        """Convenience: Get node-scoped static data."""
        return self.get_static_data("node", node_name)
    
    async def persist_if_changed(self) -> int:
        """
        Persist any changed static data to database.
        
        Should be called at end of workflow execution.
        
        Returns:
            Count of scopes that were persisted
        """
        if not self.db_client:
            return 0
        
        count = 0
        
        with self._lock:
            for key, data in self._static_data.items():
                if data.has_changed():
                    try:
                        import json as _json
                        db = await self.db_client._get_db()
                        await db.execute(
                            """INSERT INTO workflow_static_data (workflow_id, scope_key, data, updated_at)
                            VALUES (?, ?, ?, ?)
                            ON CONFLICT (workflow_id, scope_key) DO UPDATE SET
                            data = excluded.data, updated_at = excluded.updated_at""",
                            (self.workflow_id, key, _json.dumps(dict(data)), datetime.utcnow().isoformat())
                        )
                        await db.commit()
                        
                        data.reset_changed()
                        count += 1
                    except Exception as e:
                        print(f"[StaticDataManager] Persist error for {key}: {e}")
        
        if count > 0:
            print(f"[StaticDataManager] Persisted {count} changed scopes")
        
        return count
    
    def has_changes(self) -> bool:
        """Check if any static data has changed."""
        with self._lock:
            return any(data.has_changed() for data in self._static_data.values())


# ═══════════════════════════════════════════════════════════════════════════
# SINGLETON REGISTRY
# ═══════════════════════════════════════════════════════════════════════════

class StaticDataRegistry:
    """
    Singleton registry for StaticDataManager instances.
    
    Ensures one manager per workflow and provides easy access.
    """
    
    _instance: Optional["StaticDataRegistry"] = None
    _lock = threading.Lock()
    
    def __new__(cls) -> "StaticDataRegistry":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        self._managers: Dict[str, StaticDataManager] = {}
        self._initialized = True
    
    def get_manager(
        self,
        workflow_id: str,
        supabase_client=None
    ) -> StaticDataManager:
        """Get or create a StaticDataManager for a workflow."""
        if workflow_id not in self._managers:
            self._managers[workflow_id] = StaticDataManager(workflow_id, supabase_client)
        return self._managers[workflow_id]
    
    async def persist_all(self) -> int:
        """Persist all changed static data across all workflows."""
        total = 0
        for manager in self._managers.values():
            total += await manager.persist_if_changed()
        return total
    
    def cleanup(self, workflow_id: str) -> bool:
        """Remove a workflow's manager from registry."""
        if workflow_id in self._managers:
            del self._managers[workflow_id]
            return True
        return False


# ═══════════════════════════════════════════════════════════════════════════
# CONVENIENCE FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

def get_workflow_static_data(
    workflow_id: str,
    scope_type: str = "global",
    node_name: Optional[str] = None,
    supabase_client=None
) -> ObservableDict:
    """
    Get static data for a workflow scope.
    
    Usage:
        # Global scope
        data = get_workflow_static_data(workflow_id)
        data["last_checked_id"] = 12345
        
        # Node scope
        data = get_workflow_static_data(workflow_id, "node", "my_poller")
        data["cursor"] = "abc123"
    """
    registry = StaticDataRegistry()
    manager = registry.get_manager(workflow_id, supabase_client)
    return manager.get_static_data(scope_type, node_name)


async def persist_workflow_static_data(workflow_id: str) -> int:
    """Persist any changed static data for a workflow."""
    registry = StaticDataRegistry()
    if workflow_id in registry._managers:
        return await registry._managers[workflow_id].persist_if_changed()
    return 0
