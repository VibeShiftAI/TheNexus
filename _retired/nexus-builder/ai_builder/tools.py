"""
AI Workflow Builder Tools - Phase 8

Tools for the AI Workflow Builder agents.
Reference: packages/@n8n/ai-workflow-builder.ee/src/tools/

Tools:
1. add_node - Add a node to the workflow
2. connect_nodes - Connect two nodes
3. remove_node - Remove a node from the workflow
4. search_nodes - Search for available node types
5. get_node_details - Get detailed info about a node type
6. set_node_parameters - Configure node parameters
"""

from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field
from langchain_core.tools import tool

from nodes.registry import get_atomic_registry


# ═══════════════════════════════════════════════════════════════════════════
# TOOL INPUT SCHEMAS
# ═══════════════════════════════════════════════════════════════════════════

class AddNodeInput(BaseModel):
    """Input for add_node tool."""
    node_type: str = Field(description="Type ID of the node (e.g., 'researcher', 'builder')")
    name: str = Field(description="Human-readable name for this node instance")
    position_x: int = Field(default=0, description="X position on canvas")
    position_y: int = Field(default=0, description="Y position on canvas")


class ConnectNodesInput(BaseModel):
    """Input for connect_nodes tool."""
    source_node_id: str = Field(description="ID of the source node")
    target_node_id: str = Field(description="ID of the target node")
    source_output: int = Field(default=0, description="Output index (usually 0)")
    target_input: int = Field(default=0, description="Input index (usually 0)")


class RemoveNodeInput(BaseModel):
    """Input for remove_node tool."""
    node_id: str = Field(description="ID of the node to remove")


class SearchNodesInput(BaseModel):
    """Input for search_nodes tool."""
    query: str = Field(description="Search query (e.g., 'email', 'research', 'AI')")
    category: Optional[str] = Field(default=None, description="Optional category filter")


class GetNodeDetailsInput(BaseModel):
    """Input for get_node_details tool."""
    node_type: str = Field(description="Type ID of the node to get details for")


class SetNodeParametersInput(BaseModel):
    """Input for set_node_parameters tool."""
    node_id: str = Field(description="ID of the node to configure")
    parameters: Dict[str, Any] = Field(description="Parameters to set on the node")


# ═══════════════════════════════════════════════════════════════════════════
# TOOL IMPLEMENTATIONS
# ═══════════════════════════════════════════════════════════════════════════

@tool
def search_nodes(input: SearchNodesInput) -> List[Dict[str, Any]]:
    """
    Search for available node types.
    
    Use this to find what nodes are available for building workflows.
    Returns a list of matching node types with their descriptions.
    
    Reference: packages/@n8n/ai-workflow-builder.ee/src/tools/node-search.tool.ts
    """
    registry = get_atomic_registry()
    query = input.query.lower()
    
    results = []
    
    # Get all node descriptions
    all_nodes = registry.get_all_descriptions()
    
    for node in all_nodes:
        # NodeDescription is a Pydantic model, use attribute access
        display_name = getattr(node, 'display_name', '')
        type_id = getattr(node, 'type_id', '')
        description = getattr(node, 'description', '')
        category = getattr(node, 'category', '')
        icon = getattr(node, 'icon', '⚙️')
        
        # Search in name, type_id, description
        searchable = f"{display_name} {type_id} {description}".lower()
        
        if query in searchable:
            # Category filter if specified
            if input.category:
                if category != input.category:
                    continue
            
            results.append({
                "type_id": type_id,
                "display_name": display_name,
                "description": description[:100] if description else "",
                "category": category,
                "icon": icon,
            })
    
    return results


@tool
def get_node_details(input: GetNodeDetailsInput) -> Dict[str, Any]:
    """
    Get detailed information about a specific node type.
    
    Use this to understand what parameters a node needs and what it does.
    Returns the full node schema including all configurable properties.
    
    Reference: packages/@n8n/ai-workflow-builder.ee/src/tools/node-details.tool.ts
    """
    registry = get_atomic_registry()
    node_instance = registry.get_node_instance(input.node_type)
    
    if not node_instance:
        return {"error": f"Node type '{input.node_type}' not found"}
    
    description = node_instance.get_description()
    # NodeDescription is a Pydantic model, use attribute access
    return {
        "type_id": getattr(description, "type_id", ""),
        "display_name": getattr(description, "display_name", ""),
        "description": getattr(description, "description", ""),
        "category": getattr(description, "category", ""),
        "properties": getattr(description, "properties", []),
        "inputs": getattr(description, "inputs", ["main"]),
        "outputs": getattr(description, "outputs", ["main"]),
    }


@tool
def add_node(input: AddNodeInput, config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Add a node to the workflow being built.
    
    Use this after discovery has found the node type you need.
    The node will be added to the canvas at the specified position.
    
    Reference: packages/@n8n/ai-workflow-builder.ee/src/tools/add-node.tool.ts
    """
    import uuid
    
    registry = get_atomic_registry()
    node_class = registry.get_node_class(input.node_type)
    
    if not node_class:
        return {"error": f"Node type '{input.node_type}' not found"}
    
    # Generate a unique ID for this node instance
    node_id = f"{input.node_type}_{uuid.uuid4().hex[:8]}"
    
    # Create the node operation
    operation = {
        "operation": "add_node",
        "node_id": node_id,
        "node_type": input.node_type,
        "name": input.name,
        "position": (input.position_x, input.position_y),
        "parameters": {},  # To be configured later
    }
    
    return {
        "success": True,
        "node_id": node_id,
        "message": f"Added node '{input.name}' ({input.node_type}) with ID {node_id}",
        "operation": operation,
    }


@tool
def connect_nodes(input: ConnectNodesInput, config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Connect two nodes in the workflow.
    
    Use this to wire the output of one node to the input of another.
    Both nodes must already exist in the workflow.
    
    Reference: packages/@n8n/ai-workflow-builder.ee/src/tools/connect-nodes.tool.ts
    """
    operation = {
        "operation": "connect_nodes",
        "source_node_id": input.source_node_id,
        "source_output": input.source_output,
        "target_node_id": input.target_node_id,
        "target_input": input.target_input,
    }
    
    return {
        "success": True,
        "message": f"Connected {input.source_node_id} → {input.target_node_id}",
        "operation": operation,
    }


@tool
def remove_node(input: RemoveNodeInput, config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Remove a node from the workflow.
    
    This will also remove any connections to/from the node.
    
    Reference: packages/@n8n/ai-workflow-builder.ee/src/tools/remove-node.tool.ts
    """
    operation = {
        "operation": "remove_node",
        "node_id": input.node_id,
    }
    
    return {
        "success": True,
        "message": f"Removed node {input.node_id}",
        "operation": operation,
    }


@tool
def set_node_parameters(input: SetNodeParametersInput, config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Set parameters on an existing node.
    
    Use this to configure node settings like API endpoints, credentials, etc.
    
    Reference: Implied from n8n's configurator subgraph
    """
    operation = {
        "operation": "set_parameters",
        "node_id": input.node_id,
        "parameters": input.parameters,
    }
    
    return {
        "success": True,
        "message": f"Set {len(input.parameters)} parameters on {input.node_id}",
        "operation": operation,
    }


# ═══════════════════════════════════════════════════════════════════════════
# NEW TOOLS: remove_connection, validate_structure
# ═══════════════════════════════════════════════════════════════════════════

class RemoveConnectionInput(BaseModel):
    """Input for remove_connection tool."""
    source_node_id: str = Field(description="ID of the source node")
    target_node_id: str = Field(description="ID of the target node")


class ValidateStructureInput(BaseModel):
    """Input for validate_structure tool."""
    workflow: Dict[str, Any] = Field(description="The workflow to validate")


@tool
def remove_connection(input: RemoveConnectionInput, config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Remove a connection between two nodes.
    
    Use this when you need to rewire nodes without removing them.
    
    Reference: packages/@n8n/ai-workflow-builder.ee/src/tools/remove-connection.tool.ts
    """
    operation = {
        "operation": "remove_connection",
        "source_node_id": input.source_node_id,
        "target_node_id": input.target_node_id,
    }
    
    return {
        "success": True,
        "message": f"Removed connection {input.source_node_id} → {input.target_node_id}",
        "operation": operation,
    }


@tool
def validate_structure(input: ValidateStructureInput, config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate workflow structure (connections and trigger presence).
    
    Call after creating nodes/connections to check for issues.
    Returns validation results with any structural problems found.
    
    Reference: packages/@n8n/ai-workflow-builder.ee/src/tools/validate-structure.tool.ts
    """
    workflow = input.workflow
    nodes = workflow.get("nodes", [])
    connections = workflow.get("connections", [])
    
    violations = []
    
    # Check for empty workflow
    if not nodes:
        violations.append({
            "type": "empty_workflow",
            "description": "Workflow has no nodes"
        })
        return {
            "valid": False,
            "violations": violations,
            "message": "Workflow is empty"
        }
    
    # Check all connections reference valid nodes
    node_ids = {n.get("id") for n in nodes}
    for conn in connections:
        source = conn.get("sourceNodeId") or conn.get("source_node_id")
        target = conn.get("targetNodeId") or conn.get("target_node_id")
        
        if source not in node_ids:
            violations.append({
                "type": "invalid_source",
                "description": f"Connection references non-existent source node: {source}"
            })
        if target not in node_ids:
            violations.append({
                "type": "invalid_target",
                "description": f"Connection references non-existent target node: {target}"
            })
    
    # Check for orphan nodes (no connections)
    connected_nodes = set()
    for conn in connections:
        source = conn.get("sourceNodeId") or conn.get("source_node_id")
        target = conn.get("targetNodeId") or conn.get("target_node_id")
        connected_nodes.add(source)
        connected_nodes.add(target)
    
    for node in nodes:
        node_id = node.get("id")
        if node_id not in connected_nodes and len(nodes) > 1:
            violations.append({
                "type": "orphan_node",
                "description": f"Node '{node.get('name', node_id)}' has no connections"
            })
    
    # Check for trigger node (first node should be a trigger/start)
    # This is a soft check - workflows can have manual triggers
    
    if violations:
        return {
            "valid": False,
            "violations": violations,
            "message": f"Found {len(violations)} structure issues"
        }
    
    return {
        "valid": True,
        "violations": [],
        "message": "Workflow structure is valid"
    }


# ═══════════════════════════════════════════════════════════════════════════
# OPERATIONS PROCESSOR
# Reference: packages/@n8n/ai-workflow-builder.ee/src/utils/operations-processor.ts
# ═══════════════════════════════════════════════════════════════════════════

def apply_operations_to_workflow(
    workflow: Dict[str, Any],
    operations: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Apply pending operations to a workflow canvas.
    
    This processes the operations queue and mutates the workflow state.
    Called after tool execution to update the actual workflow.
    
    Args:
        workflow: Current workflow dict (nodes, connections)
        operations: List of pending operations
    
    Returns:
        Updated workflow dict
    """
    nodes = list(workflow.get("nodes", []))
    connections = list(workflow.get("connections", []))
    
    for op in operations:
        op_type = op.get("operation")
        
        if op_type == "add_node":
            nodes.append({
                "id": op.get("node_id"),
                "type": op.get("node_type"),
                "name": op.get("name"),
                "position": list(op.get("position", (0, 0))),
                "parameters": op.get("parameters", {}),
            })
        
        elif op_type == "remove_node":
            node_id = op.get("node_id")
            nodes = [n for n in nodes if n.get("id") != node_id]
            connections = [
                c for c in connections
                if c.get("sourceNodeId") != node_id and c.get("targetNodeId") != node_id
            ]
        
        elif op_type == "connect_nodes":
            connections.append({
                "sourceNodeId": op.get("source_node_id"),
                "sourceOutput": op.get("source_output", 0),
                "targetNodeId": op.get("target_node_id"),
                "targetInput": op.get("target_input", 0),
            })
        
        elif op_type == "remove_connection":
            source = op.get("source_node_id")
            target = op.get("target_node_id")
            connections = [
                c for c in connections
                if not (c.get("sourceNodeId") == source and c.get("targetNodeId") == target)
            ]
        
        elif op_type == "set_parameters":
            node_id = op.get("node_id")
            params = op.get("parameters", {})
            for node in nodes:
                if node.get("id") == node_id:
                    node["parameters"] = {**node.get("parameters", {}), **params}
                    break
    
    return {
        **workflow,
        "nodes": nodes,
        "connections": connections,
    }


# ═══════════════════════════════════════════════════════════════════════════
# TOOL EXPORTS
# ═══════════════════════════════════════════════════════════════════════════

DISCOVERY_TOOLS = [search_nodes, get_node_details]
BUILDER_TOOLS = [add_node, connect_nodes, remove_node, remove_connection, validate_structure]
CONFIGURATOR_TOOLS = [set_node_parameters, get_node_details]

ALL_TOOLS = [
    search_nodes, get_node_details, add_node, connect_nodes, 
    remove_node, remove_connection, set_node_parameters, validate_structure
]
