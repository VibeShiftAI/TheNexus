"use client";

/**
 * The Praxis Inbox card — ONE implementation, rendered by every inbox surface.
 *
 * WHY THIS MODULE EXISTS. The bridge widget (`hitl-inbox.tsx`) and the
 * fullscreen route (`app/inbox`) each grew their own copy of this card, and
 * the copies drifted in BOTH directions: the widget alone showed
 * `confidenceScore`, while the fullscreen alone had the priority rail, the
 * relative timestamp, ⌘⏎ submit, and Park. Neither surface was strictly
 * better — Robert simply saw different things depending on where he opened
 * the same queue. The split also made a fix land half-done: the 2026-08-30
 * phone-only marking for "accept as-is" was applied to the widget and silently
 * missed the fullscreen view, which is the one he actually reviews in.
 *
 * There is one inbox, so there is one card. Everything below is the union of
 * what the two copies did; surfaces differ only in the chrome AROUND the list
 * (filters, history, stream status), never in the card itself.
 */

import { useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Archive, ChevronDown, ChevronRight, Loader2, Send } from "lucide-react";
import type { HITLRequest } from "@praxis/contract";

import { hitlTaskMeta, parseResumeContext, PRIORITY_TONES, REASON_LABELS } from "@/lib/hitl-meta";
import { isPhoneOnlyChoice, PHONE_ONLY_HINT } from "@/lib/hitl-choices";
import {
  BoardMaintenanceHitlCard,
  ScheduleHitlCard,
  SkillCandidatesHitlCard,
  isBoardMaintenanceHitl,
  isScheduleHitl,
  isSkillCandidatesHitl,
} from "./schedule-hitl-card";

export type HitlResolveInput = { choice?: string; freeText?: string };
export type HitlResolver = (requestId: string, input: HitlResolveInput) => Promise<void>;

export function timeAgo(iso: string | undefined): string {
  if (!iso) return "";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}

/**
 * Render the right card for a request's kind.
 *
 * `onResolveSchedule` exists for the one genuine per-surface difference: the
 * fullscreen route hops back to the bridge after a schedule approval so the
 * "Engage" confirmation voice has a mounted terminal to play in.
 */
export function HitlCard({
  request,
  resolving,
  onResolve,
  onResolveSchedule,
}: {
  request: HITLRequest;
  resolving: boolean;
  onResolve: HitlResolver;
  onResolveSchedule?: HitlResolver;
}) {
  if (isScheduleHitl(request)) {
    return (
      <ScheduleHitlCard
        request={request}
        resolving={resolving}
        onResolve={onResolveSchedule ?? onResolve}
      />
    );
  }
  if (isSkillCandidatesHitl(request)) {
    return <SkillCandidatesHitlCard request={request} resolving={resolving} onResolve={onResolve} />;
  }
  if (isBoardMaintenanceHitl(request)) {
    return (
      <BoardMaintenanceHitlCard request={request} resolving={resolving} onResolve={onResolve} />
    );
  }
  return <HitlRequestCard request={request} resolving={resolving} onResolve={onResolve} />;
}

export function HitlRequestCard({
  onResolve,
  request,
  resolving,
}: {
  onResolve: HitlResolver;
  request: HITLRequest;
  resolving: boolean;
}) {
  const [reply, setReply] = useState("");
  const [showContext, setShowContext] = useState(false);
  const meta = hitlTaskMeta(request);
  const resume = parseResumeContext(request.originalPayload?.prompt);
  // Only offer the accordion when the payload adds something beyond the
  // question itself (older records set prompt = question verbatim).
  const hasContext =
    (resume.context.length > 0 && resume.context !== request.question) || resume.tail.length > 0;
  const tone = PRIORITY_TONES[request.priority ?? "normal"] ?? PRIORITY_TONES.normal;
  const reasonLabel = REASON_LABELS[request.reason] ?? request.reason;
  // Empty-answer resolution is only a guaranteed no-op for task questions
  // (Praxis parks the task, dispatches nothing). Other kinds fall through to
  // the agent-mediated resume, so don't offer "park" there.
  const canPark = meta.kind === "task-question";

  async function submit(choice?: string) {
    const freeText = reply.trim();
    await onResolve(request.id, {
      choice,
      freeText: freeText.length > 0 ? freeText : undefined,
    });
    setReply("");
  }

  // Park sends a deliberately EMPTY resolution — never the draft text.
  async function park() {
    await onResolve(request.id, {});
    setReply("");
  }

  return (
    <article className="relative overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60">
      <div className={`absolute inset-y-0 left-0 w-0.5 ${tone.rail}`} />
      <div className="p-3.5 pl-4">
        {/* chips row */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span
            className={`rounded-full px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] font-medium ${tone.chip}`}
          >
            {reasonLabel}
          </span>
          {meta.executor ? (
            <span className="rounded-full bg-slate-800 px-2 py-0.5 font-mono text-[length:var(--hitl-fs-10,0.625rem)] text-slate-300">
              {meta.executor}
            </span>
          ) : null}
          {request.confidenceScore !== undefined ? (
            <span className="text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-400">
              {request.confidenceScore}% confidence
            </span>
          ) : null}
          <span className="ml-auto font-mono text-[length:var(--hitl-fs-10,0.625rem)] text-slate-500">
            {timeAgo(request.requestedAt)}
          </span>
        </div>

        {/* task identity */}
        {request.taskId ? (
          <Link
            href={`/task/${encodeURIComponent(request.taskId)}`}
            title={`Open task ${request.taskId}`}
            className="mb-2 flex items-center gap-1.5 text-[length:var(--hitl-fs-xs,0.75rem)] text-cyan-300 transition hover:text-cyan-200"
          >
            <ChevronRight className="h-3 w-3 shrink-0" />
            <span className="truncate font-semibold">{meta.taskTitle ?? request.taskId}</span>
            {meta.projectName ? (
              <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-0.5 text-[length:var(--hitl-fs-10,0.625rem)] text-slate-400">
                {meta.projectName}
              </span>
            ) : null}
          </Link>
        ) : null}

        {/* the question */}
        <p className="mb-3 text-[length:var(--hitl-fs-sm,0.875rem)] leading-relaxed text-slate-100">
          {request.question}
        </p>

        {/* agent context accordion */}
        {hasContext ? (
          <div className="mb-3">
            <button
              onClick={() => setShowContext((v) => !v)}
              className="flex items-center gap-1 text-[length:var(--hitl-fs-11,0.6875rem)] uppercase tracking-wider text-slate-500 transition hover:text-slate-300"
            >
              {showContext ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Agent context
            </button>
            {showContext ? (
              <div className="mt-1.5 space-y-2 rounded-md border border-slate-800 bg-slate-950/70 p-2.5">
                {resume.context && resume.context !== request.question ? (
                  <p className="whitespace-pre-wrap text-[length:var(--hitl-fs-xs,0.75rem)] leading-relaxed text-slate-300">
                    {resume.context}
                  </p>
                ) : null}
                {resume.tail ? (
                  <pre className="max-h-52 overflow-auto rounded bg-slate-950 p-2 font-mono text-[length:var(--hitl-fs-10,0.625rem)] leading-relaxed text-slate-500">
                    {resume.tail}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* option quick-chips */}
        {request.options && request.options.length > 0 ? (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              {request.options.map((option) => {
                const phoneOnly = isPhoneOnlyChoice(option);
                return (
                  <button
                    key={option}
                    disabled={resolving}
                    onClick={() => void submit(option)}
                    title={phoneOnly ? PHONE_ONLY_HINT : undefined}
                    className={
                      phoneOnly
                        ? "rounded-md border border-slate-600 px-2.5 py-1 text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-400 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
                        : "rounded-md border border-cyan-500/40 px-2.5 py-1 text-[length:var(--hitl-fs-xs,0.75rem)] text-cyan-200 transition hover:border-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                    }
                  >
                    {phoneOnly ? `${option} 📱` : option}
                  </button>
                );
              })}
            </div>
            {request.options.some(isPhoneOnlyChoice) ? (
              <p className="mb-3 text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-500">
                📱 {PHONE_ONLY_HINT}
              </p>
            ) : null}
          </>
        ) : null}

        {/* reply */}
        <textarea
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && reply.trim()) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Type your answer… (⌘⏎ to send)"
          className="mb-2 min-h-20 w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-[length:var(--hitl-fs-sm,0.875rem)] text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-500"
        />
        <div className="flex gap-2">
          <button
            disabled={resolving || reply.trim().length === 0}
            onClick={() => void submit()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-cyan-500 px-3 py-2 text-[length:var(--hitl-fs-xs,0.75rem)] font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
          >
            {resolving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            {resolving ? "Sending…" : "Send Answer"}
          </button>
          {canPark ? (
            <button
              disabled={resolving}
              onClick={() => void park()}
              title="Close the question without answering — the task stays parked and nothing is re-dispatched"
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-400 transition hover:border-slate-500 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Archive className="h-3.5 w-3.5" />
              Park
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
