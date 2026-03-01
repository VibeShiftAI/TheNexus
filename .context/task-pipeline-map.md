---
context_type: task-pipeline-map
status: draft
updated_at: 2026-03-01T19:12:44.096Z
---

# Task Pipeline Architecture

## Task-Level Workflow Management

This diagram illustrates how individual tasks are processed through the Task Pipeline, driven by the Nexus Prime workflow.

### Nexus Prime Pipeline Flow

```mermaid
stateDiagram-v2
    [*] --> idea
    idea --> researching: Trigger (User/Workflow)

    state researching {
        [*] --> QuickOrDeep
        QuickOrDeep --> QuickResearch: Quick Mode
        QuickOrDeep --> DeepResearch: Deep Mode
        QuickResearch --> ResearchComplete
        DeepResearch --> ResearchComplete
    }

    researching --> researched: Research Output Saved
    researched --> HumanReview1: Awaiting Approval

    HumanReview1 --> planning: Approved
    HumanReview1 --> rejected: Rejected

    state planning {
        [*] --> PlanGeneration
        PlanGeneration --> CouncilReview: Cortex Path (Optional)
        PlanGeneration --> PlanComplete: Direct Path
        CouncilReview --> PlanComplete
    }

    planning --> planned: Plan Output Saved
    planned --> HumanReview2: Awaiting Approval

    HumanReview2 --> implementing: Approved
    HumanReview2 --> rejected: Rejected

    state implementing {
        [*] --> AgentExecution
        AgentExecution --> CriticReview: Write File
        CriticReview --> AgentExecution: Issues Found
        CriticReview --> AgentExecution: Approved
        AgentExecution --> WalkthroughGenerated: Agent Complete
    }

    implementing --> testing: Walkthrough Ready
    testing --> HumanReview3: Awaiting Approval

    HumanReview3 --> complete: Approve & Commit
    HumanReview3 --> implementing: Revise
    HumanReview3 --> cancelled: Cancel & Git Restore

    complete --> [*]
    rejected --> [*]
    cancelled --> [*]
```

### Agent Routing Map

```mermaid
graph LR
    Supervisor[Supervisor Service]

    subgraph Intents
        Research[Intent: Research]
        Plan[Intent: Plan]
        Implement[Intent: Implement]
        Commit[Intent: Commit]
    end

    subgraph Agents
        Deep[Deep Research Agent<br>Gemini Deep Research API]
        Quick[Quick Research Agent<br>Gemini Pro]
        Planner[Plan Generator<br>Claude Sonnet]
        Coder[Implementation Agent<br>Claude Opus / Gemini Pro]
        Critic[Code Critic<br>Gemini Flash]
        GitBot[Commit Generator<br>Gemini Flash]
    end

    Supervisor --> Research
    Supervisor --> Plan
    Supervisor --> Implement
    Supervisor --> Commit

    Research --> Deep
    Research --> Quick
    Plan --> Planner
    Implement --> Coder
    Implement -.-> Critic
    Commit --> GitBot
```

### Data Model & State Tracking

Tasks maintain their state via the `tasks` table columns.

```mermaid
erDiagram
    tasks {
        uuid id
        string status "idea|researching|planning|...|complete"
        string supervisor_status "idle|routing|delegating"
        text description "Ticket: Workflow, Goal, Context, Criteria"
        text research_output
        text plan_output
        text walkthrough
        jsonb task_ledger "Array of completed steps"
        jsonb supervisor_details "Current supervisor state"
    }

    %% JSONB Structure for task_ledger entries
    task_ledger_entry {
        string taskId
        string status "completed|failed"
        string agent
        string intent
        timestamp completedAt
    }
```

---
context_type: task-pipeline-map
status: active
updated_at: 2026-03-01T19:08:11.561Z
---
