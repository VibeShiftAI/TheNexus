"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { authFetch } from "@/lib/nexus/shared";
import type { AutomaticStartRequest, LiveWorkItem } from "@/lib/nexus/dispatch-insight";
import { taskHref } from "@/lib/task-links";

/** Mounting this control never starts work: the operator must click. */
export function AutomaticStartControl({ item, onChanged, disabled = false }: {
  item: LiveWorkItem; onChanged?: () => void | Promise<void>; disabled?: boolean;
}) {
  const [request, setRequest] = useState(item.automaticStart ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionUrl, setActionUrl] = useState<string | null>(null);
  useEffect(() => { setRequest(item.automaticStart ?? null); }, [item.taskId, item.automaticStart]);
  const active = request && request.state !== "cancelled";
  const cancellable = active && (request.state === "waiting" || request.state === "held");
  const canStart = !active && !item.autoStart && item.lane === "waiting";
  const waiting = (item.waitingOn?.length ?? 0) > 0;
  async function change() {
    if (busy || disabled || item.automaticStartError) return;
    setBusy(true); setError(null); setActionUrl(null);
    try {
      const res = await authFetch("/api/praxis/dispatch/automatic-start" + (cancellable ? `/${encodeURIComponent(item.taskId)}` : ""), {
        method: cancellable ? "DELETE" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cancellable ? { expectedRequestedAt: request.requestedAt } : { taskId: item.taskId, expectedVersion: item.taskVersion }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.actionUrl === "https://nexus.vibeshiftai.com/calendar") setActionUrl(data.actionUrl);
        throw new Error(data.error || data.reply || "Automatic-start change was not confirmed. Refresh before trying again.");
      }
      if (!data.request || data.request.taskId !== item.taskId) throw new Error("Automatic-start change was not confirmed. Refresh before trying again.");
      setRequest(data.request as AutomaticStartRequest); await onChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : "Automatic-start change could not be confirmed."); }
    finally { setBusy(false); }
  }
  if (item.improvement || item.lane !== "waiting") return null;
  return <div data-automatic-start-control className="mt-2 w-full text-xs">
    {(item.followsToday?.length ?? 0) > 0 && <p className="mb-1 text-slate-400">
      Follows today’s approved work:{" "}
      {item.followsToday!.map((parent, index) => <span key={parent.taskId}>
        {index > 0 && "; "}<Link href={taskHref(parent.taskId)} className="underline">{parent.title}</Link>
      </span>)}
    </p>}
    {item.legacyAutoStart && !active && <p className="text-cyan-200">Automatic start is set by a predecessor’s successor link. <Link href={taskHref(item.taskId)} className="underline">Review sequence</Link></p>}
    {active && <p className={request.state === "held" || request.state === "uncertain" ? "text-amber-300" : "text-cyan-200"}>
      {request.state === "waiting" ? "Automatic start saved. " : ""}{request.detail || request.state}
    </p>}
    {(canStart || cancellable) && <button type="button" onClick={() => void change()}
      disabled={disabled || !!item.automaticStartError || busy || (canStart && (item.taskVersion == null || !Number.isInteger(item.taskVersion) || item.taskVersion < 0))}
      className="rounded border border-cyan-700/70 px-2 py-1 text-cyan-200 hover:bg-cyan-900/30 disabled:opacity-50">
      {busy ? "Saving…" : cancellable ? "Cancel automatic start" : waiting ? "Start automatically after predecessors" : "Queue to start now"}
    </button>}
    {canStart && <p className="mt-1 text-[11px] text-slate-400">{waiting ? "Starts after all predecessors complete, subject to dispatch checks and available capacity." : "Predecessors are complete. This authorizes execution as soon as dispatch checks and capacity allow."}</p>}
    {item.automaticStartError && <p role="alert" className="mt-1 text-amber-300">Automatic start unavailable: {item.automaticStartError} <Link href="/system-monitor" className="underline">Review System Monitor</Link></p>}
    {error && <p role="alert" className="mt-1 text-amber-300">{error} <Link href={actionUrl || taskHref(item.taskId)} className="underline">{actionUrl ? "Open signed-in Nexus" : "Review task"}</Link></p>}
    {active && (request.state === "uncertain" || request.state === "held") && <Link href={taskHref(item.taskId)} className="underline text-amber-200">Review task and dispatch details</Link>}
  </div>;
}
