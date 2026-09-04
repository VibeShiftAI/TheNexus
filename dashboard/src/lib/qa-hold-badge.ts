/**
 * Presentation of a held QA correction — the badge text a task card and the
 * task screen both show, derived in one place so they cannot drift.
 *
 * The point of the badge is that a held task is NOT an ordinary todo: the
 * review happened and failed, the findings are attached, and no strike was
 * spent. A plain dispatch resumes it with those findings.
 */

import type { QaHold } from "@/lib/nexus";

export interface QaHoldBadge {
  /** Chip text — the short verdict. */
  label: string;
  /** Full hover/aria explanation, including the pause reason. */
  title: string;
  /** Short form of the pause reason, for inline display. */
  shortReason: string;
  /** Deep link to the findings (the task screen renders them in full). */
  findingsHref: string;
  hasFindings: boolean;
}

/**
 * Praxis's pause reasons are long sentences carrying remediation advice
 * ("no live day schedule — autonomy is paused. Install a day plan …").
 * The chip needs the clause before the first sentence break; the full text
 * still rides the tooltip.
 */
export function shortHoldReason(reason: string | null | undefined): string {
  const text = (reason ?? "").trim();
  if (!text) return "autonomy paused";
  // Cut at the first sentence end, then at an em-dash aside if one leads.
  const sentence = text.split(/(?<=\.)\s/)[0];
  const clause = sentence.split(" — ")[0].trim().replace(/[.]$/, "");
  return clause || "autonomy paused";
}

export function qaHoldBadge(hold: QaHold): QaHoldBadge {
  const shortReason = shortHoldReason(hold.reason);
  const hasFindings = Boolean(hold.findings?.trim());
  const held = hold.heldAt ? ` on ${hold.heldAt}` : "";
  return {
    label: `QA failed — correction held (${shortReason})`,
    title:
      `QA reviewed this task${held} and it FAILED, but the correction was not re-dispatched: ` +
      `${hold.reason ?? "autonomy is paused"} ` +
      `The task is parked at todo with its findings kept and no strike spent — dispatching it resumes it with them.` +
      (hold.operatorInitiated
        ? " Robert started this task by hand; the explicit stop holds its correction too."
        : "") +
      (hasFindings ? " Open the task to read the findings." : ""),
    shortReason,
    findingsHref: `/task/${hold.taskId}#qa-hold`,
    hasFindings,
  };
}
