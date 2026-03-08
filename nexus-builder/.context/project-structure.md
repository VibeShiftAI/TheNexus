---
context_type: project_structure
status: active
updated_at: 2026-03-05
---

# Project Structure & Directory Map

This document provides a high-level map of the codebase, explaining the coexistence of legacy and modern components and guiding development efforts.

## Top-Level Directories

### `src/` (Modern Backend)
**Status**: Emerging / Target Architecture
Contains the modern implementation of backend logic utilizing **PydanticAI**. This directory represents the future direction of the project, focusing on type-safe AI interactions, structured data flows, and agentic patterns.
- **Key Technologies**: PydanticAI, Python 3.10+.
- **Purpose**: Hosting new AI agents and refactored logic from the legacy backend.

### `Backend/` (Legacy/Active Services)
**Status**: Active / Maintenance
Contains the service layer and business logic currently powering the Flask application. While labeled "Legacy," it is the operational core of the current deployment.
- **Contents**: `services/` (e.g., `AIService`, `GameStateService`), database interaction logic.
- **Interaction**: Called directly by `server/` routes.

### `server/` (Web Server)
**Status**: Active
Hosts the Flask application factory and HTTP route definitions. It acts as the API gateway, delegating business logic to `Backend/` services and AI logic to `ai/`.
- **Contents**: `app.py` (Entry point), `routes/`, `models/` (DTOs).

### `ai/` (Shared AI Utilities)
**Status**: Shared Component
A centralized module for OpenAI interactions, abstracting LLM mechanics (streaming, tool calling, model routing) from specific business logic. 
- **Usage**: Used primarily by `Backend/services/ai_service.py` but designed to be reusable.
- **Key Files**: `openai_client.py`, `tool_loop.py`, `streaming.py`.

### `my-frontend/` (Frontend)
**Status**: Active
The React-based user interface for the Game Master application.
- **Tech Stack**: React, JavaScript/TypeScript.

### `tools/` (Helpers & MCP)
**Status**: Utility
Contains helper scripts, database migration tools, and implementations of the Model Context Protocol (MCP).

## Understanding File Duplication

Due to the ongoing migration and separation of concerns, you may notice duplicate filenames or configuration files.

### Multiple `app.py` Files
- **`server/app.py`**: The main entry point for the production Flask API.
- **`src/app.py`** (if present): Entry point for the modern PydanticAI application or standalone agent testing.
- **`tools/**/app.py`**: Often simple scripts or standalone MCP servers used for development tools.

### Multiple `requirements.txt`
- **Root `requirements.txt`**: Dependencies for the active Flask environment (`server/` + `Backend/`).
- **`src/requirements.txt`** (or `pyproject.toml`): Dependencies specific to the modern stack (e.g., `pydantic-ai`), keeping the modern environment isolated from legacy constraints.

## Contribution Guide: Where to Add New Features?

| Feature Type | Target Directory | Notes |
| :--- | :--- | :--- |
| **New AI Agent / Logic** | `src/` | Use PydanticAI patterns. This is the preferred location for new capabilities. |
| **Existing Game Logic** | `Backend/services/` | Modify existing services (`GameStateService`, etc.) to maintain consistency with the current live app. |
| **API Endpoints** | `server/routes/` | Add new Flask routes here to expose functionality to the frontend. |
| **Frontend UI** | `my-frontend/` | React components and pages. |
| **LLM Infrastructure** | `ai/` | Updates to streaming, model routing, or core OpenAI client wrappers. |
