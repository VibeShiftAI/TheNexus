/**
 * Completion evidence dossier client (server/routes/task-evidence.js).
 *
 * A completed task is `verified` only when its walkthrough, verify gate,
 * code-review gate and QA pass are all on record; otherwise it is
 * `unverified` and the server names each missing gate. The helpers below
 * turn that into badge copy and tone, and they never return a green tone for
 * anything but `verified`.
 */

export type EvidencePieceKey = "walkthrough" | "verify" | "code_review" | "qa";
export type EvidenceState = "verified" | "unverified" | "not_completed";
/** `incomplete`: recorded, but missing its timestamp or log path, so it does not count. */
export type EvidencePieceStatus = "present" | "absent" | "failed" | "incomplete";

export interface EvidenceLogRef {
  dispatchId: string;
  taskId: string;
  executor: string | null;
  path: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Bounded transcript tail endpoint, or null when the run recorded no log path. */
  href: string | null;
}

export interface EvidencePiece {
  key: EvidencePieceKey;
  label: string;
  status: EvidencePieceStatus;
  at: string | null;
  /** nexus-task | praxis-verification | executor-report | qa-run */
  source: string | null;
  detail: string | null;
  /** Why the piece is absent, failed or incomplete. */
  reason: string | null;
  /** For `incomplete`: which of "timestamp" / "log reference" is missing. */
  metadataMissing?: string[];
  log: EvidenceLogRef | null;
  ref?: { source: string; seq: number | null; ts: string; path: string | null } | null;
  verdict?: string | null;
  reviewer?: string | null;
}

export interface EvidenceDossier {
  taskId: string;
  taskStatus: string | null;
  completed: boolean;
  state: EvidenceState;
  missing: EvidencePieceKey[];
  summary: string;
  predatesEvidenceCapture: boolean;
  pieces: EvidencePiece[];
  verification: { ts: string; seq: number | null; verdict: string | null } | null;
  sources: {
    spine: {
      available: boolean;
      reason: string | null;
      path: string | null;
      staleRecord: { ts: string; seq: number | null } | null;
    };
  };
}

export type EvidenceSummary = Pick<
  EvidenceDossier,
  "taskId" | "state" | "missing" | "summary" | "predatesEvidenceCapture"
>;

export interface EvidenceLogTail {
  dispatchId: string;
  taskId: string;
  path: string;
  size: number;
  modifiedAt: string;
  truncated: boolean;
  text: string;
}

export const EVIDENCE_PIECE_LABELS: Record<EvidencePieceKey, string> = {
  walkthrough: "Walkthrough",
  verify: "Verify gate",
  code_review: "Code-review gate",
  qa: "QA verdict",
};

/** Short names for a badge line ("missing verify, QA"). */
const SHORT_LABELS: Record<EvidencePieceKey, string> = {
  walkthrough: "walkthrough",
  verify: "verify",
  code_review: "code review",
  qa: "QA",
};

export type EvidenceTone = "verified" | "unverified" | "neutral";

export interface EvidenceBadge {
  tone: EvidenceTone;
  label: string;
  /** Which gates are missing, in plain words; empty when verified. */
  missingText: string;
  title: string;
}

/** Badge copy and tone. Only `verified` is ever the green tone. */
export function evidenceBadge(summary: EvidenceSummary): EvidenceBadge {
  if (summary.state === "verified") {
    return {
      tone: "verified",
      label: "Verified",
      missingText: "",
      title: summary.summary,
    };
  }
  if (summary.state === "unverified") {
    const missing = summary.missing.map((k) => SHORT_LABELS[k] ?? k);
    const missingText = missing.length > 0 ? `missing ${missing.join(", ")}` : "evidence incomplete";
    return {
      tone: "unverified",
      label: summary.predatesEvidenceCapture ? "Unverified (pre-capture)" : "Unverified",
      missingText,
      title: summary.predatesEvidenceCapture
        ? `${summary.summary} Completed before Praxis recorded verification evidence.`
        : summary.summary,
    };
  }
  return { tone: "neutral", label: "Not completed", missingText: "", title: summary.summary };
}

/** Tailwind classes per tone: amber for unverified, never emerald. */
export const EVIDENCE_TONE_CLASSES: Record<EvidenceTone, string> = {
  verified: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  unverified: "border-amber-500/50 bg-amber-500/10 text-amber-200",
  neutral: "border-slate-600 bg-slate-800/60 text-slate-400",
};

/** The in-page anchor a piece's "open" link jumps to on the task screen. */
export function evidencePieceAnchor(key: EvidencePieceKey): string {
  return `evidence-${key}`;
}

const SOURCE_LABELS: Record<string, string> = {
  "nexus-task": "Nexus task record",
  "praxis-verification": "Praxis verification record",
  "executor-report": "executor's own PRAXIS_QUALITY_GATES line",
  "qa-run": "reviewer's PRAXIS_QA_VERDICT line",
};

export function evidenceSourceLabel(source: string | null): string | null {
  if (!source) return null;
  return SOURCE_LABELS[source] ?? source;
}

export async function getTaskEvidence(taskId: string): Promise<EvidenceDossier> {
  const res = await fetch(`/api/task-evidence/${encodeURIComponent(taskId)}?_cb=${Date.now()}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to load evidence (${res.status})`);
  return (await res.json()) as EvidenceDossier;
}

export async function getTaskEvidenceSummaries(taskIds: string[]): Promise<Record<string, EvidenceSummary>> {
  if (taskIds.length === 0) return {};
  const res = await fetch(
    `/api/task-evidence?task_ids=${taskIds.map(encodeURIComponent).join(",")}&_cb=${Date.now()}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Failed to load evidence summaries (${res.status})`);
  const body = (await res.json()) as { tasks?: Record<string, EvidenceSummary> };
  return body.tasks ?? {};
}

export async function getEvidenceLogTail(href: string): Promise<EvidenceLogTail> {
  const res = await fetch(`${href}?_cb=${Date.now()}`, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Partial<EvidenceLogTail> & { error?: string };
  if (!res.ok) throw new Error(body.error || `Failed to load log (${res.status})`);
  return body as EvidenceLogTail;
}
