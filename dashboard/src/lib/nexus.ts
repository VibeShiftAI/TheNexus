// Barrel: lib/nexus.ts was split into lib/nexus/* (P2-25).
// Every name below is re-exported unchanged so no importer had to move.
// Do not declare anything here — add it to the owning module instead.

export { API_BUDGET, getSystemStatus } from "./nexus/system";
export type { PortInfo, SystemInfo, PraxisTelemetry, SystemStatus } from "./nexus/system";

export { getUsageStats, resetUsageStats, getUsageMonitorState } from "./nexus/usage";
export type { TokenUsageEntry, UsageStats, UsageWindow, UsageRateLimit, UsageFamilyState, RoutingDecision, UsageMonitorState } from "./nexus/usage";

export { getProjects, getArchivedProjects, getProjectsPulse, getProjectBrief, getProjectStatus, initGitRepo, addGitRemote, scaffoldProject, pingProject, getActivityEvents, getActivity, getProject, getProjectCommits, getPins, pinProject, unpinProject, approveResearch, rejectResearch, approveWalkthrough, rejectWalkthrough, cancelWalkthrough, commitAndPush, generateCommitMessage, updateProject, deleteProject, archiveProject, unarchiveProject, getProjectReadme, getProjectContext, updateProjectContext, syncContextFromGit, verifyContextSync } from "./nexus/projects";
export type { EndStateRevision, ProjectNeed, UpgradePosture, EndStateCriterion, Project, GitStatus, PulseGit, PulseTasks, PulseCrew, ProjectPulse, OpsLogEvent, ProjectBrief, PingResult, Activity, ActivityEvent, Commit, CommitsResponse, CancelResult, CommitPushResult, GeneratedMessage, DeleteResult } from "./nexus/projects";

export { STANDARD_STATUSES, getTasks, addTask, deleteTask, updateTask, getTaskById, updateTaskById, setTaskPriority, addResearchFeedback, addPlanFeedback, addWalkthroughFeedback, researchTasks, getResearchStatus, getDashboardStats, getBoardState, updateTaskDetails } from "./nexus/tasks";
export type { StandardTaskStatus, TaskStatus, Feedback, ResearchReport, ImplementationPlan, Walkthrough, Task, TasksResponse, TaskById, ResearchStatus, UpdateTaskData, ReviewItem, DashboardStats } from "./nexus/tasks";

export { validateInitiative, getDashboardInitiatives, getDashboardInitiative, createDashboardInitiative, updateDashboardInitiative, deleteDashboardInitiative, runDashboardInitiative } from "./nexus/initiatives";
export type { InitiativeValidation, InitiativeStatus, InitiativeType, DashboardInitiative, InitiativeProjectProgress, InitiativeSummary } from "./nexus/initiatives";

export { getLocalLlmQueue, enqueueLocalLlmJob, promoteLocalLlmJob, cancelLocalLlmJob, retryLocalLlmJob, pauseLocalLlmQueue, resumeLocalLlmQueue } from "./nexus/local-llm";
export type { LocalLlmJobStatus, LocalLlmJob, LocalLlmQueueState, EnqueueLocalLlmJobInput } from "./nexus/local-llm";

export { getSupervisorStatus } from "./nexus/supervisor";
export type { SupervisorPhase, SupervisorStatus } from "./nexus/supervisor";

export { getTaskTimeline, getInlineComments, addInlineComment, resolveInlineComment } from "./nexus/timeline";
export type { ExecutionStage, ExecutionStep, InlineComment } from "./nexus/timeline";

export { getEnvSettings, saveEnvSettings, getProjectKeys, rotateProjectKey } from "./nexus/settings";
export type { EnvSettings, ProjectKeyLocation, ProjectKeyGroup } from "./nexus/settings";

export { getProjectNotes, getGlobalNotes, createNote, updateNote, deleteNote, getTravelTabs, saveTravelTabs } from "./nexus/notes";
export type { Note, TravelTab } from "./nexus/notes";

export { listContacts, getContact, createContact, updateContact, deleteContact, getProjectContacts, linkContactToProject, updateContactLink, setProjectDecisionMaker, unlinkContactFromProject, getCommsFeed } from "./nexus/contacts";
export type { Contact, ProjectContact, CommsFeed, Member, ProjectMember } from "./nexus/contacts";

export { OPERATOR_DECIDER, getProjectRequests, decideStakeholderRequest, getProjectMeetings, createMeetingSeries, deleteMeetingSeries, deleteCalendarEvent, listStakeholderReports, generateStakeholderReport, sendStakeholderReport, stakeholderReportPreviewUrl } from "./nexus/stakeholders";
export type { StakeholderGate, StakeholderDecision, ProjectCommsSettings, ReportTemplate, StakeholderReport, ProjectRequest, MeetingRecurrence, MeetingEvent, CreateMeetingSeriesInput } from "./nexus/stakeholders";

export { getAutonomyState, getQaHolds } from "./nexus/dispatch-insight";
export type { CliQueueEntry, CliExecutorOccupancy, CliConcurrencyMetrics, CliConcurrencyThresholds, CliConcurrencyState, FleetPosture, AttemptStallState, AutonomyPauseFlag, AutonomyInFlightRun, AutonomyState, QaHold } from "./nexus/dispatch-insight";
