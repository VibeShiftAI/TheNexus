# Nexus Architecture Documentation

**Status:** Historical analysis; superseded by the 2026-07-02 orchestration decommission
**Date:** December 29, 2025

This directory contains the comprehensive architectural analysis of The Nexus platform.

## 1. System Overview
This directory preserves historical architecture analysis. The Python workflow service described here was retired on 2026-07-02; see `../decommission/langgraph-2026-07-02.md`.

| Level | Orchestrator | Engine | Status |
|-------|--------------|--------|--------|
| **Dashboard** | `dashboard-initiative-supervisor.js` | Retired Python workflow path | Historical |
| **Project** | `project-workflow-supervisor.js` | Retired Python workflow path | Historical |
| **Task** | `supervisor.js` | Node.js/Praxis task flow | Current |

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

## 6. Current Direction
Do not revive the retired Python workflow service from these notes. Current cleanup tracks through the decommission record.
