# lib/nexus.ts export map (P2-25)

Inventory of every export of the pre-split `src/lib/nexus.ts` (2,324 lines, 197 exports), the module it now lives in, and what it depends on.

`src/lib/nexus.ts` is now a barrel that re-exports these same 197 names, so no importer changed.

## Modules

| Module | Domain | Exports | Lines |
|---|---|---|---|
| `src/lib/nexus/contacts.ts` | Contacts directory | 16 | 123 |
| `src/lib/nexus/dispatch-insight.ts` | Dispatch insight: CLI lane, autonomy, QA holds | 13 | 182 |
| `src/lib/nexus/initiatives.ts` | Initiatives | 13 | 168 |
| `src/lib/nexus/local-llm.ts` | Local LLM queue | 11 | 109 |
| `src/lib/nexus/notes.ts` | Notes & travel tabs | 9 | 113 |
| `src/lib/nexus/projects.ts` | Projects, git scaffolding, activity | 53 | 670 |
| `src/lib/nexus/settings.ts` | Env settings & API-key rotation | 7 | 79 |
| `src/lib/nexus/shared.ts` | Shared fetch wrapper + API base URL (internal, not re-exported) | 0 | 25 |
| `src/lib/nexus/stakeholders.ts` | Stakeholder governance, reports, meetings | 20 | 199 |
| `src/lib/nexus/supervisor.ts` | Supervisor / workflow status | 3 | 40 |
| `src/lib/nexus/system.ts` | System status | 6 | 45 |
| `src/lib/nexus/tasks.ts` | Tasks, feedback, board | 29 | 365 |
| `src/lib/nexus/timeline.ts` | Execution timeline & inline comments | 7 | 113 |
| `src/lib/nexus/usage.ts` | Token usage & routing monitor | 10 | 152 |

`src/lib/nexus/shared.ts` holds the one copy of `authFetch` (auth header + `credentials: 'include'` + cache-buster) and `API_URL`; every other module imports them. There is no module-level mutable state anywhere in the original file (no caches, no in-flight maps) — only the four constant base-URL strings, each kept in the single module that uses it.

## Exports

| Export | Kind | Old line | Module | Uses (exports) | Uses (helpers) |
|---|---|---|---|---|---|
| `PortInfo` | type | 14 | `system` | — | — |
| `SystemInfo` | type | 15 | `system` | — | — |
| `PraxisTelemetry` | type | 16 | `system` | — | — |
| `SystemStatus` | type | 17 | `system` | — | — |
| `API_BUDGET` | const | 20 | `system` | — | — |
| `TokenUsageEntry` | interface | 26 | `usage` | — | — |
| `UsageStats` | interface | 38 | `usage` | `TokenUsageEntry` | — |
| `EndStateRevision` | interface | 74 | `projects` | — | — |
| `ProjectNeed` | interface | 82 | `projects` | — | — |
| `UpgradePosture` | type | 93 | `projects` | `Project` | — |
| `EndStateCriterion` | interface | 100 | `projects` | — | — |
| `Project` | interface | 113 | `projects` | `EndStateCriterion`, `EndStateRevision`, `ProjectCommsSettings`, `ProjectNeed`, `ReportTemplate`, `UpgradePosture` | — |
| `Note` | interface | 152 | `notes` | — | — |
| `GitStatus` | interface | 164 | `projects` | — | `authFetch`, `API_URL`, `getAuthHeader` |
| `getProjects` | function | 217 | `projects` | `Project` | `authFetch`, `API_URL` |
| `getArchivedProjects` | function | 235 | `projects` | `Project` | `authFetch`, `API_URL` |
| `PulseGit` | interface | 245 | `projects` | — | — |
| `PulseTasks` | interface | 260 | `projects` | — | — |
| `PulseCrew` | interface | 270 | `projects` | — | — |
| `ProjectPulse` | interface | 285 | `projects` | `PulseCrew`, `PulseGit`, `PulseTasks` | — |
| `OpsLogEvent` | interface | 293 | `projects` | — | — |
| `ProjectBrief` | interface | 303 | `projects` | `OpsLogEvent`, `ProjectPulse` | — |
| `getProjectsPulse` | function | 307 | `projects` | `ProjectPulse` | `authFetch`, `API_URL` |
| `getProjectBrief` | function | 314 | `projects` | `ProjectBrief` | `authFetch`, `API_URL` |
| `getProjectStatus` | function | 320 | `projects` | `GitStatus` | `authFetch`, `API_URL` |
| `initGitRepo` | function | 328 | `projects` | — | `authFetch`, `API_URL` |
| `addGitRemote` | function | 339 | `projects` | — | `authFetch`, `API_URL` |
| `scaffoldProject` | function | 352 | `projects` | — | `authFetch`, `API_URL` |
| `PingResult` | interface | 365 | `projects` | — | — |
| `pingProject` | function | 373 | `projects` | `PingResult` | `authFetch`, `API_URL` |
| `Activity` | interface | 381 | `projects` | `Task` | — |
| `ActivityEvent` | interface | 415 | `projects` | — | — |
| `getActivityEvents` | function | 428 | `projects` | `ActivityEvent` | `authFetch`, `API_URL` |
| `getActivity` | function | 437 | `projects` | `Activity` | `authFetch`, `API_URL` |
| `getProject` | function | 446 | `projects` | `Project` | `authFetch`, `API_URL` |
| `Commit` | interface | 454 | `projects` | — | — |
| `CommitsResponse` | interface | 462 | `projects` | `Commit` | — |
| `getProjectCommits` | function | 467 | `projects` | `CommitsResponse` | `authFetch`, `API_URL` |
| `getPins` | function | 475 | `projects` | — | `authFetch`, `API_URL` |
| `pinProject` | function | 484 | `projects` | — | `authFetch`, `API_URL` |
| `unpinProject` | function | 489 | `projects` | — | `authFetch`, `API_URL` |
| `approveResearch` | function | 494 | `projects` | `Task` | `authFetch`, `API_URL` |
| `rejectResearch` | function | 514 | `projects` | `Note`, `Task` | `authFetch`, `API_URL` |
| `approveWalkthrough` | function | 527 | `projects` | `Commit`, `Task`, `TaskStatus`, `commitAndPush`, `generateCommitMessage`, `updateTask` | — |
| `rejectWalkthrough` | function | 561 | `projects` | `Task` | `authFetch`, `API_URL` |
| `CancelResult` | interface | 573 | `projects` | `Task` | — |
| `cancelWalkthrough` | function | 580 | `projects` | `CancelResult` | `authFetch`, `API_URL` |
| `CommitPushResult` | interface | 593 | `projects` | — | — |
| `commitAndPush` | function | 601 | `projects` | `CommitPushResult` | `authFetch`, `API_URL` |
| `GeneratedMessage` | interface | 614 | `projects` | — | — |
| `generateCommitMessage` | function | 620 | `projects` | `GeneratedMessage` | `authFetch`, `API_URL`, `TaskBoardStatusSchema` |
| `STANDARD_STATUSES` | const | 638 | `tasks` | — | `TaskBoardStatusSchema` |
| `StandardTaskStatus` | type | 639 | `tasks` | `TaskStatus` | — |
| `TaskStatus` | type | 642 | `tasks` | `StandardTaskStatus` | — |
| `Feedback` | interface | 644 | `tasks` | — | — |
| `ResearchReport` | interface | 651 | `tasks` | `Feedback` | — |
| `ImplementationPlan` | interface | 660 | `tasks` | `Feedback` | — |
| `Walkthrough` | interface | 668 | `tasks` | `Feedback` | — |
| `Task` | interface | 677 | `tasks` | `ImplementationPlan`, `InitiativeValidation`, `ResearchReport`, `TaskStatus`, `Walkthrough` | — |
| `TasksResponse` | interface | 706 | `tasks` | `Task` | — |
| `InitiativeValidation` | interface | 710 | `initiatives` | — | — |
| `validateInitiative` | function | 717 | `initiatives` | `InitiativeValidation` | `authFetch`, `API_URL` |
| `getTasks` | function | 731 | `tasks` | `TasksResponse` | `authFetch`, `API_URL` |
| `addTask` | function | 739 | `tasks` | `Task` | `authFetch`, `API_URL` |
| `deleteTask` | function | 769 | `tasks` | — | `authFetch`, `API_URL` |
| `updateProject` | function | 782 | `projects` | `Project` | `authFetch`, `API_URL` |
| `DeleteResult` | interface | 803 | `projects` | `Project` | — |
| `deleteProject` | function | 816 | `projects` | `DeleteResult` | `authFetch`, `API_URL` |
| `archiveProject` | function | 832 | `projects` | `Project` | `authFetch`, `API_URL` |
| `unarchiveProject` | function | 842 | `projects` | `Project` | `authFetch`, `API_URL` |
| `getProjectReadme` | function | 854 | `projects` | — | `authFetch`, `API_URL` |
| `getProjectContext` | function | 867 | `projects` | — | `authFetch`, `API_URL` |
| `updateProjectContext` | function | 878 | `projects` | — | `authFetch`, `API_URL` |
| `syncContextFromGit` | function | 893 | `projects` | — | `authFetch`, `API_URL` |
| `verifyContextSync` | function | 906 | `projects` | — | `authFetch`, `API_URL` |
| `updateTask` | function | 914 | `tasks` | `Task`, `TaskStatus` | `authFetch`, `API_URL` |
| `TaskById` | interface | 941 | `tasks` | `Task` | — |
| `getTaskById` | function | 964 | `tasks` | `TaskById` | `authFetch`, `API_URL` |
| `updateTaskById` | function | 976 | `tasks` | `Task` | `authFetch`, `API_URL` |
| `setTaskPriority` | function | 997 | `tasks` | `Task` | `authFetch`, `API_URL` |
| `addResearchFeedback` | function | 1010 | `tasks` | `Task` | `authFetch`, `API_URL` |
| `addPlanFeedback` | function | 1022 | `tasks` | `Task` | `authFetch`, `API_URL` |
| `addWalkthroughFeedback` | function | 1034 | `tasks` | `Task` | `authFetch`, `API_URL` |
| `ResearchStatus` | interface | 1050 | `tasks` | — | — |
| `researchTasks` | function | 1056 | `tasks` | — | `authFetch`, `API_URL` |
| `getResearchStatus` | function | 1068 | `tasks` | `ResearchStatus` | `authFetch`, `API_URL` |
| `UpdateTaskData` | interface | 1081 | `tasks` | `TaskStatus` | — |
| `ReviewItem` | interface | 1088 | `tasks` | `Project`, `Task` | — |
| `DashboardStats` | interface | 1096 | `tasks` | `ReviewItem` | — |
| `getDashboardStats` | function | 1106 | `tasks` | `DashboardStats` | `authFetch`, `API_URL` |
| `getBoardState` | function | 1114 | `tasks` | — | `authFetch`, `API_URL` |
| `updateTaskDetails` | function | 1127 | `tasks` | `Task`, `UpdateTaskData` | `authFetch`, `API_URL` |
| `getSystemStatus` | function | 1149 | `system` | `SystemStatus` | `authFetch`, `API_URL` |
| `getUsageStats` | function | 1162 | `usage` | `UsageStats` | `authFetch`, `API_URL` |
| `resetUsageStats` | function | 1188 | `usage` | — | `authFetch`, `API_URL` |
| `LocalLlmJobStatus` | type | 1206 | `local-llm` | — | — |
| `LocalLlmJob` | interface | 1208 | `local-llm` | `LocalLlmJobStatus` | — |
| `LocalLlmQueueState` | interface | 1226 | `local-llm` | `LocalLlmJob` | — |
| `EnqueueLocalLlmJobInput` | interface | 1237 | `local-llm` | — | `API_URL`, `LOCAL_QUEUE_API` |
| `getLocalLlmQueue` | function | 1247 | `local-llm` | `LocalLlmQueueState` | `authFetch`, `LOCAL_QUEUE_API` |
| `enqueueLocalLlmJob` | function | 1255 | `local-llm` | `EnqueueLocalLlmJobInput`, `LocalLlmJob` | `authFetch`, `LOCAL_QUEUE_API` |
| `promoteLocalLlmJob` | function | 1265 | `local-llm` | `LocalLlmJob` | `authFetch`, `LOCAL_QUEUE_API` |
| `cancelLocalLlmJob` | function | 1275 | `local-llm` | `LocalLlmJob` | `authFetch`, `LOCAL_QUEUE_API` |
| `retryLocalLlmJob` | function | 1285 | `local-llm` | `LocalLlmJob` | `authFetch`, `LOCAL_QUEUE_API` |
| `pauseLocalLlmQueue` | function | 1291 | `local-llm` | `LocalLlmQueueState` | `authFetch`, `LOCAL_QUEUE_API` |
| `resumeLocalLlmQueue` | function | 1301 | `local-llm` | `LocalLlmQueueState` | `authFetch`, `LOCAL_QUEUE_API` |
| `SupervisorPhase` | type | 1312 | `supervisor` | — | — |
| `SupervisorStatus` | interface | 1314 | `supervisor` | `SupervisorPhase`, `TaskStatus` | — |
| `getSupervisorStatus` | function | 1332 | `supervisor` | `SupervisorStatus` | `authFetch`, `API_URL` |
| `ExecutionStage` | type | 1348 | `timeline` | — | — |
| `ExecutionStep` | interface | 1350 | `timeline` | `ExecutionStage` | — |
| `InlineComment` | interface | 1366 | `timeline` | — | — |
| `getTaskTimeline` | function | 1382 | `timeline` | `ExecutionStage`, `ExecutionStep` | `authFetch`, `API_URL` |
| `getInlineComments` | function | 1397 | `timeline` | `InlineComment` | `authFetch`, `API_URL` |
| `addInlineComment` | function | 1412 | `timeline` | `InlineComment` | `authFetch`, `API_URL` |
| `resolveInlineComment` | function | 1437 | `timeline` | `InlineComment` | `API_URL` |
| `InitiativeStatus` | type | 1459 | `initiatives` | — | — |
| `InitiativeType` | type | 1460 | `initiatives` | — | — |
| `DashboardInitiative` | interface | 1462 | `initiatives` | `InitiativeStatus`, `InitiativeType` | — |
| `InitiativeProjectProgress` | interface | 1477 | `initiatives` | — | — |
| `InitiativeSummary` | interface | 1491 | `initiatives` | — | `INITIATIVES_API` |
| `getDashboardInitiatives` | function | 1508 | `initiatives` | `DashboardInitiative`, `InitiativeStatus` | `authFetch`, `INITIATIVES_API` |
| `getDashboardInitiative` | function | 1520 | `initiatives` | `DashboardInitiative`, `InitiativeProjectProgress`, `InitiativeSummary` | `authFetch`, `INITIATIVES_API` |
| `createDashboardInitiative` | function | 1535 | `initiatives` | `DashboardInitiative`, `InitiativeType` | `authFetch`, `INITIATIVES_API` |
| `updateDashboardInitiative` | function | 1557 | `initiatives` | `DashboardInitiative` | `authFetch`, `INITIATIVES_API` |
| `deleteDashboardInitiative` | function | 1575 | `initiatives` | — | `authFetch`, `INITIATIVES_API` |
| `runDashboardInitiative` | function | 1588 | `initiatives` | `DashboardInitiative` | `authFetch`, `INITIATIVES_API` |
| `EnvSettings` | interface | 1602 | `settings` | — | — |
| `getEnvSettings` | function | 1611 | `settings` | `EnvSettings` | `authFetch`, `API_URL` |
| `saveEnvSettings` | function | 1618 | `settings` | `EnvSettings` | `authFetch`, `API_URL` |
| `ProjectKeyLocation` | interface | 1634 | `settings` | — | — |
| `ProjectKeyGroup` | interface | 1642 | `settings` | `ProjectKeyLocation` | — |
| `UsageWindow` | interface | 1649 | `usage` | — | — |
| `UsageRateLimit` | interface | 1659 | `usage` | — | — |
| `UsageFamilyState` | interface | 1667 | `usage` | `UsageRateLimit`, `UsageWindow` | — |
| `RoutingDecision` | interface | 1682 | `usage` | — | — |
| `UsageMonitorState` | interface | 1696 | `usage` | `RoutingDecision`, `UsageFamilyState` | — |
| `getUsageMonitorState` | function | 1702 | `usage` | `UsageMonitorState` | `authFetch`, `API_URL` |
| `getProjectKeys` | function | 1709 | `settings` | `ProjectKeyGroup` | `authFetch`, `API_URL` |
| `rotateProjectKey` | function | 1716 | `settings` | — | `authFetch`, `API_URL` |
| `getProjectNotes` | function | 1738 | `notes` | `Note` | `authFetch`, `API_URL` |
| `getGlobalNotes` | function | 1746 | `notes` | `Note` | `authFetch`, `API_URL` |
| `createNote` | function | 1754 | `notes` | `Note` | `authFetch`, `API_URL` |
| `updateNote` | function | 1773 | `notes` | `Note` | `authFetch`, `API_URL` |
| `deleteNote` | function | 1788 | `notes` | — | `authFetch`, `API_URL` |
| `TravelTab` | interface | 1800 | `notes` | — | — |
| `getTravelTabs` | function | 1809 | `notes` | `TravelTab` | `authFetch`, `API_URL` |
| `saveTravelTabs` | function | 1817 | `notes` | `CommsFeed`, `Contact`, `ProjectContact`, `TravelTab` | `authFetch`, `API_URL` |
| `Contact` | type | 1841 | `contacts` | — | — |
| `ProjectContact` | type | 1842 | `contacts` | — | — |
| `CommsFeed` | type | 1843 | `contacts` | `Contact`, `Member` | — |
| `Member` | type | 1845 | `contacts` | `Contact` | — |
| `ProjectMember` | type | 1846 | `contacts` | `ProjectContact` | `CONTACTS_URL` |
| `listContacts` | function | 1850 | `contacts` | `Contact` | `authFetch`, `CONTACTS_URL` |
| `getContact` | function | 1857 | `contacts` | `Contact` | `authFetch`, `CONTACTS_URL` |
| `createContact` | function | 1863 | `contacts` | `Contact` | `authFetch`, `CONTACTS_URL` |
| `updateContact` | function | 1874 | `contacts` | `Contact` | `authFetch`, `CONTACTS_URL` |
| `deleteContact` | function | 1885 | `contacts` | — | `authFetch`, `CONTACTS_URL` |
| `getProjectContacts` | function | 1890 | `contacts` | `ProjectContact` | `authFetch`, `CONTACTS_URL` |
| `linkContactToProject` | function | 1896 | `contacts` | — | `authFetch`, `CONTACTS_URL` |
| `updateContactLink` | function | 1910 | `contacts` | — | `authFetch`, `CONTACTS_URL` |
| `setProjectDecisionMaker` | function | 1926 | `contacts` | — | `authFetch`, `CONTACTS_URL` |
| `unlinkContactFromProject` | function | 1938 | `contacts` | — | `authFetch`, `CONTACTS_URL` |
| `getCommsFeed` | function | 1944 | `contacts` | `CommsFeed`, `Project`, `ProjectCommsSettings`, `ReportTemplate`, `StakeholderDecision`, `StakeholderGate`, `StakeholderReport` | `authFetch`, `calendarEventsUrl` |
| `StakeholderGate` | type | 1967 | `stakeholders` | — | — |
| `StakeholderDecision` | type | 1968 | `stakeholders` | — | — |
| `ProjectCommsSettings` | type | 1969 | `stakeholders` | — | — |
| `ReportTemplate` | type | 1970 | `stakeholders` | — | — |
| `StakeholderReport` | type | 1971 | `stakeholders` | — | — |
| `OPERATOR_DECIDER` | const | 1974 | `stakeholders` | `StakeholderDecision` | — |
| `ProjectRequest` | interface | 1980 | `stakeholders` | `StakeholderGate` | — |
| `getProjectRequests` | function | 1993 | `stakeholders` | `ProjectRequest` | `authFetch`, `API_URL` |
| `decideStakeholderRequest` | function | 2001 | `stakeholders` | `StakeholderDecision`, `StakeholderGate`, `Task` | `authFetch` |
| `MeetingRecurrence` | type | 2017 | `stakeholders` | — | — |
| `MeetingEvent` | interface | 2020 | `stakeholders` | `MeetingRecurrence`, `Member` | — |
| `CreateMeetingSeriesInput` | interface | 2027 | `stakeholders` | `MeetingEvent`, `MeetingRecurrence` | `normalizeMeeting` |
| `getProjectMeetings` | function | 2053 | `stakeholders` | `MeetingEvent` | `authFetch`, `normalizeMeeting`, `calendarEventsUrl` |
| `createMeetingSeries` | function | 2069 | `stakeholders` | `CreateMeetingSeriesInput`, `MeetingEvent` | `authFetch`, `normalizeMeeting` |
| `deleteMeetingSeries` | function | 2084 | `stakeholders` | — | `authFetch` |
| `deleteCalendarEvent` | function | 2094 | `stakeholders` | `Project` | `authFetch`, `STAKEHOLDER_REPORTS_URL` |
| `listStakeholderReports` | function | 2107 | `stakeholders` | `StakeholderReport` | `authFetch`, `STAKEHOLDER_REPORTS_URL` |
| `generateStakeholderReport` | function | 2120 | `stakeholders` | `StakeholderReport` | `authFetch`, `STAKEHOLDER_REPORTS_URL` |
| `sendStakeholderReport` | function | 2133 | `stakeholders` | — | `authFetch`, `STAKEHOLDER_REPORTS_URL` |
| `stakeholderReportPreviewUrl` | function | 2140 | `stakeholders` | — | — |
| `CliQueueEntry` | interface | 2171 | `dispatch-insight` | — | — |
| `CliExecutorOccupancy` | interface | 2181 | `dispatch-insight` | — | — |
| `CliConcurrencyMetrics` | interface | 2192 | `dispatch-insight` | — | — |
| `CliConcurrencyThresholds` | interface | 2201 | `dispatch-insight` | — | — |
| `CliConcurrencyState` | interface | 2215 | `dispatch-insight` | `CliConcurrencyMetrics`, `CliConcurrencyThresholds`, `CliExecutorOccupancy` | — |
| `FleetPosture` | interface | 2236 | `dispatch-insight` | — | — |
| `AttemptStallState` | interface | 2246 | `dispatch-insight` | — | — |
| `AutonomyPauseFlag` | interface | 2254 | `dispatch-insight` | — | — |
| `AutonomyInFlightRun` | interface | 2263 | `dispatch-insight` | — | — |
| `AutonomyState` | interface | 2278 | `dispatch-insight` | `AutonomyInFlightRun`, `AutonomyPauseFlag` | — |
| `QaHold` | interface | 2294 | `dispatch-insight` | — | — |
| `getAutonomyState` | function | 2312 | `dispatch-insight` | `AutonomyState` | `authFetch` |
| `getQaHolds` | function | 2319 | `dispatch-insight` | `QaHold` | `authFetch` |
