# The Nexus Agent System - Architecture Guide

> **Last Updated**: January 25, 2026

This document provides comprehensive documentation for The Nexus Agent System, including the Agent Manager, Universal Artifact System, Context Management, and Workflow Orchestration.

---

## Table of Contents

1. [Agent Manager Overview](#1-agent-manager-overview)
2. [Universal Artifact System](#2-universal-artifact-system)
3. [Context Management](#3-context-management)
4. [Workflow Orchestration](#4-workflow-orchestration)
5. [Fleet Architecture](#5-fleet-architecture)
6. [API Reference](#6-api-reference)

---

## 1. Agent Manager Overview

The Agent Manager provides a **read-only view** of all available atomic nodes (agents) that can be used in workflows.

### Key Concepts

| Term | Description |
|------|-------------|
| **AtomicNode** | Base class for all workflow nodes |
| **FleetAgentNode** | Specialized base for agents extracted from fleets |
| **Node Registry** | Central registry of all available node types |

### Node Categories

```
nodes/
├── research/        # Research Fleet agents
├── planning/        # Architect Fleet agents  
├── implementation/  # Builder Fleet agents
├── review/          # Auditor Fleet agents
├── orchestration/   # Supervisors, approval gates
└── utility/         # Common utilities
```

### Viewing Agents

Navigate to `/agents` in the dashboard to see all available agents with:
- Display name and description
- Category and icon
- Supported workflow levels

---

## 2. Universal Artifact System

The Universal Artifact System enables **any workflow node to produce and consume artifacts** of any format.

### Core Components

```
nodes/artifacts/
├── __init__.py     # Exports: Artifact, ArtifactStore, ArtifactCategory
├── models.py       # Artifact dataclass and ArtifactCategory enum
└── store.py        # ArtifactStore class with CRUD + query
```

### Artifact Model

```python
from nodes.artifacts import Artifact, ArtifactCategory

artifact = Artifact(
    key="research_dossier",           # Machine key for retrieval
    name="Research Dossier",           # Human-readable name
    content="# Research Findings...",  # Text/markdown content
    category=ArtifactCategory.RESEARCH,
    producer_node_type="research_synthesizer",
)
```

#### Supported Content Types

| Field | Type | Use Case |
|-------|------|----------|
| `content` | `str` | Text, markdown, reports |
| `content_json` | `Dict` | Structured data, configs |
| `content_binary` | `bytes` | Images, binaries |
| `file_path` | `str` | Reference to file on disk |

### ArtifactStore

```python
from nodes.artifacts import ArtifactStore, ArtifactCategory

# Create store for a workflow run
store = ArtifactStore(
    workflow_run_id="run-123",
    task_id="task-456",
    project_id="project-789"
)

# Store artifact (auto-detects content type)
store.store_simple(
    key="blueprint",
    content={"spec": "...", "manifest": [...]},
    category=ArtifactCategory.PLAN
)

# Retrieve artifact
blueprint = store.get_content("blueprint")

# Query artifacts
plans = store.query(category=ArtifactCategory.PLAN)

# List all keys
keys = store.list_keys()  # ['research_dossier', 'blueprint']
```

### Using Artifacts in FleetAgentNode

```python
class MySynthesizerNode(FleetAgentNode):
    async def execute(self, ctx, items):
        # Create artifact
        self.create_artifact(
            ctx,
            key="my_output",
            content="# Result...",
            category=ArtifactCategory.DOCUMENT
        )
        
        # Read artifact from upstream node
        research = self.get_artifact(ctx, "research_dossier")
        
        # Check if artifact exists
        if self.has_artifact(ctx, "blueprint"):
            plan = self.get_artifact(ctx, "blueprint")
        
        # List all available artifacts
        keys = self.list_artifacts(ctx)
```

### Versioning

Storing to the same key creates a new version:

```python
store.store_simple("dossier", "v1 content")
store.store_simple("dossier", "v2 content")

latest = store.get_by_key("dossier")
# latest.version = 2
# latest.parent_id = <v1 artifact id>

v1 = store.get_by_key("dossier", version=1)
# v1.content = "v1 content"
```

### Legacy Compatibility

Artifacts automatically sync to `state["outputs"]`:

```python
# Artifacts stored during execution are merged to outputs
legacy_outputs = store.to_legacy_outputs()
# {"research_dossier": "...", "blueprint": {...}}
```

---

## 3. Context Management

### Project Context Loading

The `context_loader` utility reads project context files:

```python
from nodes.utility.context_loader import read_project_contexts

# Reads all .md files from /supervisor directory
context = read_project_contexts("/path/to/project")
```

Expected directory structure:
```
project/
└── supervisor/
    ├── product.md          # Product vision
    ├── tech-stack.md       # Technology choices
    └── workflow.md         # Team processes
```

### NodeExecutionContext

Every node receives execution context:

```python
class MyNode(AtomicNode):
    async def execute(self, ctx: NodeExecutionContext, items):
        # Get project context
        project_ctx = ctx.get_project_context()
        # {"project_id": "...", "task_id": "...", "user_preferences": {...}}
        
        # Get artifact store
        store = ctx.get_artifact_store()
        
        # Get node parameters
        param = ctx.get_node_parameter("my_param", default_value)
```

---

## 4. Workflow Orchestration

### Workflow State Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Research  │────▶│  Architect  │────▶│   Builder   │
│    Fleet    │     │    Fleet    │     │    Fleet    │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
  research_dossier    blueprint         source_artifacts
       │                   │                   │
       └───────────────────┴───────────────────┘
                           │
                    ┌──────▼──────┐
                    │   Auditor   │
                    │    Fleet    │
                    └─────────────┘
                           │
                           ▼
                      audit_report
```

### Human Approval Gates

Use `ApprovalGateNode` for human-in-the-loop:

```python
from nodes.orchestration import ApprovalGateNode

# Configured in workflow graph
gate = ApprovalGateNode()
gate.gate_type = "plan"  # research, plan, implementation, custom
gate.gate_message = "Please review the plan before coding"
```

---

## 5. Fleet Architecture

### Fleet → Individual Agents

Each fleet is decomposed into individual agents:

| Fleet | Agents |
|-------|--------|
| **Research** | Scoper → Vetter → Executor → Synthesizer |
| **Architect** | Cartographer → Drafter → Grounder |
| **Builder** | Scout → Coder → Checker |
| **Auditor** | Forensic → Verdict |

### Custom Workflow Example

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│  Scoper  │────▶│ Executor │────▶│Synthesizer│
└──────────┘     └──────────┘     └──────────┘
     │                                   │
     │       ┌──────────────────────────┐│
     └──────▶│      Custom Node         │◀┘
             └──────────────────────────┘
```

---

## 6. API Reference

### Artifact Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/artifacts/types` | GET | List artifact categories |
| `/api/artifacts/{task_id}` | GET | Get task artifacts |
| `/api/artifacts/store` | POST | Store external artifact |

### Node Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/node-types` | GET | List all node types |
| `/node-types/atomic` | GET | List atomic nodes with schemas |
| `/node-types/atomic/{type_id}` | GET | Get node schema |
| `/api/agents` | GET | List all agents |

### Workflow Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/langgraph/run` | POST | Execute workflow |
| `/api/langgraph/continue` | POST | Continue paused workflow |
| `/api/langgraph/status/{run_id}` | GET | Get run status |

---

## Quick Start

1. **View Agents**: Navigate to `/agents` in dashboard
2. **Build Workflow**: Use the visual builder to connect nodes
3. **Execute**: Run workflow with input data
4. **Review Artifacts**: Check `state["artifacts"]` for outputs

For more details, see the implementation plan and codebase.
