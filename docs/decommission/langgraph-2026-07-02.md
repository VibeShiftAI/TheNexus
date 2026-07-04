# LangGraph Orchestration Decommission Record

Date: 2026-07-02

Decision: Retire the Python workflow orchestration service formerly launched as `com.thenexus.langgraph`.

Reason: The service had two recorded pipeline runs, the last on 2026-03-20. A 13-hour outage produced no functional impact, and the audit found zero live consumers. Robert approved decommissioning on 2026-07-02.

Actions:
- LaunchAgent plist was renamed with a disabled suffix.
- Zombie task status rows from 2026-03-20 were cleared.
- Live server and dashboard consumers were removed in the post-decommission sweep.
- The former builder source was moved to `_retired/nexus-builder/` for git recovery.

Database note: `langgraph_*` task columns remain in SQLite as retained historical fields. They are not live orchestration state and can be dropped in a later migration.
