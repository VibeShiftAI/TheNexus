---
context_type: project-workflow-map
status: active
updated_at: 2026-03-08T16:52:04.835Z
---

# Project Workflow Architecture

## Agent & Workflow Management Flow (Project Level)

This diagram illustrates how "Project Workflows" (multi-stage processes within a project) are managed and how they interact with the Feature Pipeline.

```mermaid
sequenceDiagram
    participant User
    participant Frontend as Project UI<br>(project-workflows.tsx)
    participant API as Node.js API<br>(src/server.js)
    participant Supervisor as Project Workflow Supervisor<br>(project-workflow-supervisor.js)
    participant TaskAPI as Task Pipeline API
    participant DB as Supabase DB

    %% Creation
    User->>Frontend: Select Template (e.g., Brand Development)
    Frontend->>API: POST /api/projects/:id/workflows
    API->>DB: INSERT into project_workflows (with stages from template)
    DB-->>API: Workflow Created
    API-->>Frontend: Success

    %% Execution (Start)
    User->>Frontend: Click "Start Workflow"
    Frontend->>API: POST /api/projects/:id/workflows/:wid/run
    API->>Supervisor: runProjectWorkflowSupervisor(action: 'start')
    
    rect rgb(240, 248, 255)
        note right of Supervisor: Stage Initialization
        Supervisor->>DB: Update status to 'in_progress'
        Supervisor->>Supervisor: Identify tasks for first stage (from STAGE_TASK_GENERATORS)
        
        loop For Each Task in Stage
            Supervisor->>DB: createTask() with stage context
            Supervisor->>Supervisor: Append spawned task IDs to workflow outputs[stage]
        end
        
        Supervisor->>DB: Update supervisor_status 'running'
    end
    
    Supervisor-->>API: Success (Tasks Spawned)
    API-->>Frontend: 200 OK

    %% Task Pipeline Interaction
    note over User, DB: Tasks are now processed in the standard Task Pipeline (Research -> Plan -> Implement)
    
    %% Progress Tracking
    Frontend->>API: GET /api/projects/:id/workflows/:wid/progress
    API->>Supervisor: getWorkflowProgress()
    Supervisor->>DB: checkStageCompletion() (queries status of spawned tasks)
    DB-->>Supervisor: Task statuses (e.g., [complete, idea])
    Supervisor-->>API: Progress Data (e.g., 50% complete)
    API-->>Frontend: Return Progress

    %% Advancing
    note over User, Frontend: When all tasks in stage are 'complete'
    User->>Frontend: Click "Advance Stage"
    Frontend->>API: POST /api/projects/:id/workflows/:wid/advance
    API->>Supervisor: runProjectWorkflowSupervisor(action: 'advance')
    
    rect rgb(240, 248, 255)
        note right of Supervisor: Stage Advancement
        Supervisor->>DB: Mark current stage 'complete' in outputs
        Supervisor->>DB: Update current_stage to next ID
        Supervisor->>Supervisor: Gather context from previous stage tasks
        Supervisor->>Supervisor: Spawn tasks for NEW stage with gathered context
    end
    
    Supervisor-->>API: Success (New Stage Started)
    API-->>Frontend: 200 OK
```

## Data Model Relationships

```mermaid
erDiagram
    projects ||--o{ project_workflows : contains
    project_workflows ||--o{ tasks : "spawns (linked via metadata)"
    
    project_workflows {
        uuid id
        uuid project_id
        string workflow_type "brand-dev, documentation, etc"
        string status "idea|in_progress|review|complete"
        string current_stage
        jsonb stages "List of stage definitions"
        jsonb outputs "Map of stage -> {tasks: uuid[], status: string}"
    }
    
    tasks {
        uuid id
        uuid project_id
        string name "[Stage] Task Name"
        string status
        jsonb metadata "Contains sourceWorkflow, workflowStage"
    }
    
    workflow_templates ||--|{ project_workflows : "provides stages"
    workflow_templates {
        uuid id
        string level "project"
        jsonb stages
    }
```