# Nexus Architecture Documentation

**Status:** Stable (Analysis Phase Complete)
**Date:** December 29, 2025

This directory contains the comprehensive architectural analysis of The Nexus platform.

## 1. System Overview
The Nexus operates on a three-tier workflow hierarchy, orchestrated by a hybrid Node.js/Python backend.

| Level | Orchestrator | Engine | Status |
|-------|--------------|--------|--------|
| **Dashboard** | `dashboard-initiative-supervisor.js` | Python LangGraph | ✅ Modern |
| **Project** | `project-workflow-supervisor.js` | Python LangGraph | ✅ Modern |
| **Task** | `supervisor.js` | **Legacy Node.js Loop** | ⚠️ **Disconnect** |

## 2. Workflow Maps
Visual diagrams of the orchestration logic at each level.
- [Dashboard Workflow Architecture](./dashboard-workflow-map.md)
- [Project Workflow Architecture](./project-workflow-map.md)
- [Task Pipeline Architecture](./task-pipeline-map.md)

## 3. Data & State
- [Database Schema Reference](./database-schema.md) - ERD and table definitions.

## 4. Critical Findings
- [Context & Disconnect Report](./context-and-disconnect-report.md) - Details the architectural isolation of the Task Pipeline and the state of Context Injection.

## 5. Deprecation Audits
Detailed lists of code scheduled for removal or refactoring.
- [Backend Deprecation Report](./deprecation-report-backend.md)
- [Frontend & Database Deprecation Report](./deprecation-report-frontend-db.md)

## 6. Next Steps (Unification)
The immediate goal is to refactor the **Task Pipeline** to use the **Python LangGraph Engine**, unifying the architecture and eliminating the legacy Node.js agent loop.
