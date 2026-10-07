/**
 * EventTicker — persistent bottom strip streaming live Praxis events, with
 * red-alert escalation: an unresolved HITL request turns the strip amber
 * ("input needed"), a recent task failure turns it red. Fed by the shared
 * SSE stream, so it reacts the moment events land. Click the strip to open
 * the full event log popup.
 */
"use client";

import Link from "next/link";
import { DisplayScaleControl } from "@/components/display-scale";
import { activityFromStream, taskActivityHref } from "@/lib/bridge-activity";
import { useBridgeActivity } from "./activity-provider";
import { useEffect, useState } from "react";
import { AlertTriangle, Siren, Rss, ChevronUp, ScrollText } from "lucide-react";
import { useLiveBoardState } from "@/components/live-board-state";
import { HudModal } from "@/components/bridge/hud";
import type { StreamEvent } from "@praxis/contract";
import { useHitlInbox } from "@/hooks/use-hitl-inbox";
import { describeHitlAction, selectPendingAlert } from "@/lib/alert-action";

const FAILURE_ALERT_WINDOW_MS = 10 * 60 * 1000;

function truncate(text: string, max = 90) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeEvent(e: StreamEvent): string | null {
  switch (e.type) {
    case "presence.changed":
      return `presence → ${e.presence.activity}${e.presence.summary ? ` — ${truncate(e.presence.summary, 60)}` : ""}`;
    case "task.created":
      return `task created — ${truncate(e.task?.title ?? e.task?.id ?? "untitled", 60)}`;
    case "task.updated":
      return `task updated`;
    case "task.started":
      return `task ${e.taskId} started on ${e.executor}`;
    case "task.completed":
      return `task ${e.taskId} ${e.result?.outcome ?? "completed"} — ${truncate(e.result?.summary ?? "", 60)}`;
    case "task.failed":
      return `task ${e.taskId} FAILED — ${truncate(e.error, 70)}`;
    case "task.blocked":
      return `task ${e.taskId} blocked — ${truncate(e.reason, 60)}`;
    case "hitl.created":
      return `input requested — ${truncate(e.request?.question ?? "approval requested", 70)}`;
    case "hitl.resolved":
      return `input resolved (${e.requestId})`;
    case "thinking.trace":
      return `thinking — ${truncate(e.content, 70)}`;
    case "schedule.updated":
      return `schedule updated — ${e.scheduledTasks.length} task${e.scheduledTasks.length === 1 ? "" : "s"}`;
    case "executor.progress":
      return `${e.progress.executor} · ${e.progress.phase}${
        e.progress.progressPct != null ? ` ${Math.round(e.progress.progressPct)}%` : ""
      }${e.progress.message ? ` — ${truncate(e.progress.message, 50)}` : ""}`;
    case "stream.reset":
      return "stream reset — resynchronizing";
    default:
      return null;
  }
}

function fmtClock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

type AlertLevel = "none" | "amber" | "red";

function eventTone(e: StreamEvent): string {
  switch (e.type) {
    case "task.failed":
    case "task.blocked":
      return "text-red-300";
    case "hitl.created":
      return "text-amber-300";
    case "task.completed":
      return "text-emerald-300";
    case "thinking.trace":
      return "text-violet-300";
    case "executor.progress":
    case "task.started":
      return "text-cyan-300";
    default:
      return "text-slate-300";
  }
}

export function EventTicker() {
  const { recentEvents, connected } = useLiveBoardState();
  const { items: activityItems } = useBridgeActivity();
  const { pendingRequests, refreshing: inboxLoading, error: inboxError } = useHitlInbox();
  const [logOpen, setLogOpen] = useState(false);
  // Re-render every 30s so time-windowed alerts (task.failed) expire visually.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClockTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // The bounded event ring cannot prove a request is still open. The inbox
  // snapshot is authoritative; transport errors must not resurrect old asks.
  let alert: AlertLevel = "none";
  let alertText: string | null = null;
  let alertHref = '/activity';
  let alertLinkLabel = 'Review event details';
  for (const e of recentEvents) {
    if (e.type === "task.failed" && Date.now() - new Date(e.at).getTime() < FAILURE_ALERT_WINDOW_MS) {
      alert = "red";
      alertText = describeEvent(e);
      alertHref = taskActivityHref(e.taskId);
      alertLinkLabel = 'Review current task status';
      break;
    }
  }
  const pendingRequest = !inboxLoading && !inboxError ? selectPendingAlert(pendingRequests, alert === 'red') : undefined;
  if (pendingRequest) {
    const action = describeHitlAction(pendingRequest);
    alert = pendingRequest.priority === 'critical' ? 'red' : 'amber';
    alertText = `${action.label}: ${action.instruction}`;
    alertHref = action.href;
    alertLinkLabel = action.linkLabel;
  }

  const lines = recentEvents
    .map((e) => ({ e, text: describeEvent(e) }))
    .filter((l): l is { e: StreamEvent; text: string } => Boolean(l.text))
    .slice(0, 8);

  const frame =
    alert === "red"
      ? "border-red-500/60 bg-red-950/70 shadow-[0_-4px_24px_rgba(239,68,68,0.25)]"
      : alert === "amber"
      ? "border-amber-500/50 bg-amber-950/40 shadow-[0_-4px_24px_rgba(245,158,11,0.15)]"
      : "border-slate-800 bg-slate-950/90";

  const allLines = recentEvents
    .map((e) => ({ e, text: describeEvent(e) }))
    .filter((l): l is { e: StreamEvent; text: string } => Boolean(l.text));

  return (
    <div className={`fixed inset-x-0 bottom-0 z-30 border-t backdrop-blur-md transition-colors duration-500 ${frame}`}>
      <div className="mx-auto flex max-w-[2400px] items-center gap-2 overflow-hidden px-3">
      <div
        className="flex min-w-0 flex-1 h-9 cursor-pointer items-center gap-3 overflow-hidden px-6"
        onClick={() => setLogOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setLogOpen(true);
          }
        }}
        title="Open full event log"
        aria-label="Open full event log"
      >
        {alert === "red" ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded border border-red-500/60 bg-red-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-300 motion-safe:animate-pulse">
            <Siren size={11} /> {pendingRequest ? 'request pending' : 'recent failure'}
          </span>
        ) : alert === "amber" ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded border border-amber-500/50 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
            <AlertTriangle size={11} /> input needed
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 rounded border border-slate-700 bg-slate-900/80 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            <Rss size={11} className={connected ? "text-cyan-400" : "text-slate-600"} />
            {connected ? "live feed" : "offline"}
          </span>
        )}

        <div className="flex min-w-0 flex-1 items-center gap-6 overflow-hidden whitespace-nowrap font-mono text-[13px]">
          {alert !== "none" && alertText ? (
            <span className={`shrink-0 ${alert === "red" ? "text-red-200" : "text-amber-200"}`}>{alertText}</span>
          ) : null}
          {activityItems[0] && lines[0] && Date.parse(activityItems[0].at) > Date.parse(lines[0].e.at) && <span className="shrink-0 text-cyan-200">{fmtClock(activityItems[0].at)} {activityItems[0].title} · {activityItems[0].detail}</span>}
          {lines.length === 0 ? (
            <span className="shrink-0 text-slate-600">{activityItems[0] ? `${activityItems[0].title} · ${activityItems[0].detail}` : "awaiting telemetry…"}</span>
          ) : (
            lines.map(({ e, text }, i) => (
              <span key={e.eventId ?? i} className={`shrink-0 ${i === 0 ? "text-slate-300" : "text-slate-600"}`}>
                <span className="text-slate-700">{fmtClock(e.at)}</span> {text}
              </span>
            ))
          )}
        </div>

        <ChevronUp size={13} className="shrink-0 text-slate-600" aria-hidden />
      </div>

      {alert !== 'none' && <Link href={alertHref} className="shrink-0 max-w-48 whitespace-normal text-xs font-semibold text-cyan-200 underline">{alertLinkLabel} →</Link>}
      {!pendingRequest && !inboxLoading && !inboxError && pendingRequests.length > 0 && <Link href={`/inbox#${encodeURIComponent(pendingRequests[0].id)}`} className="text-xs text-amber-200 underline">Review pending input →</Link>}
      {inboxError && <Link href="/inbox" className="text-xs text-amber-200 underline">Request status unavailable — check Inbox</Link>}
      <DisplayScaleControl />
      </div>

      {logOpen && (
        <HudModal
          title="Event log"
          subtitle={`${allLines.length} events in the live buffer`}
          icon={<ScrollText size={15} />}
          accent={alert === "red" ? "red" : alert === "amber" ? "amber" : "cyan"}
          onClose={() => setLogOpen(false)}
          wide
        >
          <Link href="/activity" className="mb-4 block text-sm text-cyan-300">Memory, vault, execution & QA activity →</Link>
          {allLines.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">Awaiting telemetry…</p>
          ) : (
            <div className="space-y-1 font-mono text-[11px]">
              {allLines.map(({ e, text }, i) => (
                <div
                  key={e.eventId ?? i}
                  className="flex items-start gap-2 rounded-md border border-slate-800/60 bg-slate-900/40 px-2.5 py-1.5"
                >
                  <span className="shrink-0 tabular-nums text-slate-600">{fmtClock(e.at)}</span>
                  <span className="w-[118px] shrink-0 truncate text-[10px] uppercase tracking-wide text-slate-500">
                    {e.type}
                  </span>
                  <Link href={e.type === 'hitl.created' ? `/inbox#${encodeURIComponent(e.request.id)}` : e.type === 'hitl.resolved' ? `/inbox#${encodeURIComponent(e.requestId)}` : activityFromStream(e)?.href ?? (e.type === "thinking.trace" && e.taskId ? taskActivityHref(e.taskId) : e.type === "council.update" ? `/council?session=${encodeURIComponent(e.council.sessionId)}` : "/activity")} className={`min-w-0 flex-1 break-words underline decoration-slate-700 underline-offset-4 hover:text-white ${eventTone(e)}`}>{e.type === 'hitl.created' ? `Input requested: ${e.request.question}` : text}</Link>
                </div>
              ))}
            </div>
          )}
        </HudModal>
      )}
    </div>
  );
}
