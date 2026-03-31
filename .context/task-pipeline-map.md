---
context_type: task-pipeline-map
status: active
updated_at: 2026-03-31T01:20:31.210Z
---

# Task Pipeline Architecture

## Overview

The Task Pipeline architecture has migrated from a hardcoded agent routing map to a dynamic **Atomic Node Registry**. This shift enables composable, n8n-style workflows where specific units of logic (Nodes) are assembled dynamically rather than following a rigid `Research -> Plan -> Implement` sequence.

## Atomic Node Registry

The core of the new system is the **Atomic Node Registry** (`nexus-builder/nodes/registry.py`). Instead of monolithic "Agents", the system defines atomic "Nodes".

- **Definition**: A Node is a discrete unit of execution (e.g., `ResearchNode`, `PlanNode`, `CodeEditNode`).
- **Registration**: Nodes are registered in a central repository, making them available to the Graph Builder.
- **Configurability**: Each node exposes a schema for configuration, allowing the frontend or API to parameterize execution (e.g., setting the model, temperature, or specific prompt templates).

## Universal Artifact System (ArtifactStore)

To facilitate robust data exchange between atomic nodes, the system employs a **Universal Artifact System**.

- **ArtifactStore**: A central state object that holds structured data produced by nodes.
- **Data Flow**: Unlike simple string passing, nodes consume specific Artifacts (e.g., `ResearchReport`, `FileContext`) and produce new ones (e.g., `ImplementationPlan`, `CodeDiff`).
- **Persistence**: Artifacts are serialized and stored, allowing workflows to pause, resume, or be inspected at any stage.

## Architecture Diagrams

### Node Registration & Execution

This diagram illustrates how atomic nodes are registered, compiled into a LangGraph, and executed using the ArtifactStore.

```mermaid
flowchart TB
    subgraph Registry ["Atomic Node Registry"]
        direction TB
        RN[Research Node]
        PN[Plan Node]
        IN[Implement Node]
        VN[Verify Node]
    end

    subgraph Builder ["Graph Builder"]
        Config[Workflow Config JSON]
        Compiler[Graph Compiler]
    end

    subgraph Runtime ["LangGraph Engine"]
        Store[("ArtifactStore<br>(Universal State)")]
        
        Start((Start)) --> NodeA[Execute Node A]
        NodeA --> NodeB[Execute Node B]
        NodeB --> End((End))
        
        NodeA <-->|Read/Write Artifacts| Store
        NodeB <-->|Read/Write Artifacts| Store
    end

    Registry -->|Provides Logic| Compiler
    Config -->|Defines Structure| Compiler
    Compiler -->|Instantiates| Runtime
```

### Standard Task Workflow (Node Composition)

While the system is dynamic, the standard "Task" workflow is now a specific composition of atomic nodes.

```mermaid
sequenceDiagram
    participant Orch as Orchestrator
    participant Store as ArtifactStore
    participant RN as Research Node
    participant PN as Plan Node
    participant IN as Implement Node

    Orch->>Store: Initialize (Task Description)
    
    %% Research Phase
    Orch->>RN: Execute
    RN->>Store: Read (Task Description)
    RN->>RN: Perform Research (LLM + Tools)
    RN->>Store: Write (Research Artifact)
    
    %% Planning Phase
    Orch->>PN: Execute
    PN->>Store: Read (Research Artifact)
    PN->>PN: Generate Plan
    PN->>Store: Write (Plan Artifact)
    
    %% Implementation Phase
    Orch->>IN: Execute
    IN->>Store: Read (Plan Artifact)
    IN->>IN: Apply Code Changes
    IN->>Store: Write (Diff/Result Artifact)
    
    Orch->>Store: Finalize Task
```

## Key Components

| Component | Description |
| :--- | :--- |
| **Node Registry** | Python module (`nexus-builder/nodes/registry.py`) containing all available workflow nodes. |
| **ArtifactStore** | The shared state dictionary passed through the LangGraph, replacing unstructured chat history. |
| **Graph Compiler** | Converts a JSON workflow definition into a runnable LangGraph `StateGraph`. |
| **Atomic Node** | A Python class/function implementing a specific step (e.g., `GitCommitNode`, `LLMGenerateNode`). |

## Migration Status

- [x] **Legacy**: Hardcoded `Supervisor -> Agent` routing.
- [x] **Current**: Atomic Nodes defined in Registry.
- [x] **State**: `ArtifactStore` implemented for structured data passing.
- [ ] **Future**: Full UI for drag-and-drop node composition (n8n style).