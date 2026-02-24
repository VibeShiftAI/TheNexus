---
context_type: dashboard-workflow-map
status: current
updated_at: 2026-02-23T14:40:00.000Z
---

# Dashboard Workflow Architecture

## Agent & Workflow Management Flow (Dashboard Level)

This diagram illustrates how "Dashboard Initiatives" (cross-project workflows) are created, managed, and executed.

```mermaid
sequenceDiagram
    participant User
    participant Frontend as Dashboard UI<br>(dashboard-initiatives.tsx)
    participant API as Node.js API<br>(src/server.js)
    participant Supervisor as Supervisor Service<br>(dashboard-initiative-supervisor.js)
    participant DB as Supabase DB
    participant Python as Python Engine<br>(LangGraph)

    %% Creation
    User->>Frontend: Create Initiative (e.g., Security Sweep)
    Frontend->>API: POST /api/initiatives
    API->>DB: INSERT into dashboard_initiatives
    DB-->>API: Initiative Created
    API-->>Frontend: Success

    %% Execution
    User->>Frontend: Click "Run"
    Frontend->>API: POST /api/initiatives/:id/run
    API->>Supervisor: runDashboardInitiativeSupervisor()
    API-->>Frontend: 200 OK (Processing in Background)
    
    rect rgb(240, 248, 255)
        note right of Supervisor: Supervisor Orchestration
        Supervisor->>DB: Update status to 'initializing'
        
        %% Template Resolution
        Supervisor->>Python: GET /templates (Fetch all templates)
        Python->>DB: SELECT * FROM workflow_templates WHERE level='dashboard'
        DB-->>Python: Templates
        Python-->>Supervisor: Return Templates
        Supervisor->>Supervisor: Match Initiative Type to Template
        
        %% Execution Loop
        loop For Each Target Project
            Supervisor->>DB: Update project status 'in_progress'
            
            Supervisor->>Python: POST /graph/run
            note right of Python: Graph Execution
            Python->>Python: Compile StateGraph from Template
            Python->>Python: Execute Nodes (using Agent Configs)
            
            %% Agent Interaction (Implicit in Python Nodes)
            Python->>DB: Fetch agent_configs (if needed)
            
            %% Output Sync
            Python->>API: POST /api/langgraph/sync-output
            API->>DB: Update initiative_project_status
            
            Python-->>Supervisor: Run ID / Success
            Supervisor->>DB: Update project status 'complete'
        end
        
        Supervisor->>DB: Update initiative status 'complete'
    end
```

## Data Model Relationships

```mermaid
erDiagram
    dashboard_initiatives ||--o{ initiative_project_status : tracks
    dashboard_initiatives {
        uuid id
        string name
        string workflow_type
        jsonb configuration
    }
    
    projects ||--o{ initiative_project_status : targets
    
    workflow_templates ||--|{ dashboard_initiatives : "instantiated by type match"
    workflow_templates {
        uuid id
        string name
        string level "dashboard|project|feature"
        jsonb nodes
        jsonb edges
    }
    
    agent_configs ||--o{ workflow_templates : "referenced by node config"
    agent_configs {
        string id
        string default_model
        string system_prompt
    }
```