# The Nexus 🌐

**Personal Developer Operating System** — A hybrid local-cloud platform for managing projects, orchestrating AI agents, and automating development workflows.

[![Live](https://img.shields.io/badge/Live-nexus.vibeshiftai.com-blue)](https://nexus.vibeshiftai.com)
[![Node.js](https://img.shields.io/badge/Backend-Node.js%2F%20Express-green)](https://nodejs.org)
[![Next.js](https://img.shields.io/badge/Frontend-Next.js%2016-black)](https://nextjs.org)

---

## 📋 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Project Discovery](#project-discovery)
- [API Reference](#api-reference)
- [AI Integration](#ai-integration)
- [Agent Manager](#agent-manager)
- [Supervisor System](#supervisor-system)
- [Scheduler System](#scheduler-system)
- [System Monitor](#system-monitor)
- [MCP Server](#mcp-server)
- [Task Manager](#task-manager)
- [Multi-Level Workflow System](#multi-level-workflow-system)
- [Agent System](#agent-system)
- [Dashboard Components](#dashboard-components)
- [Cloudflare Tunnel](#cloudflare-tunnel)
- [Development](#development)
- [Known Complexities](#known-complexities)

---

## Overview

The Nexus transforms a local development machine into a connected fortress, bridging your laptop's filesystem with a web-accessible dashboard. It provides:

- **Project Discovery** — Auto-detect and display projects from `~/Projects` directory
- **Git Management** — Initialize repos, add remotes, commit and push with AI-generated messages
- **AI Terminal** — Multi-provider chat interface (Google Gemini, Anthropic Claude, OpenAI)
- **Task Manager** — Full AI-powered workflow: Research → Plan → Implement → Complete
- **Agent Manager** — Configure and customize AI agents via dashboard UI
- **Supervisor Agent** — Orchestrates task manager with dynamic intent-based routing
- **Scheduler System** — Cron-based automated agent task execution with memory and health monitoring
- **System Monitor** — Real-time CPU, memory, and port monitoring dashboard
- **Code Critic** — AI-powered code review before file writes
- **MCP Server** — Model Context Protocol integration for seamless AI agent interoperability
- **Secure Access** — Cloudflare Tunnel for Zero Trust access to local resources

### 🚀 Universal Agent Designer (Nexus Protocol)

The Nexus Protocol upgrade transforms the Agent Designer into a universal, cross-domain orchestration platform:

- **MCP Tool Dock** — Drag-and-drop MCP server binding with live tool discovery
- **Persona Forge Wizard** — 6-step agent configuration (domain, objective, autonomy, personality, output schema, guardrails)
- **Visual Graph Canvas** — Enhanced node types (ProcessorCard, ActionNode, SuperNode) with Traffic Light edge styling
- **State Inspector** — Live debugging with schema editor, trace viewer, cost estimation, and "Holodeck" simulation
- **Starter Templates** — 8 domain-specific templates (Business, Creative, Productivity, Coding, HR, Legal, Finance, Travel)
- **Governance & Security** — Rate limiting, OAuth-style MCP scopes, comprehensive audit logging

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        CLOUDFLARE TUNNEL                          │
│                    nexus.vibeshiftai.com                          │
└───────────────────────────┬──────────────────────────────────────┘
                            │
         ┌──────────────────┴──────────────────┐
         │                                      │
         ▼                                      ▼
┌─────────────────────┐              ┌───────────────────────────────────┐
│   DASHBOARD (UI)    │              │          BACKEND STACK            │
│   Next.js:3000      │───REST───▶   │                                   │
│                     │              │  ┌──────────────┐ ┌────────────┐  │
│  • Project Cards    │              │  │  LOCAL API   │ │ PYTHON API │  │
│  • AI Terminal      │              │  │ Express:4000 │ │FastAPI:8000│  │
│  • Task Manager     │              │  └──────┬───────┘ └──────┬─────┘  │
│  • Agent Manager    │              │         │                │        │
│  • System Monitor   │              │         ▼                ▼        │
│  • Activity Feed    │              │  ┌──────────────┐ ┌────────────┐  │
└─────────────────────┘              │  │  Services    │ │ LangGraph  │  │
                                     │  │  Supervisor  │ │ Core Agent │  │
                                     │  │  Scheduler   │ │ Engine     │  │
                                     │  └──────────────┘ └────────────┘  │
                                     └───────────────────────────────────┘
```

### Directory Structure

```
TheNexus/                       # Flat monorepo
├── server/                     # Node.js Express backend
│   ├── server.js               # Main API server
│   ├── scanner.js              # Project discovery engine
│   ├── mcp.js                  # MCP Server (stdio)
│   ├── agent/                  # Multi-provider AI agent
│   ├── services/               # Supervisor, critic, system monitor
│   ├── scheduler/              # Cron-based automation
│   ├── tools/                  # Filesystem & command tools
│   └── utils/                  # Retry utilities
├── dashboard/                  # Next.js 16 frontend
│   └── src/
│       ├── app/                # App Router pages
│       ├── components/         # AI Terminal, Agent Manager, etc.
│       └── lib/nexus.ts        # API client
├── cortex/                     # Python AI Brain (LangGraph)
│   ├── agents/                 # Planner, Council, Browser, Compiler
│   ├── api/                    # Terminal bridge, routes
│   ├── core/                   # Orchestrator graph
│   ├── schemas/                # Pydantic state models
│   ├── blackboard/             # Research blackboard
│   └── llm_factory.py          # Multi-provider LLM routing
├── nexus-builder/              # Python graph engine & workflow
│   ├── main.py                 # FastAPI entry point
│   ├── graph_engine.py         # Workflow graph engine
│   └── researcher/             # Research agent
├── sandbox/                    # Secure code execution sandbox
├── config/                     # Merged configuration
│   ├── model_registry.yaml     # LLM model configs
│   ├── prompts.yaml            # System prompts
│   └── nexus/                  # Nexus-specific config
├── tests/
│   ├── cortex/                 # AI brain tests
│   └── nexus-builder/          # Builder tests
├── db/                         # Supabase schema & migrations
├── docker/                     # All Dockerfiles & compose files
├── docs/                       # Documentation
├── scripts/                    # Utility scripts
├── package.json                # Node.js dependencies (root)
├── requirements.txt            # Python dependencies
├── pytest.ini                  # Test configuration
├── start-nexus.bat             # Windows full startup
├── start-local.bat             # Local dev startup (no tunnel)
└── .env                        # Environment variables
```

---

## Quick Start

### Prerequisites

- **Node.js** 18+ 
- **npm** or **pnpm**
- **cloudflared** (for remote access)
- API keys for AI providers (optional)

### Installation

```bash
# Clone the repository
git clone https://github.com/Guatapickl/TheNexus.git
cd TheNexus

# Install backend dependencies
npm install

# Install dashboard dependencies
cd dashboard
npm install
cd ..

# Create environment file
cp .env.example .env  # Then edit with your API keys
```

### Running

**Option 1: Using the startup script (Windows)**

```batch
start-nexus.bat
```

This opens three windows:
1. Cloudflare Tunnel (routing traffic)
2. Backend API (port 4000)
3. Dashboard (port 3000)

**Option 2: Manual startup**

```bash
# Terminal 1 - Backend
node server/server.js

# Terminal 2 - Dashboard
cd dashboard && npm run dev

# Terminal 3 - Tunnel (optional)
cloudflared tunnel --config cloudflared_config.yml run vibe-nexus
```

### Access Points

| Endpoint | URL |
|----------|-----|
| Dashboard (Local) | http://localhost:3000 |
| API (Local) | http://localhost:4000/api/projects |
| Dashboard (Public) | https://nexus.vibeshiftai.com |

---

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# Required: Set your projects directory
PROJECT_ROOT=C:/Projects

# AI Providers (at least one required for AI features)
GOOGLE_API_KEY=your-gemini-api-key
GEMINI_API_KEY=your-gemini-api-key       # Alternative to GOOGLE_API_KEY
ANTHROPIC_API_KEY=your-claude-api-key
OPENAI_API_KEY=your-openai-api-key
```

> **Important:** `GOOGLE_API_KEY` and `GEMINI_API_KEY` are interchangeable. The system checks both.

### AI Model Configuration

The backend uses task-specific model routing defined in `server.js`:

```javascript
const AI_MODELS = {
    plan: {
        provider: 'anthropic',
        model: 'claude-opus-4-5-20251101',
        description: 'Detailed Implementation Planning'
    },
    research: {
        provider: 'google',
        model: 'gemini-3-pro-preview',
        thinkingEnabled: true,
        thinkingConfig: { thinking_level: 'HIGH' }
    },
    implementation: {
        provider: 'anthropic',
        model: 'claude-opus-4-5-20251101'
    },
    quick: {
        provider: 'google',
        model: 'gemini-2.5-flash'
    }
};
```

---

## Project Discovery

### How Projects Are Detected

The scanner (`server/scanner.js`) scans `PROJECT_ROOT` and detects projects using a priority-based system:

1. **Configured Projects** — Has a `project.json` file (full metadata)
2. **Unconfigured Projects** — Has `package.json`, `requirements.txt`, or `.git`
3. **Empty Folders** — Ignored

### project.json Schema

Create a `project.json` in any project to configure its appearance:

```json
{
    "name": "MyProject",
    "type": "web-app",           // "game" | "tool" | "web-app"
    "description": "A cool project",
    "created": "2025-12-16T06:43:35-05:00",
    "vibe": "immaculate",
    "tasks": [
        "Task 1",
        "Task 2"
    ],
    "stack": {
        "backend": "Node.js",
        "frontend": "React"
    },
    "urls": {
        "production": "https://myproject.com",
        "repo": "https://github.com/user/myproject"
    },
    "tasksList": []        // Managed by the Task Manager
}
```

---

## Project Context Manager

Each project can store context documents that are injected into AI prompts for better understanding:

| Context Type | Description |
|-------------|-------------|
| `product` | Product Vision - High-level product strategy and goals |
| `tech-stack` | Tech Stack - Defined technologies and architectural choices |
| `product-guidelines` | Guidelines - Design principles and product guidelines |
| `workflow` | Workflow - Team processes and ways of working |

**UI Component:** `project-context-manager.tsx` on the project page provides a tabbed interface for editing each context type.

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects/:id/context` | Get all contexts for a project |
| `PUT` | `/api/projects/:id/context/:type` | Update a specific context type |

**Usage:** Context is automatically injected when agents run tasks scoped to a project, providing consistent product knowledge across all AI interactions.

---

## API Reference

### Core Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | List all discovered projects |
| `GET` | `/api/projects/:id` | Get single project details |
| `GET` | `/api/projects/:id/status` | Get git status |
| `GET` | `/api/projects/:id/commits` | Get commit history (max 50) |
| `GET` | `/api/projects/:id/ping` | Ping production URL |
| `POST` | `/api/projects/scaffold` | Create new project |

### Git Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/projects/:id/git/init` | Initialize git |
| `POST` | `/api/projects/:id/git/remote` | Add remote origin |
| `POST` | `/api/projects/:id/commit-push` | Commit and push changes |
| `GET` | `/api/projects/:id/diff` | Get current diff |
| `POST` | `/api/projects/:id/generate-commit-message` | AI-generate commit message |

### System Monitor

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/system/status` | Get CPU, memory, and port info |
| `GET` | `/api/system/usage-stats` | Get AI token usage statistics |

### Agent Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents/config` | Get all agent configurations |
| `PUT` | `/api/agents/:id` | Update agent configuration |
| `PUT` | `/api/agents/critic/toggle` | Enable/disable code critic |

### Scheduler

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/scheduler/tasks` | List all scheduled tasks |
| `POST` | `/api/scheduler/tasks` | Create a scheduled task |
| `PUT` | `/api/scheduler/tasks/:id` | Update a scheduled task |
| `DELETE` | `/api/scheduler/tasks/:id` | Delete a scheduled task |
| `POST` | `/api/scheduler/tasks/:id/run` | Manually trigger a task |
| `GET` | `/api/scheduler/tasks/:id/history` | Get execution history |

### Pin Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/pins` | Get pinned project IDs |
| `POST` | `/api/projects/:id/pin` | Pin a project |
| `DELETE` | `/api/projects/:id/pin` | Unpin a project |

### AI Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/ai/chat` | Send message to AI |

**Request Body:**

```json
{
    "message": "Your message",
    "modelConfig": {
        "id": "gemini-2.5-flash",
        "apiModelId": "gemini-2.5-flash",
        "provider": "Google",
        "isThinking": false,
        "parameters": {}
    },
    "mode": "agent",            // "agent" | "code" | default
    "history": [],              // Previous messages
    "projectId": "MyProject"    // Optional: scope to project
}
```

### Activity Feed

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/activity` | Get recent commits across all projects |

---

## AI Integration

### Multi-Provider Support

The system supports three AI providers with automatic format conversion:

#### Google Gemini
- Models: `gemini-2.5-flash`, `gemini-3-pro-preview`, `gemini-3-flash`
- Supports: Thinking config (`thinking_level`, `thinking_budget`)
- Used for: Research (with thinking), quick tasks

#### Anthropic Claude
- Models: `claude-sonnet-4-20250514`, `claude-opus-4-5-20251101`
- Supports: Extended thinking (`budget_tokens`)
- Used for: Planning, implementation

#### OpenAI
- Models: `gpt-4o`, `gpt-5.2`, etc.
- Supports: `reasoning_effort`
- Note: Full implementation pending in chat endpoint

### AI Terminal Component

The dashboard includes a full-featured AI terminal (`dashboard/src/components/ai-terminal.tsx`) with:

- Model selector with provider-specific configurations
- Thinking mode toggle
- Conversation history
- Project scoping
- Streaming responses

---

## Agent Manager

The Agent Manager (`dashboard/src/components/agent-manager.tsx`) provides a dashboard UI for configuring AI agents without editing code.

### Features

- **View all configured agents** with their descriptions and default models
- **Edit system prompts** to customize agent behavior
- **Change default models** for each agent type
- **Toggle Code Critic** on/off globally
- **Live save** with visual feedback

### Configured Agents

Agents are defined in `agent-config.json`:

| Agent ID | Name | Purpose |
|----------|------|---------|
| `chat` | Chat Agent | Interactive terminal chat |
| `implementation` | Implementation Agent | Autonomous code implementation |
| `auto-research` | Auto-Research | Suggests new features by analyzing codebase |
| `quick-research` | Quick Research | Fast feasibility analysis |
| `deep-research` | Deep Research | Thorough research with Google Deep Research |
| `plan-generator` | Plan Generator | Creates detailed implementation plans |
| `failure-analyst` | Failure Analyst | Analyzes implementation failures |
| `commit-generator` | Commit Generator | Generates git commit messages |
| `supervisor` | Supervisor Agent | Orchestrates task manager |
| `critic` | Code Critic | Reviews code before writes |

### Reasoning Levels

The system supports three reasoning levels:

| Level | Description | Reflection | Thinking Level | Max Turns |
|-------|-------------|------------|----------------|-----------|
| **Vibe** | Fast execution for simple tasks | Disabled | LOW | 20 |
| **Standard** | Single-step reflection for typical tasks | Enabled | MEDIUM | 50 |
| **Deep** | Multi-path exploration for complex work | Enabled | HIGH | 100 |

---

## Supervisor System

The Supervisor Service (`server/services/supervisor.js`) replaces the legacy autopilot with a more robust orchestration pattern.

### Key Concepts

#### Task Ledger
Tracks completed tasks to prevent re-execution. Each task maintains a ledger of:
- Completed phases
- Phase outputs
- Timestamps

#### Worker Routing
The Supervisor analyzes task status and routes to the appropriate worker:

```javascript
const WORKER_ROUTES = {
    idea: 'research',       // Route ideas to research phase
    researched: 'planning', // Route researched to planning
    planned: 'implement',   // Route planned to implementation
    implementing: 'test',   // Route implementing to testing
    testing: 'complete'     // Route tested to completion
};
```

#### Auto-Approve Mode
When enabled, the supervisor automatically approves phases without user intervention:

```javascript
await runSupervisor({
    projectPath: '/path/to/project',
    projectId: 'MyProject',
    taskId: 'task-123',
    researchLevel: 'quick',  // 'quick' or 'deep'
    autoApprove: true,       // Full autopilot mode
    handlers: { ... }
});
```

### Supervisor Status

| Status | Description |
|--------|-------------|
| `idle` | No active orchestration |
| `routing` | Determining next task |
| `delegating` | Dispatching to worker |
| `monitoring` | Watching worker execution |
| `completed` | All phases complete |
| `error` | Error during orchestration |

---

## Scheduler System

The Scheduler System (`server/scheduler/`) provides cron-based automation for AI agent tasks.

### Core Components

#### SchedulerService
The main scheduling engine that:
- Polls for due tasks
- Dispatches tasks for execution
- Manages concurrent execution limits
- Handles retries and failures
- Updates task state and logs

#### TaskStore
File-based persistent storage for:
- Scheduled task definitions
- Execution logs
- Agent memories

#### AgentMemorySystem
Provides episodic memory for agent continuity:
- Stores decisions, observations, feedback, errors, insights
- Retrieves relevant memories for context
- Consolidates old memories into summaries

#### SandboxExecutor
Secure execution environment with:
- Resource limits (time, memory)
- Command validation and blocking
- Allowed commands whitelist
- Process management

#### HealthMonitor
System health checks and alerting:
- Component status monitoring
- Failure notifications
- Recovery suggestions
- Health history tracking

### Built-in Agent Types

| Type | Description |
|------|-------------|
| `dependency-audit` | `npm audit` and outdated package checks |
| `git-status` | Repository status and contributor analysis |
| `code-summary` | Code metrics and TODO finder |
| `security-sweep` | Comprehensive security scanning |
| `custom` | User-defined tasks |

### Cron Expression Support

The CronParser supports:
- Standard 5-field cron expressions
- Presets: `@hourly`, `@daily`, `@weekly`, `@monthly`
- Natural language conversion: "every 2 hours", "at 9am on monday"

### Example: Creating a Scheduled Task

```javascript
const { createSchedulerSystem } = require('./src/scheduler');

const system = await createSchedulerSystem({
    dataDir: './data/scheduler'
}).start();

await system.taskStore.createTask({
    name: 'Daily Dependency Audit',
    description: 'Check for vulnerabilities and outdated packages',
    cronExpression: '0 9 * * *',  // Every day at 9 AM
    agentType: 'dependency-audit',
    agentConfiguration: {
        checkVulnerabilities: true,
        checkOutdated: true,
        severityThreshold: 'moderate'
    },
    projectId: 'TheNexus'
});
```

---

## System Monitor

The System Monitor (`server/services/system-monitor.js`) provides real-time system resource information.

### Features

- **CPU Usage** — Current load percentage and core count
- **Memory Usage** — Total, used, free, and percentage
- **Port Monitoring** — Active listening ports with process identification
- **Dev Server Detection** — Automatic labeling of known ports (3000=Next.js, 4000=Express, etc.)

### Dashboard Integration

The Resource Monitor component (`dashboard/src/components/resource-monitor.tsx`) displays:
- Gauge-style CPU and memory meters
- Token usage tracking with historical graphs
- Active port list with hints
- Auto-refresh every 5 seconds

### Known Port Mappings

| Port | Framework |
|------|-----------|
| 3000 | Next.js/React |
| 3001 | Next.js (alt) |
| 4000 | Express/API |
| 5000 | Flask/Vite |
| 5173 | Vite |
| 8000 | Django/FastAPI |
| 8080 | Generic HTTP |
| 27017 | MongoDB |
| 5432 | PostgreSQL |
| 3306 | MySQL |
| 6379 | Redis |

---

## MCP Server

The Nexus implements an **MCP (Model Context Protocol) Server** for AI agent integration.

### Starting the MCP Server

```bash
node server/mcp.js
```

The server runs on stdio and can be connected via any MCP-compatible client.

### Available Resources

| URI | Description |
|-----|-------------|
| `projects://list` | JSON list of all projects |

### Available Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `scaffold_new_vibe` | Create a new project | `name`, `type` |
| `init_git` | Initialize git in project | `project_name` |
| `add_remote` | Add git remote | `project_name`, `remote_url` |
| `commit_and_push` | Commit and push changes | `project_name`, `message` |

### MCP Integration Example

Connect to the Nexus MCP server from Antigravity or other MCP clients:

```json
{
    "name": "local-nexus",
    "command": "node",
    "args": ["C:\\Projects\\TheNexus\\server\\mcp.js"]
}
```

> **Known Issue:** The dotenv 17.x library outputs to stdout, which breaks MCP protocol. This is suppressed via `DOTENV_CONFIG_QUIET=true` at the top of `mcp.js`.

---

## Task Manager

The Nexus includes a complete AI-powered task development workflow:

```
┌─────────┐      ┌────────────┐      ┌─────────┐      ┌──────────────┐      ┌──────────┐
│  IDEA   │ ──▶  │ RESEARCHING│ ──▶  │RESEARCHED│ ──▶ │   PLANNING   │ ──▶  │  PLANNED │
└─────────┘      └────────────┘      └─────────┘      └──────────────┘      └──────────┘
                       │                   │                  │                   │
                   Gemini 3 Pro        User Review      Claude Opus          User Review
                   Deep Research         ↓                   ↓                   ↓
                       │            Approve/Reject     Approve/Reject      Approve/Reject
                       ▼                                                        │
                  Background                                                    ▼
                  Polling (4hr max)                                     ┌──────────────┐
                                                                        │ IMPLEMENTING │
                                                                        └──────────────┘
                                                                               │
                                                                          Claude Agent
                                                                          with Tools
                                                                               │
                                                                               ▼
                                                                        ┌──────────┐
                                                                        │ TESTING  │
                                                                        └──────────┘
                                                                               │
                                                                          User Review
                                                                               │
                                                                               ▼
                                                                        ┌──────────┐
                                                                        │ COMPLETE │
                                                                        └──────────┘
```

### Task Status States

| Status | Description |
|--------|-------------|
| `idea` | Initial state, no AI work done |
| `researching` | Deep Research Agent running (background) |
| `researched` | Research complete, awaiting approval |
| `planning` | Claude generating implementation plan |
| `planned` | Plan complete, awaiting approval |
| `implementing` | Agent executing the plan |
| `testing` | Implementation done, walkthrough ready |
| `complete` | Approved, committed, and pushed |
| `rejected` | Rejected by user, archived |
| `cancelled` | Cancelled and reverted |

### Task Manager Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects/:id/tasks` | Get all tasks |
| `POST` | `/api/projects/:id/tasks` | Add new task |
| `PATCH` | `/api/projects/:id/tasks/:taskId` | Update task |
| `DELETE` | `/api/projects/:id/tasks/:taskId` | Delete task |
| `POST` | `.../research` | Trigger Deep Research |
| `POST` | `.../approve-research` | Approve research → generate plan |
| `POST` | `.../reject-research` | Reject research → revert to idea |
| `POST` | `.../approve-plan` | Approve plan |
| `POST` | `.../reject-plan` | Reject plan → revert to idea |
| `POST` | `.../implement` | Trigger AI implementation |
| `POST` | `.../approve-walkthrough` | Approve → commit & push |
| `POST` | `.../reject-walkthrough` | Reject → revert to planned |
| `POST` | `.../cancel-walkthrough` | Cancel, git revert, archive |

### Deep Research Agent

The research phase uses the **Gemini Deep Research Agent** with background polling:

```javascript
// Research runs asynchronously with polling up to 4 hours
async function runDeepResearch(prompt, apiKey, callbacks, existingInteractionId = null) {
    // Creates background interaction
    // Polls every 10 seconds
    // Persists interactionId to project.json for resume capability
}
```

**Resume on Restart:** If the server restarts while research is in progress, `resumeDeepResearch()` automatically resumes polling for any tasks with `status: 'researching'` and a saved `researchInteractionId`.

---

## Multi-Level Workflow System

The Nexus supports workflows at three hierarchical levels:

```
┌────────────────────────────────────────────────────────────────────┐
│                    DASHBOARD LEVEL                                  │
│  Cross-project initiatives (Security Sweeps, Dependency Audits)    │
│  ──────────────────────────────────────────────────────────────────│
│       ↓               ↓               ↓                            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                   │
│  │  Project A  │ │  Project B  │ │  Project C  │                   │
│  └─────────────┘ └─────────────┘ └─────────────┘                   │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│                    PROJECT LEVEL                                    │
│  Project-wide workflows (Brand Development, Documentation, Release)│
│  Uses workflow templates with predefined stages                     │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│                    FEATURE LEVEL                                    │
│  Individual feature development (Research → Plan → Implement)      │
│  Existing Feature Pipeline described above                          │
└────────────────────────────────────────────────────────────────────┘
```

### Dashboard Initiatives

Cross-project workflows that span multiple projects:

| Type | Description |
|------|-------------|
| `security-sweep` | Run security audits across all targeted projects |
| `dependency-audit` | Check for outdated and vulnerable dependencies |
| `readme-update` | Update README files across projects |
| `api-migration` | Migrate projects to new API versions |
| `health-check` | Monthly maintenance check across projects |

**Dashboard UI (`dashboard-initiatives.tsx`):**
- Collapsible initiatives section on the main Dashboard page
- Initiative cards with type icons, status badges, and progress bars
- Create modal with name, description, type selection, and project targeting
- Run and delete actions for each initiative

### Project Workflows

Project-level workflows with predefined templates:

| Template | Stages |
|----------|--------|
| **Brand Development** | Discovery → Concepts → Logo Design → Color Palette → Typography → Guidelines |
| **Logo Development** | Creative Brief → Concepts → Refinement → Finalization → Export |
| **Documentation** | README → API Docs → User Guide → Contributing |
| **Release** | Changelog → Version Bump → Build → Deploy → Announce |

**Context Passing:** Outputs from previous workflow stages (research reports, plans, walkthroughs) are automatically passed as context to subsequent stages, enabling coherent multi-stage workflows.

### Supervisor Agent

A supervisor agent (`agent_configs.id = 'supervisor'`) orchestrates multi-agent workflows:

- Routes tasks between agents: `researcher → plan-generator → implementation → evaluator`
- Uses `gemini-3-flash-preview` for fast routing decisions
- Configurable routing depth and available agents
- Supports feedback loops (evaluator can route back for re-work)

### Multi-Level Workflow Endpoints

**Dashboard Initiatives:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/initiatives` | List all initiatives |
| `POST` | `/api/initiatives` | Create new initiative |
| `GET` | `/api/initiatives/:id` | Get initiative with progress |
| `PATCH` | `/api/initiatives/:id` | Update initiative |
| `DELETE` | `/api/initiatives/:id` | Delete initiative |
| `POST` | `/api/initiatives/:id/run` | Execute initiative |

**Project Workflows:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects/:id/workflows` | List project workflows |
| `POST` | `/api/projects/:id/workflows` | Create workflow from template |
| `PATCH` | `/api/projects/:id/workflows/:wid` | Update workflow |
| `DELETE` | `/api/projects/:id/workflows/:wid` | Delete workflow |
| `POST` | `/api/projects/:id/workflows/:wid/run` | Run workflow |

**Workflow Templates:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/workflow-templates` | List all templates |
| `GET` | `/api/workflow-templates?level=project` | Filter by level |
| `POST` | `/api/workflow-templates` | Create custom template |

---

## Agent System

### Tool-Using Agent

The agent (`src/agent/index.js`) implements a multi-turn tool-using loop:

```javascript
async function runAgent({ 
    message, 
    history = [], 
    projectRoot, 
    model = 'gemini-2.0-flash-exp', 
    scopedProject = null  // Security: restrict access to single project
}) {
    // 1. Build context with visible projects
    // 2. Initialize messages based on provider
    // 3. Loop up to MAX_TURNS (10)
    //    - Call AI (Gemini or Claude)
    //    - If tool calls, execute tools
    //    - Feed results back to AI
    // 4. Return final response
}
```

### Available Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with offset/range support |
| `write_file` | Create or overwrite file |
| `list_directory` | List directory contents |
| `run_command` | Execute shell command |

### Code Critic Integration

Before file writes, the Critic Service reviews code for:
- **Logical Bugs** — Off-by-one errors, null checks, edge cases
- **Security Issues** — Injection vulnerabilities, exposed secrets
- **Style Issues** — Inconsistency with project conventions
- **Missing Pieces** — Incomplete implementations

The critic can be toggled on/off via the Agent Manager UI.

### Security Features

1. **Path Validation** — Tools validate paths stay within project boundaries
2. **Project Scoping** — When `scopedProject` is set, agent cannot access other projects
3. **Command Blocking** — Dangerous commands (`rm -rf /`, `format`, `mkfs`) are blocked
4. **Timeout** — Commands timeout after 30 seconds
5. **Sandbox Execution** — Scheduled tasks run in isolated environments

---

## Dashboard Components

### Main Components

| Component | Description |
|-----------|-------------|
| `project-card.tsx` | Project tile with git status, actions |
| `ai-terminal.tsx` | Multi-provider AI chat interface |
| `feature-pipeline.tsx` | Feature status Kanban board |
| `feature-detail-modal.tsx` | Full feature workflow UI |
| `feature-archive.tsx` | View completed/rejected features |
| `agent-manager.tsx` | Configure AI agents |
| `resource-monitor.tsx` | System monitor (CPU/memory/ports) |
| `scheduled-agents-list.tsx` | View/manage scheduled tasks |
| `activity-feed.tsx` | Recent commits across projects |
| `new-project-modal.tsx` | Scaffold new project dialog |

### API Client

All API calls are centralized in `dashboard/src/lib/nexus.ts`:

```typescript
export async function getProjects(): Promise<Project[]>
export async function getProjectStatus(id: string): Promise<GitStatus>
export async function getSystemStatus(): Promise<SystemStatus>
export async function getAgentConfig(): Promise<AgentConfigData>
export async function triggerFeatureResearch(projectId: string, featureId: string)
export async function approveResearch(projectId: string, featureId: string, feedback?: string)
// ... 40+ more functions with full TypeScript types
```

---

## Cloudflare Tunnel

### Configuration

The tunnel is configured in `cloudflared_config.yml`:

```yaml
tunnel: cfff4e97-6c4a-44cb-bc99-1b699b2f9fa3
credentials-file: C:\Projects\TheNexus\cfff4e97-6c4a-44cb-bc99-1b699b2f9fa3.json 

ingress:
  - hostname: nexus.vibeshiftai.com
    service: http://localhost:3000
  - service: http_status:404
```

> **Note:** The tunnel routes to port 3000 (dashboard), which proxies API calls to port 4000.

### Running the Tunnel

```bash
cloudflared tunnel --config cloudflared_config.yml run vibe-nexus
```

---

## Development

### Adding New API Endpoints

1. Add route handler in `src/server.js`
2. Add TypeScript client function in `dashboard/src/lib/nexus.ts`
3. Create/update component to use the new endpoint

### Adding New Agent Tools

1. Create tool definition in `src/tools/` with Zod schema
2. Export from `src/tools/index.js`
3. Tools are automatically available to agent and MCP server

### Adding New AI Models

1. Add model configuration to `agent-config.json` under `availableModels`
2. Add model option to `MODEL_OPTIONS` in `ai-terminal.tsx`
3. Handle any provider-specific parameters

### Adding New Scheduled Agent Types

1. Create tool in `src/scheduler/tools/`
2. Export from `src/scheduler/tools/index.js`
3. Add type to `AGENT_TYPES` in `src/scheduler/index.js`
4. Add default config to `DEFAULT_CONFIGS`

### Configuring Agents

Edit `agent-config.json` or use the Agent Manager UI to:
- Change system prompts
- Switch default models
- Adjust thinking budgets
- Configure routing rules

---

## Known Complexities

### 1. MCP stdout Issue

The MCP server requires pure JSON-RPC over stdio. Dotenv 17.x logs to stdout, breaking the protocol. Workaround:

```javascript
process.env.DOTENV_CONFIG_QUIET = 'true';  // At top of mcp.js
```

### 2. Deep Research Persistence

Research tasks can run for hours. The system:
- Saves `researchInteractionId` to `project.json`
- Resumes polling on server restart via `resumeDeepResearch()`
- Falls back to error state if polling fails repeatedly

### 3. Thinking Model Parameters

Different providers have different thinking parameter formats:

| Provider | Parameter | Format |
|----------|-----------|--------|
| Google Gemini 3 Pro | `thinking_config` | `{ thinking_level: 'HIGH' \| 'LOW' }` |
| Google Gemini 2.5 Flash | `thinking_budget` | Number (tokens) |
| Anthropic Claude | `thinking` | `{ type: 'enabled', budget_tokens: N }` |
| OpenAI | `reasoning_effort` | `'low' \| 'medium' \| 'high' \| 'xhigh'` |

### 4. Project Scoping

The AI terminal can be scoped to a specific project (using `projectId`), which:
- Restricts visible projects in agent context
- Blocks tool calls targeting other projects
- Adds explicit scope instruction to system prompt

### 5. API Key Fallback Chain

```javascript
// For Google:
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

// Chat endpoint fallback:
if (primaryProvider fails && GOOGLE_API_KEY exists) {
    // Falls back to Gemini agent
}
```

### 6. File Size Limits

- Diff output: Truncated to 5000 characters
- Key file reading: Truncated to 10000 characters
- Command output: Max buffer 1MB

### 7. Supervisor vs Autopilot

The `autopilot.js` service is deprecated. Use `supervisor.js` instead, which provides:
- Dynamic intent-based routing to specialized agents
- Task Ledger for state tracking (prevents re-execution)
- More resilient failure handling
- Better observability

### 8. Scheduler State Persistence

Scheduled tasks are stored in JSON files under `./data/scheduler/`:
- `tasks.json` — Task definitions
- `executions.json` — Execution logs
- `memories.json` — Agent memories

Consider migrating to PostgreSQL for production deployments.

---

## License

This project is proprietary. See the repo owner for licensing information.

---

## Links

- **Live Dashboard:** https://nexus.vibeshiftai.com
- **GitHub:** https://github.com/Guatapickl/TheNexus
