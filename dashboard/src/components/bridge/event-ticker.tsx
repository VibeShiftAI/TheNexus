/**
 * EventTicker — persistent bottom strip streaming live Praxis events, with
 * red-alert escalation: an unresolved HITL request turns the strip amber
 * ("input needed"), a recent task failure turns it red. Fed by the shared
 * SSE stream, so it reacts the moment events land. Click the strip to open
 * the full event log popup.
 */
"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Siren, Rss, ChevronUp, ScrollText } from "lucide-react";
import { useLiveBoardState } from "@/components/live-board-state";
import { HudModal } from "@/components/bridge/hud";
import type { StreamEvent } from "@praxis/contract";

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
      return `input needed — ${truncate(e.request?.question ?? "approval required", 70)}`;
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
  const [logOpen, setLogOpen] = useState(false);
  // Re-render every 30s so time-windowed alerts (task.failed) expire visually.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClockTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Alert derivation: newest failure inside the window → red;
  // hitl.created with no later hitl.resolved → amber.
  let alert: AlertLevel = "none";
  let alertText: string | null = null;
  const resolvedIds = new Set(
    recentEvents.filter((e) => e.type === "hitl.resolved").map((e) => (e.type === "hitl.resolved" ? e.requestId : ""))
  );
  for (const e of recentEvents) {
    if (e.type === "task.failed" && Date.now() - new Date(e.at).getTime() < FAILURE_ALERT_WINDOW_MS) {
      alert = "red";
      alertText = describeEvent(e);
      break;
    }
    if (alert === "none" && e.type === "hitl.created" && e.request?.id && !resolvedIds.has(e.request.id)) {
      alert = "amber";
      alertText = describeEvent(e);
    }
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
      <div
        className="container mx-auto flex h-9 cursor-pointer items-center gap-3 overflow-hidden px-6"
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
            <Siren size={11} /> red alert
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
            <span className={alert === "red" ? "text-red-200" : "text-amber-200"}>{alertText}</span>
          ) : null}
          {lines.length === 0 ? (
            <span className="text-slate-600">awaiting telemetry…</span>
          ) : (
            lines.map(({ e, text }, i) => (
              <span key={e.eventId ?? i} className={i === 0 ? "text-slate-300" : "text-slate-600"}>
                <span className="text-slate-700">{fmtClock(e.at)}</span> {text}
              </span>
            ))
          )}
        </div>

        <ChevronUp size={13} className="shrink-0 text-slate-600" aria-hidden />
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
                  <span className={`min-w-0 flex-1 break-words ${eventTone(e)}`}>{text}</span>
                </div>
              ))}
            </div>
          )}
        </HudModal>
      )}
    </div>
  );
}
