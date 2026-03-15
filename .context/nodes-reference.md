---
context_type: nodes-reference
status: draft
updated_at: 2026-03-15T18:28:42.525Z
---

# Atomic Node Reference

## Overview
The Atomic Node system is the core building block for dynamic workflows in The Nexus. Unlike static workflows, Atomic Nodes are modular, self-contained units of logic that can be assembled into complex graphs using the Visual Builder. This system allows for high flexibility and rapid extension of agent capabilities.

## The AtomicNode Base Class
All nodes inherit from the `AtomicNode` base class. This class enforces a standard interface for:

1.  **Input Schema**: Pydantic models defining required inputs and configuration parameters.
2.  **Output Schema**: Pydantic models defining the structure of the execution result.
3.  **Execution Logic**: The `execute(state, config)` method which contains the node's business logic.
4.  **Metadata**: Properties for `name`, `description`, `category`, and `version` used by the UI.

## Registration Process
Nodes are discovered via a central registry pattern to ensure they are available to the workflow engine and the frontend.

1.  **Definition**: A node is defined as a Python class inheriting from `AtomicNode`.
2.  **Registration**: A decorator (e.g., `@register_node`) or a central registry file maps the node's unique identifier (string) to the class.
3.  **Discovery**: Upon application startup, the backend scans the `nodes/` directory (or specific module paths) to load all available nodes into the registry.

## Node Categories
Nodes are organized into specific categories to aid discovery in the Visual Builder.

### Research
Nodes focused on gathering information from external sources or the project context.
-   **Purpose**: Context gathering, web searching, library analysis.
-   **Examples**: `WebSearchNode`, `ContextRetrieverNode`.

### Planning
Nodes for structuring work, breaking down tasks, and determining strategy.
-   **Purpose**: Task decomposition, roadmap generation, dependency analysis.
-   **Examples**: `TaskDecomposerNode`, `PlannerNode`.

### Implementation
Nodes that perform active work, generation, or execution.
-   **Purpose**: Code generation, shell command execution, refactoring.
-   **Examples**: `CodeGeneratorNode`, `CommandExecutorNode`.

### Review
Nodes for validation, quality assurance, and critique.
-   **Purpose**: Code review, security scanning, syntax checking.
-   **Examples**: `CodeReviewNode`, `LinterNode`.

### Utility
General-purpose logic, flow control, and data transformation.
-   **Purpose**: Routing, formatting, delays, state manipulation.
-   **Examples**: `RouterNode`, `JSONFormatterNode`, `MergeNode`.

### Artifacts
Nodes handling file system operations and tangible deliverables.
-   **Purpose**: Saving files, bundling outputs, reading file content.
-   **Examples**: `FileSaveNode`, `ArtifactBundlerNode`.

### Documentation
Nodes specifically designed for managing project documentation.
-   **Purpose**: Updating docs, generating summaries, maintaining changelogs.
-   **Examples**: `DocUpdaterNode`, `ReadmeGeneratorNode`.

### Memory
Nodes for interacting with long-term storage or vector databases.
-   **Purpose**: Storing insights, recalling past decisions, updating user preferences.
-   **Examples**: `MemoryStoreNode`, `MemoryRecallNode`.

## Visual Builder Integration
The Visual Builder frontend relies on the backend to dynamically render configuration forms for each node type.

### The `/node-types/atomic` Endpoint
This API endpoint exposes the registry to the frontend.
-   **Method**: `GET`
-   **Response**: A JSON list of all registered nodes.
-   **Payload Details**: Each entry includes the node's `type` (ID), `category`, `display_name`, `description`, and the JSON Schema representation of its configuration model.

### Dynamic Configuration Panels
Using the JSON Schema provided by the endpoint, the Visual Builder:
1.  **Generates Forms**: Automatically renders text inputs, dropdowns, toggles, and array fields based on the node's input schema.
2.  **Validates Input**: Enforces types, required fields, and constraints (e.g., min/max values) client-side before saving the workflow.
3.  **Displays Context**: Shows tooltips and descriptions defined in the backend Pydantic models to guide the user.