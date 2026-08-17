"use client";

/**
 * /inbox — the full Praxis Inbox route.
 *
 * Navigated to in-app from the inbox card (hitl-inbox.tsx) — never a popup, so
 * the whole experience stays inside the Tauri window. Everything the sidebar
 * card shows, plus: filter rails, live-stream status, full agent context per
 * question, task deep links, park-without-answer, and resolved history.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Inbox,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react";
import type { HITLRequest } from "@praxis/contract";
import { useHitlInbox } from "@/hooks/use-hitl-inbox";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import {
  hitlTaskMeta,
  parseResumeContext,
  PRIORITY_TONES,
  REASON_LABELS,
} from "@/lib/hitl-meta";
import {
  BoardMaintenanceHitlCard,
  ScheduleHitlCard,
  SkillCandidatesHitlCard,
  isBoardMaintenanceHitl,
  isScheduleHitl,
  isSkillCandidatesHitl,
} from "@/components/schedule-hitl-card";
import {
  FontScaleControl,
  inboxFontScaleStyle,
  useInboxFontScale,
} from "@/components/inbox-font-scale";

type FilterId = "all" | "questions" | "approvals" | "other";

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "questions", label: "Questions" },
  { id: "approvals", label: "Approvals" },
  { id: "other", label: "Other" },
];

function isApprovalKind(request: HITLRequest): boolean {
  return (
    isScheduleHitl(request) || isSkillCandidatesHitl(request) || isBoardMaintenanceHitl(request)
  );
}

function filterBucket(request: HITLRequest): FilterId {
  if (hitlTaskMeta(request).kind === "task-question") return "questions";
  if (isApprovalKind(request)) return "approvals";
  return "other";
}

function timeAgo(iso: string | undefined): string {
  if (!iso) return "";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}

export default function InboxPage() {
  const { error, loading, pendingRequests, refresh, resolvingId, resolveRequest } = useHitlInbox();
  const { connected } = usePraxisStream();
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>("all");
  const [history, setHistory] = useState<HITLRequest[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const { scale: fontScale, adjust: adjustFontScale } = useInboxFontScale();

  // Approving the day schedule drops Robert straight back on the bridge
  // (2026-07-17): the "Engage" confirmation voice plays in the dashboard
  // terminal, which isn't mounted on this route — without the hop the
  // announcement sat unplayed until he navigated home by hand. Only the
  // schedule approve warps; other inbox items resolve in place so a
  // triage session isn't interrupted.
  const resolveScheduleAndReturn = useCallback(
    async (requestId: string, input: Parameters<typeof resolveRequest>[1]) => {
      await resolveRequest(requestId, input);
      const choice = (input.choice ?? "").toLowerCase();
      const freeText = (input.freeText ?? "").toLowerCase();
      if (choice.includes("approve") || /\bapprove\b/.test(freeText)) {
        router.push("/");
      }
    },
    [resolveRequest, router],
  );

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/praxis/hitl/recent", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      const requests: HITLRequest[] = Array.isArray(data.requests) ? data.requests : [];
      setHistory(requests.filter((r) => r.resolution).slice(0, 25));
    } catch {
      /* history is decorative — never block the inbox on it */
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, pendingRequests.length]);

  const counts = useMemo(() => {
    const c: Record<FilterId, number> = { all: pendingRequests.length, questions: 0, approvals: 0, other: 0 };
    for (const r of pendingRequests) c[filterBucket(r)] += 1;
    return c;
  }, [pendingRequests]);

  const visible = useMemo(
    () => (filter === "all" ? pendingRequests : pendingRequests.filter((r) => filterBucket(r) === filter)),
    [filter, pendingRequests],
  );

  return (
    <div
      className="min-h-screen bg-slate-950 text-slate-100"
      style={{
        backgroundImage:
          "radial-gradient(ellipse 80% 50% at 50% -10%, rgba(34,211,238,0.09), transparent), linear-gradient(rgba(148,163,184,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.045) 1px, transparent 1px)",
        backgroundSize: "100% 100%, 32px 32px, 32px 32px",
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 border-b border-cyan-500/20 bg-slate-950/90 px-4 pb-3 pt-4 backdrop-blur">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {/* The inbox is a full in-app route (never a popup), so it needs its
                own way back to the bridge. */}
            <Link
              href="/"
              title="Back to the bridge"
              aria-label="Back to the bridge"
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-slate-800 px-2 py-1.5 text-slate-400 transition hover:border-cyan-500 hover:text-cyan-300"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="text-[11px] font-semibold uppercase tracking-wider">Bridge</span>
            </Link>
            <div className="rounded-md border border-cyan-500/40 bg-cyan-500/10 p-1.5">
              <Inbox className="h-4 w-4 text-cyan-300" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold uppercase tracking-widest text-white">
                Praxis Inbox
              </h1>
              <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                crew input requests
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <FontScaleControl scale={fontScale} onAdjust={adjustFontScale} />
            <span
              className="flex items-center gap-1.5 rounded-full border border-slate-800 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-400"
              title={connected ? "Live stream connected" : "Stream disconnected — polling only"}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${connected ? "animate-pulse bg-emerald-400" : "bg-rose-500"}`}
              />
              {connected ? "live" : "offline"}
            </span>
            <button
              onClick={() => void refresh()}
              title="Refresh"
              className="rounded-md border border-slate-800 p-1.5 text-slate-400 transition hover:border-cyan-500 hover:text-cyan-300"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Filter rail */}
        <nav className="flex gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition ${
                filter === f.id
                  ? "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/50"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {f.label}
              <span className="ml-1.5 font-mono text-[10px] opacity-70">{counts[f.id]}</span>
            </button>
          ))}
        </nav>
      </header>

      {/* ── Pending list ───────────────────────────────────────────────── */}
      <main className="space-y-3 px-4 py-4" style={inboxFontScaleStyle(fontScale)}>
        {error ? (
          <p className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-[length:var(--hitl-fs-xs,0.75rem)] text-rose-300">
            {error}
          </p>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
            Scanning channels…
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Sparkles className="h-6 w-6 text-emerald-400/70" />
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-300/90">
              All channels clear
            </p>
            <p className="text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-500">
              {filter === "all" ? "No input requests pending." : "Nothing pending in this filter."}
            </p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {visible.map((request) => (
              <motion.div
                key={request.id}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.18 }}
              >
                {isScheduleHitl(request) ? (
                  <ScheduleHitlCard
                    request={request}
                    resolving={resolvingId === request.id}
                    onResolve={resolveScheduleAndReturn}
                  />
                ) : isSkillCandidatesHitl(request) ? (
                  <SkillCandidatesHitlCard
                    request={request}
                    resolving={resolvingId === request.id}
                    onResolve={resolveRequest}
                  />
                ) : isBoardMaintenanceHitl(request) ? (
                  <BoardMaintenanceHitlCard
                    request={request}
                    resolving={resolvingId === request.id}
                    onResolve={resolveRequest}
                  />
                ) : (
                  <InboxQuestionCard
                    request={request}
                    resolving={resolvingId === request.id}
                    onResolve={resolveRequest}
                  />
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        )}

        {/* ── History ──────────────────────────────────────────────────── */}
        {history.length > 0 ? (
          <section className="pt-2">
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-slate-500 transition hover:text-slate-300"
            >
              {showHistory ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Resolved · {history.length}
            </button>
            {showHistory ? (
              <div className="space-y-1.5">
                {history.map((request) => (
                  <HistoryRow key={request.id} request={request} />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}

/* ── Rich pending card ─────────────────────────────────────────────────── */

function InboxQuestionCard({
  onResolve,
  request,
  resolving,
}: {
  onResolve: (
    requestId: string,
    input: { choice?: string; freeText?: string },
  ) => Promise<void>;
  request: HITLRequest;
  resolving: boolean;
}) {
  const [reply, setReply] = useState("");
  const [showContext, setShowContext] = useState(false);
  const meta = hitlTaskMeta(request);
  const resume = parseResumeContext(request.originalPayload?.prompt);
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
              {showContext ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
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
          <div className="mb-3 flex flex-wrap gap-2">
            {request.options.map((option) => (
              <button
                key={option}
                disabled={resolving}
                onClick={() => void submit(option)}
                className="rounded-md border border-cyan-500/40 px-2.5 py-1 text-[length:var(--hitl-fs-xs,0.75rem)] text-cyan-200 transition hover:border-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {option}
              </button>
            ))}
          </div>
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
            {resolving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
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

/* ── Resolved history row ──────────────────────────────────────────────── */

function HistoryRow({ request }: { request: HITLRequest }) {
  const meta = hitlTaskMeta(request);
  const answer = request.resolution?.choice || request.resolution?.freeText || "(no answer — parked)";
  return (
    <div className="flex items-start gap-2 rounded-md border border-slate-900 bg-slate-950/40 px-2.5 py-2">
      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500/60" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-400">
          {meta.taskTitle ? <span className="text-slate-300">{meta.taskTitle} — </span> : null}
          {request.question}
        </p>
        <p className="truncate font-mono text-[length:var(--hitl-fs-10,0.625rem)] text-slate-600">
          ↳ {answer} · {request.resolution?.resolvedBy ?? "?"} ·{" "}
          {timeAgo(request.resolution?.resolvedAt)}
        </p>
      </div>
    </div>
  );
}
