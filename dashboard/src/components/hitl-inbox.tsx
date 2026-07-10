"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Loader2,
  Maximize2,
} from "lucide-react";
import type { HITLRequest } from "@praxis/contract";
import { useHitlInbox } from "@/hooks/use-hitl-inbox";
import { hitlTaskMeta, parseResumeContext, REASON_LABELS } from "@/lib/hitl-meta";
import {
  BoardMaintenanceHitlCard,
  ScheduleHitlCard,
  SkillCandidatesHitlCard,
  isBoardMaintenanceHitl,
  isScheduleHitl,
  isSkillCandidatesHitl,
} from "./schedule-hitl-card";

export function HitlInbox() {
  const { error, loading, pendingRequests, resolvingId, resolveRequest } = useHitlInbox();

  if (loading) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
          <span>Checking for input requests</span>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {pendingRequests.length > 0 ? (
            <AlertCircle className="h-4 w-4 text-amber-400" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          )}
          <h3 className="text-sm font-bold text-white">Praxis Inbox</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300">
            {pendingRequests.length}
          </span>
          <Link
            href="/inbox"
            title="Open the full inbox"
            aria-label="Open the full inbox"
            className="rounded-md border border-slate-700 p-1 text-slate-400 transition hover:border-cyan-500 hover:text-cyan-300"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      {error ? <p className="mb-3 text-xs text-rose-300">{error}</p> : null}

      {pendingRequests.length === 0 ? (
        <p className="text-xs text-slate-400">No input needed right now.</p>
      ) : (
        <div className="space-y-3">
          {pendingRequests.map((request) =>
            isScheduleHitl(request) ? (
              <ScheduleHitlCard
                key={request.id}
                request={request}
                resolving={resolvingId === request.id}
                onResolve={resolveRequest}
              />
            ) : isSkillCandidatesHitl(request) ? (
              <SkillCandidatesHitlCard
                key={request.id}
                request={request}
                resolving={resolvingId === request.id}
                onResolve={resolveRequest}
              />
            ) : isBoardMaintenanceHitl(request) ? (
              <BoardMaintenanceHitlCard
                key={request.id}
                request={request}
                resolving={resolvingId === request.id}
                onResolve={resolveRequest}
              />
            ) : (
              <HitlRequestCard
                key={request.id}
                request={request}
                resolving={resolvingId === request.id}
                onResolve={resolveRequest}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function HitlRequestCard({
  onResolve,
  request,
  resolving,
}: {
  onResolve: (requestId: string, input: { choice?: string; freeText?: string }) => Promise<void>;
  request: HITLRequest;
  resolving: boolean;
}) {
  const [reply, setReply] = useState("");
  const [showContext, setShowContext] = useState(false);
  const reasonLabel = REASON_LABELS[request.reason] ?? request.reason;
  const meta = hitlTaskMeta(request);
  const resume = parseResumeContext(request.originalPayload?.prompt);
  // Only offer the accordion when the payload adds something beyond the
  // question itself (older records set prompt = question verbatim).
  const hasContext =
    (resume.context.length > 0 && resume.context !== request.question) || resume.tail.length > 0;

  async function submit(choice?: string) {
    const freeText = reply.trim();
    await onResolve(request.id, {
      choice,
      freeText: freeText.length > 0 ? freeText : undefined,
    });
    setReply("");
  }

  return (
    <article className="rounded-lg border border-slate-700 bg-slate-950/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
            {reasonLabel}
          </span>
          {meta.executor ? (
            <span className="rounded-full bg-slate-700/40 px-2 py-0.5 font-mono text-[10px] text-slate-300">
              {meta.executor}
            </span>
          ) : null}
        </div>
        {request.confidenceScore !== undefined ? (
          <span className="text-[11px] text-slate-400">{request.confidenceScore}% confidence</span>
        ) : null}
      </div>

      {request.taskId ? (
        <Link
          href={`/task/${encodeURIComponent(request.taskId)}`}
          title={`Open task ${request.taskId}`}
          className="mb-2 flex items-center gap-1.5 text-xs text-cyan-300 transition hover:text-cyan-200"
        >
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="truncate font-medium">
            {meta.taskTitle ?? request.taskId}
          </span>
          {meta.projectName ? (
            <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
              {meta.projectName}
            </span>
          ) : null}
        </Link>
      ) : null}

      <div className="mb-3 flex gap-2 text-sm text-slate-100">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
        <p>{request.question}</p>
      </div>

      {hasContext ? (
        <div className="mb-3">
          <button
            onClick={() => setShowContext((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-slate-400 transition hover:text-slate-200"
          >
            {showContext ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Agent context
          </button>
          {showContext ? (
            <div className="mt-1.5 space-y-2 rounded-md border border-slate-800 bg-slate-900/70 p-2">
              {resume.context && resume.context !== request.question ? (
                <p className="whitespace-pre-wrap text-xs text-slate-300">{resume.context}</p>
              ) : null}
              {resume.tail ? (
                <pre className="max-h-40 overflow-auto rounded bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-500">
                  {resume.tail}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {request.options && request.options.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {request.options.map((option) => (
            <button
              key={option}
              disabled={resolving}
              onClick={() => void submit(option)}
              className="rounded-md border border-cyan-500/40 px-2.5 py-1 text-xs text-cyan-200 transition hover:border-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}

      <textarea
        value={reply}
        onChange={(event) => setReply(event.target.value)}
        placeholder="Add context for Praxis"
        className="mb-2 min-h-20 w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-500"
      />

      <button
        disabled={resolving || reply.trim().length === 0}
        onClick={() => void submit()}
        className="w-full rounded-md bg-cyan-500 px-3 py-2 text-xs font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
      >
        {resolving ? "Sending..." : "Send Reply"}
      </button>
    </article>
  );
}
