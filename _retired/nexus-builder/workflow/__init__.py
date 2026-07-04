"""
Workflow Package - Phase 7.5: Static Data Persistence

Provides workflow-level utilities and static data persistence.

Usage:
    from workflow import (
        ObservableDict,
        StaticDataManager,
        StaticDataRegistry,
        get_workflow_static_data,
        persist_workflow_static_data
    )
    
    # Get static data for a workflow scope
    data = get_workflow_static_data(workflow_id, "node", "my_poller")
    data["last_id"] = 12345
    
    # Persist changed data at end of execution
    await persist_workflow_static_data(workflow_id)
"""

from .static_data import (
    # Core classes
    ObservableDict,
    StaticDataManager,
    StaticDataRegistry,
    
    # Convenience functions
    get_workflow_static_data,
    persist_workflow_static_data,
)

__all__ = [
    # Core classes
    "ObservableDict",
    "StaticDataManager",
    "StaticDataRegistry",
    
    # Convenience functions
    "get_workflow_static_data",
    "persist_workflow_static_data",
]
