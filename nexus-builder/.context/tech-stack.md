---
context_type: tech-stack
status: active
updated_at: 2026-03-08T15:00:00.000Z
---

# Technology Stack

## 1. Frontend Architecture
- **Framework**: React (v18+) with Vite for fast build times.
- **Language**: TypeScript for type safety.
- **Styling**: Tailwind CSS for utility-first styling.
- **State Management**: React Query (TanStack Query) for server state, React Context for local state.
- **UI Components**: Radix UI (headless primitives) + Lucide React (icons).
- **Visualization**: React Flow for workflow diagrams, Mermaid.js for charts.

## 2. API Gateway (Node.js)
- **Runtime**: Node.js.
- **Framework**: Express.js.
- **Role**: Acts as the primary gateway for the frontend, handling authentication, request routing, and simple CRUD operations.
- **Communication**: Proxies complex AI tasks to the Python Engine.

## 3. Backend Technologies (Python Engine)
- **Runtime**: Python 3.11+.
- **Framework**: FastAPI for high-performance async API endpoints.
- **Orchestration**: LangGraph for stateful, multi-actor agent workflows.
- **AI/LLM**: LangChain for model abstraction and prompting.
- **Validation**: **Pydantic** is used extensively for data validation, serialization, and settings management, ensuring type safety across the application.
- **Networking**: **HTTPX** is utilized for making asynchronous HTTP requests to external APIs and internal services.

## 4. Database & Storage
- **Provider**: Supabase (PostgreSQL).
- **ORM/Query Builder**: Supabase JS Client (Frontend/Node), Supabase Python Client (Python).
- **Features Used**:
  - **Auth**: User management and RLS (Row Level Security).
  - **Realtime**: WebSocket subscriptions for workflow updates.
  - **Storage**: Blob storage for artifacts.

## 5. Infrastructure & DevOps
- **Hosting**: Vercel (Frontend), Railway/Render (Backend services).
- **Containerization**: **Docker** is used for containerizing services and providing isolated environments. It is critical for the Sandbox Service to ensure safe code execution.
- **CI/CD**: GitHub Actions.

## 6. Sandbox Service
- **Role**: A dedicated service for secure code execution.
- **Location**: `/sandbox` directory.
- **Functionality**: Executes generated code (Python/JS) in isolated Docker containers to prevent side effects on the host system.
- **Communication**: Accessed via internal API calls from the Python Engine during "Coding" or "Testing" workflow steps.