---
context_type: workflow
status: active
updated_at: 2026-02-27T01:49:15.465Z
---

---
context_type: workflow
status: current
updated_at: 2026-02-23T14:40:00.000Z
---

# Development Workflow

## Task Pipeline

All development work in The Nexus follows a ticket-based pipeline. Tasks are created either manually or spawned by project workflows, then processed through specialized AI agents.

### Task Lifecycle

```
idea → researching → researched → planning → planned → implementing → testing → complete
                                                                                ↘ rejected
                                                                                ↘ cancelled
```

### Workflow Types

Each task is assigned a workflow type that determines how it's executed:

| Type | Description | Execution |
|------|-------------|-----------|
| **Nexus Prime** | Standard AI-driven development | Fully autonomous: research → plan → implement → commit |
| **Human Action** | Tasks requiring manual work | Dashboard tracks status; human completes externally |
| **Custom / Direct** | Tasks using custom workflow templates | Executes a user-defined workflow graph |

### Ticket Format

Tasks follow a structured Markdown format:
- **Workflow**: The workflow type to use
- **Goal**: What the task should accomplish
- **Context & Execution**: Background info and implementation guidance
- **Acceptance Criteria**: How to verify the task is complete

## Agent Architecture

### Supervisor Pattern

The Supervisor Agent orchestrates the task pipeline by:
1. **Analyzing state** — checking the task ledger for completed/pending phases
2. **Routing** — dispatching to the appropriate specialist agent
3. **Tracking** — recording results in the task ledger
4. **Error handling** — invoking failure analysis on agent errors

### Agent Routing Map

| Intent | Agent | Model | Purpose |
|--------|-------|-------|---------|
| Research (Quick) | Quick Research | Gemini Pro | Fast feasibility analysis |
| Research (Deep) | Deep Research | Gemini Deep Research API | Thorough codebase analysis |
| Plan | Plan Generator | Claude Sonnet | Detailed implementation steps |
| Implement | Implementation Agent | Claude Opus / Gemini Pro | Code generation with tool use |
| Review | Code Critic | Gemini Flash | Pre-write code review |
| Commit | Commit Generator | Gemini Flash | Git commit message generation |

### Human-in-the-Loop Checkpoints

The pipeline pauses for human review at key stages:
- **After Research**: User reviews and approves/rejects research findings
- **After Planning**: User reviews and approves/rejects the implementation plan
- **After Implementation**: User reviews walkthrough, then approves (commit) or cancels (git restore)

## Multi-Level Workflow Orchestration

### Three Levels

```
Dashboard Initiatives (cross-project)
  └── Project Workflows (multi-stage within a project)
       └── Task Pipeline (individual task execution)
```

### Dashboard Initiatives
Cross-project workflows (e.g., "Security Audit all projects"). A supervisor iterates over target projects, executing a template workflow for each.

### Project Workflows
Multi-stage processes within a single project (e.g., "Brand Development", "Full Feature Pipeline"). Each stage spawns tasks that flow through the standard task pipeline. Stages advance when all spawned tasks complete.

### Visual Workflow Builder
Users can design custom workflows using the React Flow-based builder:
- Drag-and-drop atomic nodes (research, plan, implement, etc.)
- Connect nodes with edges to define execution flow
- Configure per-node parameters (model, agent, tools)
- Save as reusable templates

## Cortex (System 2 Planning)

For complex tasks, the Cortex system provides deeper reasoning:
1. **Lead Architect** generates a structured plan with tickets
2. **Council Review** — specialized reviewers (Frontend, Systems, QA) evaluate the plan
3. **Vote & Revise** — council votes are tallied; plan is revised if needed
4. **Compile** — approved plans are compiled into actionable tasks in The Nexus

## Git Integration

All code changes follow a structured git workflow:
- **Automated commits** with AI-generated conventional commit messages
- **Git restore** for cancelled implementations (clean rollback)
- **Branch management** via the dashboard
- **Remote management** for pushing to GitHub/GitLab

## Development Commands

### Starting The Nexus
```bash
# Full stack (with Cloudflare tunnel)
start-nexus.bat

# Local development only
start-local.bat

# Stop all services
stop-nexus.bat
```

### Services
| Service | Port | Technology |
|---------|------|------------|
| Dashboard | 3000 | Next.js |
| Node API | 4000 | Express |
| LangGraph Engine | 8000 | FastAPI / Uvicorn |