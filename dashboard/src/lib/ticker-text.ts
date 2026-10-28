import type { HITLRequest } from "@praxis/contract";
import { describeHitlAction } from "@/lib/alert-action";
import { hitlTaskMeta } from "@/lib/hitl-meta";
import { briefFromMetadata } from "@/lib/human-brief";

/**
 * The bridge strip's one line for a pending request: the project and the ask
 * when the card carries a human brief, else the project and what the card is
 * about (its task title or first line). The generic "Your input is needed:
 * type your answer" wording is gone (Robert, 2026-10-21); kind-specific
 * guidance (a red alert's acknowledgment repairs nothing) still shows.
 */
export function pendingRequestTickerText(request: HITLRequest): string {
  const action = describeHitlAction(request);
  const meta = hitlTaskMeta(request);
  const brief = briefFromMetadata(request.metadata);
  const project = brief?.project ?? meta.projectName;
  const subject = (brief ? brief.ask || brief.situation : undefined) ?? action.guidance ?? meta.taskTitle ?? request.question.split("\n").find(l => l.trim()) ?? action.label;
  return project && !subject.startsWith(project) ? `${project}: ${subject}` : subject;
}
