/**
 * Feedback Gateway — wire formats for the end-user feedback pipeline.
 *
 * Flow: an embeddable widget on a client-facing site (JP Lautrup Portfolio,
 * Adventures of Dean, Meeple Magnate, …) captures screenshot + voice note +
 * metadata and POSTs it to the public relay (Cloudflare Pages Functions on
 * vibeshiftai.com, R2-backed queue). Praxis polls the relay, transcribes,
 * triages, and routes each submission into Nexus tasks (directly or via a
 * council plan). Praxis can also reach back out to the submitter by email —
 * prose or a small hosted questionnaire — tagged with a work id so replies
 * trace back to the originating submission/task.
 *
 * The relay itself is dependency-free plain JS (Pages Functions can't import
 * this package without a build step), so these schemas are the *contract of
 * record* validated on the Praxis side; the relay mirrors them structurally.
 */

import { z } from "zod";

// ── Submission ──────────────────────────────────────────────────────────────

export const FeedbackKindSchema = z.enum([
  "bug",
  "feature",
  "question",
  "praise",
  "other",
]);
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;

/** One captured console error from the widget's ring buffer. */
export const FeedbackConsoleErrorSchema = z.object({
  message: z.string(),
  source: z.string().optional(),
  at: z.string().optional(), // ISO timestamp
});
export type FeedbackConsoleError = z.infer<typeof FeedbackConsoleErrorSchema>;

// ── Screenshot markup ───────────────────────────────────────────────────────

/**
 * Markup the submitter drew on the screenshot, as *data* rather than pixels.
 *
 * The widget composites the strokes into the JPEG for a human to look at, and
 * in the same pass measures them: each mark becomes a normalized region, and —
 * when the shot came from the live DOM — the elements under that region are
 * hit-tested and named. That is what lets triage, the council, and an executor
 * act on "he circled the score button" without anyone opening the image.
 */

/** Rectangle normalized 0–1 against the screenshot (origin top-left). */
export const FeedbackMarkupBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type FeedbackMarkupBox = z.infer<typeof FeedbackMarkupBoxSchema>;

/** Point normalized 0–1 against the screenshot. */
export const FeedbackMarkupPointSchema = z.object({ x: z.number(), y: z.number() });
export type FeedbackMarkupPoint = z.infer<typeof FeedbackMarkupPointSchema>;

/** What the stroke geometry looks like — classified client-side, freehand. */
export const FeedbackMarkupShapeSchema = z.enum([
  /** Closed loop: circled/boxed something. */
  "enclosure",
  /** Straight-ish stroke with a hooked head: points AT something. */
  "arrow",
  /** Horizontal stroke sitting under content. */
  "underline",
  /** Horizontal stroke across content. */
  "strike",
  /** Straight stroke, no clear direction semantics. */
  "line",
  /** Back-and-forth: crossed out / emphasized. */
  "scribble",
  /** Tap-sized mark: pointed at a spot. */
  "dot",
]);
export type FeedbackMarkupShape = z.infer<typeof FeedbackMarkupShapeSchema>;

/** One page element found under a mark. */
export const FeedbackMarkupTargetSchema = z.object({
  /** Readable ancestor path, e.g. "main > section.pricing > button#buy". */
  selector: z.string(),
  tag: z.string(),
  /** Accessible name or trimmed visible text. */
  text: z.string().optional(),
  role: z.string().optional(),
  href: z.string().optional(),
  /** data-testid / data-test / data-qa, when the host app ships one. */
  testId: z.string().optional(),
  /** The element's own box, normalized against the screenshot. */
  box: FeedbackMarkupBoxSchema.optional(),
  /** Share of the marked region this element covers, 0–1. */
  coverage: z.number().optional(),
});
export type FeedbackMarkupTarget = z.infer<typeof FeedbackMarkupTargetSchema>;

/** One mark (or a cluster of strokes drawn over the same spot). */
export const FeedbackMarkupRegionSchema = z.object({
  /** Stable within a submission: "m1", "m2", … (referenced in prose). */
  id: z.string(),
  shapes: z.array(FeedbackMarkupShapeSchema).default([]),
  /** Pen colors used, as CSS hex. */
  colors: z.array(z.string()).default([]),
  box: FeedbackMarkupBoxSchema,
  /** Coarse position in words, e.g. "top-right", "center". */
  where: z.string().optional(),
  /** Share of the screenshot the region covers, 0–1. */
  area: z.number().optional(),
  strokeCount: z.number().default(1),
  /** Arrows/lines: where the stroke started and (for arrows) what it points at. */
  from: FeedbackMarkupPointSchema.optional(),
  to: FeedbackMarkupPointSchema.optional(),
  targets: z.array(FeedbackMarkupTargetSchema).default([]),
  /** Text found under the mark (deduped across targets). */
  text: z.string().optional(),
});
export type FeedbackMarkupRegion = z.infer<typeof FeedbackMarkupRegionSchema>;

export const FeedbackMarkupSchema = z.object({
  /** Bumped when the geometry contract changes. */
  version: z.number().default(1),
  /** Screenshot pixel size the boxes are normalized against. */
  image: z.object({ w: z.number(), h: z.number() }).optional(),
  /**
   * "dom" — regions were hit-tested against the live page, so `targets` name
   * real elements. "image" — geometry only (canvas/WebGL capture hook, or the
   * page moved under the widget): boxes are still meaningful, targets are not.
   */
  source: z.enum(["dom", "image"]).default("image"),
  strokeCount: z.number().default(0),
  regions: z.array(FeedbackMarkupRegionSchema).default([]),
  /** Detail was dropped to fit the relay's meta budget. */
  truncated: z.boolean().optional(),
});
export type FeedbackMarkup = z.infer<typeof FeedbackMarkupSchema>;

/**
 * Metadata JSON the widget submits alongside the screenshot/audio blobs.
 * Everything except `project` is best-effort — the pipeline must tolerate
 * partial submissions (mic denied, capture failed, no email given).
 */
export const FeedbackSubmissionMetaSchema = z
  .object({
    /** Widget project id, e.g. "meeple-magnate" — maps to a Nexus project. */
    project: z.string().min(1),
    /** Typed note (fallback or supplement to the voice recording). */
    note: z.string().optional(),
    /** Submitter's reply-to email (persisted client-side between sends). */
    email: z.string().optional(),
    /** Page URL the feedback was captured on. */
    url: z.string().optional(),
    /** navigator.userAgent. */
    userAgent: z.string().optional(),
    /** Viewport at capture time. */
    viewport: z.object({ w: z.number(), h: z.number() }).optional(),
    /** Recent console errors (ring buffer, newest last). */
    consoleErrors: z.array(FeedbackConsoleErrorSchema).optional(),
    /** Client-side capture timestamp (ISO). */
    capturedAt: z.string().optional(),
    /** Widget bundle version. */
    widgetVersion: z.string().optional(),
    /** Host app version, if the site passes one via data-app-version. */
    appVersion: z.string().optional(),
    /** True when the screenshot includes user markup strokes. */
    annotated: z.boolean().optional(),
    /** The markup itself, measured — see FeedbackMarkupSchema. */
    markup: FeedbackMarkupSchema.optional(),
    /** Stamped by the relay on receipt (ISO). */
    receivedAt: z.string().optional(),
    /** CF-IPCountry, stamped by the relay. */
    country: z.string().optional(),
  })
  .passthrough();
export type FeedbackSubmissionMeta = z.infer<typeof FeedbackSubmissionMetaSchema>;

/** One queue entry as returned by the relay's pending listing. */
export const RelayPendingItemSchema = z.object({
  id: z.string(),
  /** R2 object names present for this submission (e.g. ["meta.json", "screen.jpg", "voice.webm"]). */
  files: z.array(z.string()),
  submittedAt: z.string().optional(),
  project: z.string().optional(),
});
export type RelayPendingItem = z.infer<typeof RelayPendingItemSchema>;

// ── Triage ──────────────────────────────────────────────────────────────────

export const FeedbackRouteSchema = z.enum([
  /** Clear, self-contained → file a Nexus task directly. */
  "task",
  /** Feature-sized or ambiguous → convene a council for an implementation plan. */
  "council",
  /** Question/praise/other → no task; draft a reply instead. */
  "reply",
  /** Unusable submission (empty, spam, accidental). */
  "discard",
]);
export type FeedbackRoute = z.infer<typeof FeedbackRouteSchema>;

export const FeedbackTriageSchema = z.object({
  kind: FeedbackKindSchema,
  route: FeedbackRouteSchema,
  severity: z.enum(["low", "medium", "high"]).default("low"),
  /** One-line restatement of what the user wants, in plain language. */
  summary: z.string(),
  /** Why this route was chosen. */
  rationale: z.string().optional(),
  /** 0–1 confidence; low confidence should bias toward "council". */
  confidence: z.number().min(0).max(1).optional(),
  /** Follow-up questions worth asking the submitter, if any. */
  clarifyingQuestions: z.array(z.string()).optional(),
});
export type FeedbackTriage = z.infer<typeof FeedbackTriageSchema>;

// ── Feedback record (Praxis-side ledger row, also served over HTTP) ────────

export const FeedbackStatusSchema = z.enum([
  "received",
  "triaged",
  "tasked", // routed into ≥1 Nexus task
  "replied", // answered by email, no task
  "awaiting_user", // Praxis asked the submitter something
  "closed",
  "discarded",
]);
export type FeedbackStatus = z.infer<typeof FeedbackStatusSchema>;

export const FeedbackRecordSchema = z.object({
  id: z.string(),
  /** Human-facing trace tag, e.g. "PX-MM-12" — appears in emails/tasks. */
  tag: z.string(),
  project: z.string(),
  nexusProjectId: z.string().optional(),
  status: FeedbackStatusSchema,
  email: z.string().optional(),
  transcript: z.string().optional(),
  note: z.string().optional(),
  meta: FeedbackSubmissionMetaSchema.optional(),
  /**
   * Vision read of the annotated screenshot — what the marks point at, in
   * prose. Written once on ingest so every downstream consumer (triage,
   * council, executor payload) sees the same reading of the image.
   */
  markupDescription: z.string().optional(),
  triage: FeedbackTriageSchema.optional(),
  nexusTaskIds: z.array(z.string()).default([]),
  /** Local paths of persisted artifacts (screenshot, audio). */
  artifacts: z.record(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>;

// ── Human queries (Praxis → a person, by email ± questionnaire) ────────────

export const HumanQuestionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  kind: z.enum(["text", "choice", "scale"]).default("text"),
  /** For kind "choice". */
  options: z.array(z.string()).optional(),
  /** For kind "scale" — inclusive bounds, defaults 1–5. */
  min: z.number().optional(),
  max: z.number().optional(),
  required: z.boolean().default(false),
});
export type HumanQuestion = z.infer<typeof HumanQuestionSchema>;

/** Spec stored on the relay; rendered by the hosted questionnaire page. */
export const QuestionnaireSpecSchema = z.object({
  token: z.string(),
  /** Work tag the answers trace back to (e.g. "PX-AOD-7"). */
  tag: z.string(),
  title: z.string(),
  intro: z.string().optional(),
  questions: z.array(HumanQuestionSchema).min(1),
  /** Display name the form greets the person with. */
  recipientName: z.string().optional(),
  createdAt: z.string(),
  /** ISO expiry after which the form refuses submissions. */
  expiresAt: z.string().optional(),
});
export type QuestionnaireSpec = z.infer<typeof QuestionnaireSpecSchema>;

export const QuestionnaireAnswersSchema = z.object({
  token: z.string(),
  tag: z.string().optional(),
  answers: z.record(z.union([z.string(), z.number()])),
  answeredAt: z.string(),
});
export type QuestionnaireAnswers = z.infer<typeof QuestionnaireAnswersSchema>;

export const HumanQueryStatusSchema = z.enum([
  "draft", // composed, awaiting HITL approval to send
  "sent",
  "answered", // reply email or questionnaire answers received
  "expired",
  "cancelled",
]);
export type HumanQueryStatus = z.infer<typeof HumanQueryStatusSchema>;

export const HumanQueryRecordSchema = z.object({
  id: z.string(),
  tag: z.string(),
  to: z.string(),
  subject: z.string(),
  /** Prose body (plain text) sent in the email. */
  body: z.string(),
  questionnaireToken: z.string().optional(),
  questionnaireUrl: z.string().optional(),
  status: HumanQueryStatusSchema,
  /** What work this query serves: a feedback id, Nexus task id, or free ref. */
  workRef: z.string().optional(),
  answers: QuestionnaireAnswersSchema.optional(),
  replyText: z.string().optional(),
  createdAt: z.string(),
  sentAt: z.string().optional(),
  answeredAt: z.string().optional(),
});
export type HumanQueryRecord = z.infer<typeof HumanQueryRecordSchema>;

// ── Trace tags ──────────────────────────────────────────────────────────────

/** Matches "[PX-MM-12]" style tags anywhere in a string (subject lines). */
export const WORK_TAG_PATTERN = /\[?(PX-[A-Z0-9]{2,8}-\d+)\]?/;

/** Extract the first work tag from free text (email subject/body), if any. */
export function extractWorkTag(text: string): string | null {
  const m = WORK_TAG_PATTERN.exec(text);
  return m?.[1] ?? null;
}
