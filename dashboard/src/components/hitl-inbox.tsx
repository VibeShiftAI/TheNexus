"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, HelpCircle, Loader2 } from "lucide-react";
import type { HITLRequest } from "@praxis/contract";
import { useHitlInbox } from "@/hooks/use-hitl-inbox";

const REASON_LABELS: Record<string, string> = {
  low_confidence: "Low confidence",
  subjective_validation: "Validation",
  explicit_request: "Input requested",
  ontological_guard: "Guardrail",
  budget_gate: "Budget gate",
};

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
        <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300">
          {pendingRequests.length}
        </span>
      </div>

      {error ? <p className="mb-3 text-xs text-rose-300">{error}</p> : null}

      {pendingRequests.length === 0 ? (
        <p className="text-xs text-slate-400">No input needed right now.</p>
      ) : (
        <div className="space-y-3">
          {pendingRequests.map((request) => (
            <HitlRequestCard
              key={request.id}
              request={request}
              resolving={resolvingId === request.id}
              onResolve={resolveRequest}
            />
          ))}
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
  const reasonLabel = REASON_LABELS[request.reason] ?? request.reason;

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
        <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
          {reasonLabel}
        </span>
        {request.confidenceScore !== undefined ? (
          <span className="text-[11px] text-slate-400">{request.confidenceScore}% confidence</span>
        ) : null}
      </div>

      <div className="mb-3 flex gap-2 text-sm text-slate-100">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
        <p>{request.question}</p>
      </div>

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
