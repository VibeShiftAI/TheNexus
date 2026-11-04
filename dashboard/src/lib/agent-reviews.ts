import {
  ensureLocalOperatorSession,
  localOperatorHeaders,
} from "./local-operator-session";
export interface ReviewAuthor {
  id: string;
  name?: string;
  authority?: string;
}
export interface AgentChoice {
  suggestion_id: string;
  status: "accepted" | "rejected" | "pending";
  replacement?: string;
  actor?: ReviewAuthor;
}
export interface AgentSuggestion {
  id: string;
  start: number;
  end: number;
  original: string;
  proposed: string;
  explanation: string;
}
export interface AgentComment {
  id: string;
  body: string;
  original?: string;
  author: ReviewAuthor;
  resolved: boolean;
  replies: { id: string; body: string; author: ReviewAuthor }[];
}
export interface AgentReview {
  id: string;
  document_id: string;
  base_revision_id: string;
  task_id: string;
  author: ReviewAuthor;
  status: "assigned" | "submitted" | "applied";
  summary: string;
  comments: AgentComment[];
  suggestions: AgentSuggestion[];
  choices: AgentChoice[];
  result_revision_id?: string;
  application?: { client_apply_id: string };
}
export interface AgentReviewDetail {
  review: AgentReview;
  revision: { id: string; content: string };
  current_revision_id: string;
}
export async function agentReviewRequest<T>(
  documentId: string,
  suffix = "",
  body?: unknown,
  method = "POST",
): Promise<T> {
  const url = `/api/documents/${encodeURIComponent(documentId)}/agent-reviews${suffix}`;
  await ensureLocalOperatorSession();
  const localHeaders = localOperatorHeaders(url);
  const res = await fetch(url, {
    ...(Object.keys(localHeaders).length ? { redirect: "error" as const } : {}),
    credentials: "include",
    cache: "no-store",
    method: body === undefined ? "GET" : method,
    headers: {
      "Content-Type": "application/json",
      ...localHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
export function previewSuggestions(
  content: string,
  suggestions: AgentSuggestion[],
  choices: AgentChoice[],
): string {
  const edits = suggestions
    .flatMap((s) => {
      const c = choices.find(
        (c) => c.suggestion_id === s.id && c.status === "accepted",
      );
      return c ? [{ ...s, replacement: c.replacement ?? s.proposed }] : [];
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let last = -1;
  let lastStart = -1;
  for (const e of edits) {
    if (
      e.start < last ||
      e.start === lastStart ||
      e.start < 0 ||
      e.end < e.start ||
      e.end > content.length ||
      content.slice(e.start, e.end) !== e.original
    )
      throw new Error(
        "Selected changes overlap or do not match the assigned revision. Resolve choices before applying.",
      );
    last = e.end;
    lastStart = e.start;
  }
  return edits
    .reverse()
    .reduce(
      (text, e) => text.slice(0, e.start) + e.replacement + text.slice(e.end),
      content,
    );
}
