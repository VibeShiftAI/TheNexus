"""
Atomic Nodes Package - Core Components

This package provides the foundational atomic node system for The Nexus,
inspired by n8n's modular architecture.
"""

from .base import (
    AtomicNode,
    NodeExecutionContext,
    NodeExecutionData,
    NodeConnectionType,
    WorkflowInfo,
    NodeInfo,
    ExecutionLifecycleHooks,
)

from .schema import (
    PropertyType,
    PropertyOption,
    DisplayCondition,
    NodeProperty,
    NodeDescription,
    # Factory functions
    string_property,
    number_property,
    boolean_property,
    options_property,
    model_selector_property,
)

__all__ = [
    # Base classes
    "AtomicNode",
    "NodeExecutionContext", 
    "NodeExecutionData",
    "NodeConnectionType",
    "WorkflowInfo",
    "NodeInfo",
    "ExecutionLifecycleHooks",
    # Schema types
    "PropertyType",
    "PropertyOption",
    "DisplayCondition",
    "NodeProperty",
    "NodeDescription",
    # Factory functions
    "string_property",
    "number_property",
    "boolean_property",
    "options_property",
    "model_selector_property",
]

