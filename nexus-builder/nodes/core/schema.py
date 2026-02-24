"""
Declarative Node Schema - Pydantic Models for UI Generation

This module provides Pydantic models that mirror n8n's INodeProperties interface,
enabling automatic UI generation for node configuration panels.

Reference: packages/workflow/src/interfaces.ts (INodeProperties, lines 1587-1620)

Key Benefits:
1. Type-safe property definitions
2. Automatic JSON schema export for frontend
3. Validation at configuration time
4. Self-documenting node APIs
"""

from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field


# ═══════════════════════════════════════════════════════════════════════════
# PROPERTY TYPES (mirrors NodePropertyTypes from n8n)
# ═══════════════════════════════════════════════════════════════════════════

class PropertyType(str, Enum):
    """
    Available property types for node configuration.
    Reference: packages/workflow/src/interfaces.ts (line 1381)
    """
    STRING = "string"
    NUMBER = "number"
    BOOLEAN = "boolean"
    OPTIONS = "options"
    MULTI_OPTIONS = "multiOptions"
    COLLECTION = "collection"
    FIXED_COLLECTION = "fixedCollection"
    JSON = "json"
    CODE = "code"
    DATETIME = "dateTime"
    COLOR = "color"
    HIDDEN = "hidden"
    NOTICE = "notice"
    RESOURCE_LOCATOR = "resourceLocator"
    CREDENTIALS = "credentials"
    
    # AI-specific types (The Nexus extensions)
    MODEL_SELECTOR = "modelSelector"
    PROMPT = "prompt"
    MEMORY_SELECTOR = "memorySelector"


# ═══════════════════════════════════════════════════════════════════════════
# PROPERTY OPTIONS
# ═══════════════════════════════════════════════════════════════════════════

class PropertyOption(BaseModel):
    """
    Option for dropdown/select properties.
    Reference: packages/workflow/src/interfaces.ts (INodePropertyOptions, line 1687)
    """
    name: str = Field(..., description="Display name shown in dropdown")
    value: Union[str, int, bool] = Field(..., description="Actual value")
    description: Optional[str] = Field(None, description="Tooltip/helper text")
    
    class Config:
        extra = "allow"  # Allow additional fields for extensibility


class DisplayCondition(BaseModel):
    """
    Conditions for showing/hiding properties based on other property values.
    Reference: packages/workflow/src/interfaces.ts (IDisplayOptions, line 1562)
    """
    show: Optional[Dict[str, List[Any]]] = Field(
        None, 
        description="Show when these conditions are met"
    )
    hide: Optional[Dict[str, List[Any]]] = Field(
        None,
        description="Hide when these conditions are met"
    )


# ═══════════════════════════════════════════════════════════════════════════
# TYPE OPTIONS (per-type configuration)
# ═══════════════════════════════════════════════════════════════════════════

class StringTypeOptions(BaseModel):
    """Type options for string properties."""
    rows: Optional[int] = Field(None, description="Number of rows for textarea")
    password: Optional[bool] = Field(None, description="Mask input as password")
    editor: Optional[Literal["codeNodeEditor", "jsEditor", "htmlEditor", "sqlEditor", "cssEditor"]] = None
    placeholder: Optional[str] = None


class NumberTypeOptions(BaseModel):
    """Type options for number properties."""
    min_value: Optional[float] = Field(None, alias="minValue")
    max_value: Optional[float] = Field(None, alias="maxValue")
    number_precision: Optional[int] = Field(None, alias="numberPrecision")
    
    class Config:
        populate_by_name = True


class CollectionTypeOptions(BaseModel):
    """Type options for collection properties."""
    multiple_values: Optional[bool] = Field(None, alias="multipleValues")
    multiple_value_button_text: Optional[str] = Field(None, alias="multipleValueButtonText")
    sortable: Optional[bool] = None
    
    class Config:
        populate_by_name = True


# ═══════════════════════════════════════════════════════════════════════════
# MAIN PROPERTY DEFINITION
# ═══════════════════════════════════════════════════════════════════════════

class NodeProperty(BaseModel):
    """
    Declarative property definition for node configuration.
    
    This is the core schema that drives automatic UI generation.
    Reference: packages/workflow/src/interfaces.ts (INodeProperties, line 1587)
    
    Example:
        NodeProperty(
            display_name="Model",
            name="model",
            type=PropertyType.OPTIONS,
            default="gemini-3-flash-preview",
            options=[
                PropertyOption(name="Gemini Flash", value="gemini-3-flash-preview"),
                PropertyOption(name="Gemini Pro", value="gemini-3-pro-preview"),
            ],
            description="Which AI model to use"
        )
    """
    display_name: str = Field(..., alias="displayName", description="Label shown in UI")
    name: str = Field(..., description="Parameter key for accessing value")
    type: PropertyType = Field(..., description="Property type determines UI widget")
    default: Any = Field(..., description="Default value if not configured")
    description: Optional[str] = Field(None, description="Help text shown below input")
    hint: Optional[str] = Field(None, description="Inline hint shown in input")
    placeholder: Optional[str] = Field(None, description="Placeholder text")
    required: Optional[bool] = Field(False, description="Whether field is required")
    
    # Options for dropdown/select types
    options: Optional[List[PropertyOption]] = Field(None, description="Options for select types")
    
    # Nested properties for collection types
    properties: Optional[List["NodeProperty"]] = Field(
        None, 
        description="Child properties for collections"
    )
    
    # Type-specific options
    type_options: Optional[Dict[str, Any]] = Field(
        None, 
        alias="typeOptions",
        description="Type-specific configuration"
    )
    
    # Conditional display
    display_options: Optional[DisplayCondition] = Field(
        None,
        alias="displayOptions",
        description="Conditions for showing/hiding this property"
    )
    
    # Validation
    validate_type: Optional[str] = Field(
        None,
        alias="validateType",
        description="Expected type for validation"
    )
    
    # Expression support
    no_data_expression: Optional[bool] = Field(
        False,
        alias="noDataExpression",
        description="Disable expression support"
    )
    
    class Config:
        populate_by_name = True
        extra = "allow"  # Allow additional fields for extensibility
    
    def to_frontend_schema(self) -> Dict[str, Any]:
        """
        Convert to frontend-compatible JSON schema.
        Used by the Visual Builder to render configuration panels.
        """
        schema = {
            "displayName": self.display_name,
            "name": self.name,
            "type": self.type.value,
            "default": self.default,
        }
        
        if self.description:
            schema["description"] = self.description
        if self.hint:
            schema["hint"] = self.hint
        if self.placeholder:
            schema["placeholder"] = self.placeholder
        if self.required:
            schema["required"] = self.required
        if self.options:
            schema["options"] = [opt.model_dump(exclude_none=True) for opt in self.options]
        if self.properties:
            schema["properties"] = [p.to_frontend_schema() for p in self.properties]
        if self.type_options:
            schema["typeOptions"] = self.type_options
        if self.display_options:
            schema["displayOptions"] = self.display_options.model_dump(exclude_none=True)
            
        return schema


# Enable forward reference for nested properties
NodeProperty.model_rebuild()


# ═══════════════════════════════════════════════════════════════════════════
# NODE DESCRIPTION SCHEMA
# ═══════════════════════════════════════════════════════════════════════════

class NodeDescription(BaseModel):
    """
    Complete node type description for UI and registry.
    Reference: packages/workflow/src/interfaces.ts (INodeTypeDescription)
    """
    type_id: str = Field(..., alias="name", description="Unique node type identifier")
    display_name: str = Field(..., alias="displayName", description="Human-readable name")
    description: str = Field(..., description="Brief description of node purpose")
    icon: str = Field("⚡", description="Icon emoji or file reference")
    category: str = Field("general", alias="group", description="Node category for grouping")
    version: float = Field(1.0, description="Node version number")
    
    # I/O configuration
    inputs: List[str] = Field(default_factory=lambda: ["main"])
    outputs: List[str] = Field(default_factory=lambda: ["main"])
    
    # Properties drive the configuration UI
    properties: List[NodeProperty] = Field(
        default_factory=list,
        description="Configurable properties"
    )
    
    # Availability
    levels: List[str] = Field(
        default_factory=lambda: ["feature"],
        description="Which workflow levels can use this node"
    )
    
    # Credentials
    credentials: Optional[List[Dict[str, Any]]] = Field(
        None,
        description="Required credentials"
    )
    
    class Config:
        populate_by_name = True
    
    def to_frontend_schema(self) -> Dict[str, Any]:
        """Export as JSON for frontend consumption."""
        return {
            "name": self.type_id,
            "displayName": self.display_name,
            "description": self.description,
            "icon": self.icon,
            "group": [self.category],
            "version": self.version,
            "inputs": self.inputs,
            "outputs": self.outputs,
            "properties": [p.to_frontend_schema() for p in self.properties],
            "levels": self.levels,
        }


# ═══════════════════════════════════════════════════════════════════════════
# CONVENIENCE FACTORY FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

def string_property(
    name: str,
    display_name: str,
    default: str = "",
    description: str = None,
    required: bool = False,
    rows: int = None,
    password: bool = False,
) -> NodeProperty:
    """Factory for string properties."""
    type_options = {}
    if rows:
        type_options["rows"] = rows
    if password:
        type_options["password"] = password
        
    return NodeProperty(
        display_name=display_name,
        name=name,
        type=PropertyType.STRING,
        default=default,
        description=description,
        required=required,
        type_options=type_options if type_options else None,
    )


def number_property(
    name: str,
    display_name: str,
    default: float = 0,
    description: str = None,
    min_value: float = None,
    max_value: float = None,
) -> NodeProperty:
    """Factory for number properties."""
    type_options = {}
    if min_value is not None:
        type_options["minValue"] = min_value
    if max_value is not None:
        type_options["maxValue"] = max_value
        
    return NodeProperty(
        display_name=display_name,
        name=name,
        type=PropertyType.NUMBER,
        default=default,
        description=description,
        type_options=type_options if type_options else None,
    )


def boolean_property(
    name: str,
    display_name: str,
    default: bool = False,
    description: str = None,
) -> NodeProperty:
    """Factory for boolean properties."""
    return NodeProperty(
        display_name=display_name,
        name=name,
        type=PropertyType.BOOLEAN,
        default=default,
        description=description,
    )


def options_property(
    name: str,
    display_name: str,
    options: List[PropertyOption],
    default: Any = None,
    description: str = None,
) -> NodeProperty:
    """Factory for dropdown/select properties."""
    return NodeProperty(
        display_name=display_name,
        name=name,
        type=PropertyType.OPTIONS,
        default=default if default is not None else (options[0].value if options else ""),
        options=options,
        description=description,
    )


def model_selector_property(
    name: str = "model",
    display_name: str = "Model",
    default: str = "gemini-3-flash-preview",
) -> NodeProperty:
    """Factory for AI model selection (Nexus-specific)."""
    return NodeProperty(
        display_name=display_name,
        name=name,
        type=PropertyType.MODEL_SELECTOR,
        default=default,
        description="Select the AI model to use",
        type_options={
            "loadOptionsMethod": "getAvailableModels"  # Dynamic loading from backend
        }
    )


# ═══════════════════════════════════════════════════════════════════════════
# EXPORTS
# ═══════════════════════════════════════════════════════════════════════════

__all__ = [
    # Core types
    "PropertyType",
    "PropertyOption", 
    "DisplayCondition",
    "NodeProperty",
    "NodeDescription",
    # Type options
    "StringTypeOptions",
    "NumberTypeOptions", 
    "CollectionTypeOptions",
    # Factory functions
    "string_property",
    "number_property",
    "boolean_property",
    "options_property",
    "model_selector_property",
]
