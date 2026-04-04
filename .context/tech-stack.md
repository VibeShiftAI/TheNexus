---
context_type: tech-stack
status: active
updated_at: 2026-04-01T12:53:38.064Z
---

# Technology Stack: The Nexus

## 1. Programming Languages
*   **JavaScript (Node.js):** Core backend logic, project scanner, MCP server, and API services.
*   **TypeScript:** Frontend development (Next.js dashboard) and newer backend modules.
*   **Python:** LangGraph/Cortex engine for complex agent workflows, planning, and orchestration.

## 2. Frontend Frameworks & Libraries
*   **Next.js (App Router):** The React framework for the dashboard UI.
*   **React:** Component library for building interactive user interfaces.
*   **Tailwind CSS:** Utility-first CSS framework for styling and theming (Cyberpunk aesthetic).
*   **Framer Motion:** For animations and immersive UI effects.
*   **React Flow:** Visual workflow builder for drag-and-drop agent workflow design.
*   **Lucide React:** Icon library.

## 3. Backend Technologies
*   **Node.js & Express 5:** The primary REST API server for managing projects, system monitoring, and the dashboard backend.
*   **FastAPI:** Python-based API for the LangGraph engine.
*   **LangGraph & LangChain:** Orchestration framework for complex, stateful AI agent workflows with PostgreSQL-backed checkpointing.
*   **Socket.io:** Real-time WebSocket communication for streaming agent output and system events.
*   **Model Context Protocol (MCP):** Standard for connecting AI agents to local tools and data sources.

## 4. Database & Storage
*   **SQLite (nexus.db):** Local relational database for persistent state, agent configs, tasks, and workflow tracking.
*   **LangGraph Checkpoint (SQLite):** Dedicated checkpointing for graph state persistence and time-travel debugging.
*   **Local Filesystem:** Used for project discovery, workflow template storage (JSON), and git operations.

## 5. Infrastructure & DevOps
*   **Cloudflare Tunnel (Optional):** Exposes the local environment to the internet securely for remote access.
*   **Git (simple-git):** Version control integration for automated commits, branching, and project management.

## 6. AI & Machine Learning
*   **Google Gemini:** Primary model for research, supervision, and fast tasks (Flash/Pro).
*   **Anthropic Claude:** Primary model for planning and coding (Sonnet/Opus).
*   **OpenAI GPT:** Supported for specific reasoning tasks.
*   **xAI Grok:** Supported as an additional model provider.

## 7. Security & Middleware
*   **Helmet:** HTTP security headers for Express.
*   **express-rate-limit:** API rate limiting.
*   **CORS:** Cross-origin resource sharing configuration.