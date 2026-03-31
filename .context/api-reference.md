---
context_type: api-reference
status: draft
updated_at: 2026-03-31T01:20:31.157Z
---

# API Reference

This document outlines the REST API endpoints for the Python-based FastAPI services in TheNexus: `nexus-builder` and `cortex`.

## Nexus Builder Service (`nexus-builder`)

The Nexus Builder service handles workflow management, node discovery, and artifact retrieval for the LangGraph-based execution engine.

### Endpoints

#### Node Discovery
*   **`GET /node-types/atomic`**
    *   **Description:** Retrieves a list of all available atomic node types that can be used in workflows.
    *   **Response:** List of node type summaries (ID, name, description, category).
*   **`GET /node-types/atomic/{type_id}`**
    *   **Description:** Retrieves detailed schema and configuration requirements for a specific atomic node type.
    *   **Path Parameters:** `type_id` (string) - The unique identifier of the node type.
    *   **Response:** Detailed node schema including expected inputs, outputs, and configuration fields.

#### Artifacts
*   **`GET /api/artifacts/types`**
    *   **Description:** Lists all supported artifact types that can be generated or consumed by workflows.
    *   **Response:** List of artifact type definitions.

#### Workflow Execution & Building
*   **`POST /api/workflows/run`**
    *   **Description:** Triggers the execution of a compiled workflow.
    *   **Request Body:** `WorkflowRunRequest`
    *   **Response:** Run ID and initial status.
*   **`POST /api/builder/generate`**
    *   **Description:** Uses AI to generate or modify a workflow graph based on a natural language prompt.
    *   **Request Body:** `AIBuilderRequest`
    *   **Response:** Generated workflow graph definition (nodes and edges).


## Core Pydantic Models

### `WorkflowRunRequest`
Used to initiate a workflow execution in `nexus-builder`.

```python
from pydantic import BaseModel, Field
from typing import Dict, Any, Optional

class WorkflowRunRequest(BaseModel):
    workflow_id: str = Field(..., description="The UUID or identifier of the workflow template to run")
    project_id: Optional[str] = Field(None, description="Target project UUID, if applicable")
    inputs: Dict[str, Any] = Field(default_factory=dict, description="Initial state/inputs for the LangGraph execution")
    config: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Execution configuration (e.g., thread_id for memory)")
```

### `AIBuilderRequest`
Used to request AI-assisted workflow generation in `nexus-builder`.

```python
from pydantic import BaseModel, Field
from typing import Dict, Any, Optional

class AIBuilderRequest(BaseModel):
    prompt: str = Field(..., description="Natural language description of the desired workflow")
    base_template_id: Optional[str] = Field(None, description="Optional ID of an existing template to modify")
    context: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Additional context for the AI builder (e.g., available node types)")
```

### `TerminalRequest`
Used to execute commands via the `cortex` service.

```python
from pydantic import BaseModel, Field
from typing import Optional

class TerminalRequest(BaseModel):
    command: str = Field(..., description="The shell command to execute")
    cwd: Optional[str] = Field(None, description="Working directory for the command execution")
    timeout: Optional[int] = Field(60, description="Execution timeout in seconds")
```