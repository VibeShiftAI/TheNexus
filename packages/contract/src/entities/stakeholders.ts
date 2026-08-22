/**
 * Stakeholder governance — Primary Decision Makers, the request approval
 * queue, per-project communication settings, branded Project Status Report
 * templates, and the report ↔ response wire formats (2026-08-22, Robert's
 * directive).
 *
 * Who is a stakeholder: any Member linked to a project (`project_contacts`).
 * A link flagged `decision_maker` makes that member a **Primary Decision
 * Maker (PDM)** — consulted on updates, status, and decisions. Feedback-widget
 * submitters still auto-join a project as members, but when the project has
 * PDMs their requests are filed as `blocked` tasks carrying a
 * `StakeholderGate` until a PDM (or the operator) decides.
 *
 * Reports: Praxis composes a `StakeholderReport` (client-safe — titles and
 * plain-language summaries only, never raw payloads), renders it with the
 * project's `ReportTemplate`, publishes an interactive copy on the relay, and
 * emails the recipients. PDMs answer per line item and for the report as a
 * whole (`ReportResponse`); those answers become gate decisions + feedback.
 *
 * Stored: gate on `tasks.metadata.stakeholder_gate`; settings/template as JSON
 * columns `projects.comms_settings` / `projects.report_template`; reports and
 * responses in Praxis's `data/stakeholder-reports.db`; hosted report specs in
 * the relay's R2 under `reports/<token>/`.
 */

import { z } from "zod";

// ── Approval gate on a task ─────────────────────────────────────────────────

export const StakeholderGateStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "duplicate",
  "deferred",
]);
export type StakeholderGateStatus = z.infer<typeof StakeholderGateStatusSchema>;

/** Who asked / who decided — members when known, else a name/email. */
export const StakeholderPartySchema = z.object({
  member_id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  /** How the decision arrived: project page, hosted report, email reply, API/tool. */
  via: z.enum(["operator", "report", "email", "api"]).optional(),
});
export type StakeholderParty = z.infer<typeof StakeholderPartySchema>;

export const StakeholderGateSchema = z.object({
  status: StakeholderGateStatusSchema,
  requested_by: StakeholderPartySchema.optional(),
  requested_at: z.string(),
  /** Feedback trace tag (PX-<CODE>-<n>) of the originating submission. */
  feedback_tag: z.string().optional(),
  submission_id: z.string().optional(),
  decided_by: StakeholderPartySchema.optional(),
  decided_at: z.string().optional(),
  note: z.string().optional(),
  /** For `duplicate`: the task this request duplicates. */
  duplicate_of: z.string().optional(),
  /** The status report that last presented this request (if any). */
  report_id: z.string().optional(),
  /** Decision history, oldest first (bounded by the server). */
  history: z
    .array(
      z.object({
        at: z.string(),
        status: StakeholderGateStatusSchema,
        by: StakeholderPartySchema.optional(),
        note: z.string().optional(),
      }),
    )
    .optional(),
});
export type StakeholderGate = z.infer<typeof StakeholderGateSchema>;

/** Metadata key the gate lives under on a task. */
export const STAKEHOLDER_GATE_KEY = "stakeholder_gate";

/** Wire format of POST /api/tasks/:id/stakeholder-decision. */
export const StakeholderDecisionSchema = z.object({
  decision: z.enum(["approve", "reject", "duplicate", "defer"]),
  note: z.string().max(4000).optional(),
  duplicate_of: z.string().optional(),
  decided_by: StakeholderPartySchema.optional(),
});
export type StakeholderDecision = z.infer<typeof StakeholderDecisionSchema>;

/** Board status a task takes after each decision (server-applied). */
export const STAKEHOLDER_DECISION_STATUS: Record<StakeholderDecision["decision"], string> = {
  approve: "idea",
  reject: "cancelled",
  duplicate: "cancelled",
  defer: "blocked",
};

// ── Per-project communication settings ──────────────────────────────────────

export const ReportSendModeSchema = z.enum(["review", "auto"]);
export type ReportSendMode = z.infer<typeof ReportSendModeSchema>;

export const WeeklyReportScheduleSchema = z.object({
  enabled: z.boolean().default(true),
  /** 0 = Sunday … 6 = Saturday (in `timezone`). */
  weekday: z.number().int().min(0).max(6).default(1),
  /** Local hour 0–23 at which the weekly report becomes due. */
  hour: z.number().int().min(0).max(23).default(9),
});
export type WeeklyReportSchedule = z.infer<typeof WeeklyReportScheduleSchema>;

export const ReportRecipientsSchema = z.object({
  /** Every PDM of the project receives the report (default). */
  decision_makers: z.boolean().default(true),
  /** Additional member ids (non-PDM members who should be kept informed). */
  member_ids: z.array(z.string()).default([]),
  /** Ad-hoc addresses not in the directory. */
  emails: z.array(z.string()).default([]),
});
export type ReportRecipients = z.infer<typeof ReportRecipientsSchema>;

export const ProjectCommsSettingsSchema = z.object({
  /**
   * Master toggle. Absent ⇒ effective-active iff the project has ≥1 PDM —
   * so naming a decision maker is enough to turn reporting on, and the
   * project page can switch it off explicitly.
   */
  active: z.boolean().optional(),
  /** review = HITL card to Robert before every send; auto = send on generate. */
  send_mode: ReportSendModeSchema.default("review"),
  /** Quiet period after the last incoming request before an activity report fires. */
  quiet_minutes: z.number().int().min(5).max(24 * 60).default(60),
  /** Whether incoming requests trigger activity reports at all. */
  event_trigger: z.boolean().default(true),
  weekly: WeeklyReportScheduleSchema.default({}),
  recipients: ReportRecipientsSchema.default({}),
  /** Copy Robert (the operator mailbox) on every report. */
  cc_operator: z.boolean().default(true),
  timezone: z.string().default("America/New_York"),
  /** Stamped by Praxis after each send. */
  last_report_at: z.string().optional(),
  last_trigger: z.enum(["activity", "weekly", "manual"]).optional(),
  last_report_id: z.string().optional(),
});
export type ProjectCommsSettings = z.infer<typeof ProjectCommsSettingsSchema>;

/** Parse a stored settings blob (missing/partial → defaults). Never throws. */
export function parseCommsSettings(raw: unknown): ProjectCommsSettings {
  const parsed = ProjectCommsSettingsSchema.safeParse(raw && typeof raw === "object" ? raw : {});
  return parsed.success ? parsed.data : ProjectCommsSettingsSchema.parse({});
}

/** Effective master switch: explicit flag wins, else "has any PDM". */
export function commsEffectivelyActive(settings: ProjectCommsSettings, pdmCount: number): boolean {
  if (typeof settings.active === "boolean") return settings.active;
  return pdmCount > 0;
}

// ── Branded report template ────────────────────────────────────────────────

export const ReportBrandSchema = z.object({
  /** Display name on the report ("Meeple Magnate"). */
  name: z.string(),
  /** CSS hex accent ("#6d5efc"). */
  accent: z.string().default("#6d5efc"),
  logo_url: z.string().optional(),
  tagline: z.string().optional(),
  /** Voice hints for the composer: "friendly, plain language", "kid-friendly", "formal". */
  tone: z.string().default("friendly, plain language, no jargon"),
  /** Sender display name on the email. */
  from_name: z.string().optional(),
});
export type ReportBrand = z.infer<typeof ReportBrandSchema>;

export const ReportSectionsSchema = z.object({
  requests: z.boolean().default(true),
  completed: z.boolean().default(true),
  in_progress: z.boolean().default(true),
  next: z.boolean().default(true),
  questions: z.boolean().default(true),
  feedback: z.boolean().default(true),
});
export type ReportSections = z.infer<typeof ReportSectionsSchema>;

export const ReportTemplateChangeSchema = z.object({
  at: z.string(),
  /** "auto" | "operator" | "pdm:<member_id>" | free text. */
  by: z.string(),
  note: z.string(),
});

export const ReportTemplateSchema = z.object({
  version: z.number().int().min(1).default(1),
  created_at: z.string(),
  updated_at: z.string(),
  source: z.enum(["auto", "operator", "pdm"]).default("auto"),
  brand: ReportBrandSchema,
  sections: ReportSectionsSchema.default({}),
  intro: z.string().optional(),
  footer: z.string().optional(),
  change_log: z.array(ReportTemplateChangeSchema).default([]),
});
export type ReportTemplate = z.infer<typeof ReportTemplateSchema>;

/** True when a stored template blob is a usable template (has a brand). */
export function hasReportTemplate(raw: unknown): raw is ReportTemplate {
  return ReportTemplateSchema.safeParse(raw).success;
}

// ── The report itself ──────────────────────────────────────────────────────

export const ReportTriggerSchema = z.enum(["activity", "weekly", "manual"]);
export type ReportTrigger = z.infer<typeof ReportTriggerSchema>;

export const ReportItemKindSchema = z.enum([
  "request",
  "completed",
  "in_progress",
  "next",
  "question",
]);
export type ReportItemKind = z.infer<typeof ReportItemKindSchema>;

/** Decision vocabulary PDMs pick from on a request line item. */
export const ReportItemDecisionSchema = z.enum(["approve", "changes", "not_now", "duplicate"]);
export type ReportItemDecision = z.infer<typeof ReportItemDecisionSchema>;

export const ReportItemSchema = z.object({
  /** Stable within the report: "r1", "c2", … (referenced by responses). */
  id: z.string(),
  kind: ReportItemKindSchema,
  title: z.string(),
  /** Plain-language, client-safe summary. */
  summary: z.string().optional(),
  task_id: z.string().optional(),
  feedback_tag: z.string().optional(),
  requested_by: z.string().optional(),
  requested_at: z.string().optional(),
  /** Duplicate detection: another item in this report / an existing task. */
  duplicate_of_item: z.string().optional(),
  duplicate_of_task: z.string().optional(),
  duplicate_note: z.string().optional(),
  /** For request items: which decisions the form offers. */
  decision_options: z.array(ReportItemDecisionSchema).optional(),
  /** Prior PDM decision carried forward (so the form shows the state). */
  current_decision: StakeholderGateStatusSchema.optional(),
});
export type ReportItem = z.infer<typeof ReportItemSchema>;

export const ReportQuestionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  /** The item this question is about, when specific. */
  item_id: z.string().optional(),
});
export type ReportQuestion = z.infer<typeof ReportQuestionSchema>;

export const ReportRecipientSchema = z.object({
  member_id: z.string().optional(),
  name: z.string().optional(),
  email: z.string(),
  /** Why they got it. */
  role: z.enum(["decision_maker", "member", "extra", "operator"]).optional(),
});
export type ReportRecipient = z.infer<typeof ReportRecipientSchema>;

export const ReportStatusSchema = z.enum(["draft", "review", "sent", "cancelled", "failed"]);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

export const StakeholderReportSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  project_name: z.string(),
  /** Trace tag (PX-<CODE>-<n>) — email replies route back by it. */
  tag: z.string(),
  trigger: ReportTriggerSchema,
  period: z.object({ from: z.string(), to: z.string() }),
  generated_at: z.string(),
  /** 1–3 sentence headline the email opens with. */
  summary: z.string(),
  items: z.array(ReportItemSchema),
  questions: z.array(ReportQuestionSchema).default([]),
  recipients: z.array(ReportRecipientSchema).default([]),
  template_version: z.number().int().optional(),
  hosted_url: z.string().optional(),
  hosted_token: z.string().optional(),
  html_file: z.string().optional(),
  status: ReportStatusSchema.default("draft"),
  sent_at: z.string().optional(),
  hitl_id: z.string().optional(),
  /** Overall feedback received so far, newest last. */
  feedback: z
    .array(
      z.object({
        at: z.string(),
        from: StakeholderPartySchema.optional(),
        text: z.string().optional(),
        rating: z.number().optional(),
        template_feedback: z.string().optional(),
        via: z.enum(["report", "email", "operator"]).optional(),
      }),
    )
    .default([]),
});
export type StakeholderReport = z.infer<typeof StakeholderReportSchema>;

// ── Hosted report (relay) wire formats ─────────────────────────────────────

/** What Praxis PUTs to /api/reports — the page renders from it. */
export const HostedReportSpecSchema = z.object({
  token: z.string().optional(),
  report_id: z.string(),
  tag: z.string(),
  project_name: z.string(),
  brand: ReportBrandSchema,
  title: z.string(),
  summary: z.string(),
  period: z.object({ from: z.string(), to: z.string() }),
  /** Ordered sections with the items to render under each. */
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      blurb: z.string().optional(),
      items: z.array(ReportItemSchema),
    }),
  ),
  questions: z.array(ReportQuestionSchema).default([]),
  /** Recipients, so the page can attribute a response to a member. */
  respondents: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  intro: z.string().optional(),
  footer: z.string().optional(),
  createdAt: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type HostedReportSpec = z.infer<typeof HostedReportSpecSchema>;

export const ReportItemResponseSchema = z.object({
  decision: ReportItemDecisionSchema.optional(),
  note: z.string().max(4000).optional(),
});
export type ReportItemResponse = z.infer<typeof ReportItemResponseSchema>;

/** What the hosted page POSTs and Praxis polls back. */
export const ReportResponseSchema = z.object({
  token: z.string(),
  report_id: z.string().optional(),
  tag: z.string().optional(),
  respondent: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      email: z.string().optional(),
    })
    .default({}),
  items: z.record(ReportItemResponseSchema).default({}),
  overall: z
    .object({
      text: z.string().max(20_000).optional(),
      rating: z.number().min(1).max(5).optional(),
      template_feedback: z.string().max(4000).optional(),
    })
    .default({}),
  answered_at: z.string(),
});
export type ReportResponse = z.infer<typeof ReportResponseSchema>;

/** Map a report-form decision onto a gate decision. */
export const REPORT_DECISION_TO_GATE: Record<ReportItemDecision, StakeholderDecision["decision"]> = {
  approve: "approve",
  changes: "defer",
  not_now: "reject",
  duplicate: "duplicate",
};
