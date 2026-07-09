/**
 * useActiveWork — the single "what is executing right now" signal that powers
 * the Praxis Terminal's Now strip.
 *
 * The model / task name / token count are read from TASK-CORRELATED dispatch
 * telemetry (`GET /api/dispatches/active`): the in-flight `task_dispatches`
 * row(s) whose outcome is still 'running'. That row carries the exact model
 * routed for this task and a token total aggregated over *this task's* own
 * dispatches — never a global usage feed, so background ingestion elsewhere
 * can't move the displayed figures. When a value isn't known yet (e.g. a
 * running row whose token count is only written at completion), it surfaces as
 * null and the strip shows "unavailable" rather than a borrowed number.
 *
 * Presence (shared SSE stream) and crew activity (already-open connections)
 * still contribute the running/idle heartbeat and activity tone, and provide a
 * task label when Praxis itself — rather than a dispatched executor — is the
 * one working. The only new traffic is a small `/dispatches/active` poll,
 * paused when the tab is hidden, with memoized output to avoid flicker.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { usePraxisStream } from "./use-praxis-stream";
import { useCrewActivity } from "./use-crew-activity";
import type { PresenceActivity } from "@praxis/contract";

/** One in-flight, task-correlated dispatch row from /api/dispatches/active. */
interface ActiveDispatch {
  id: string;
  taskId: string;
  projectId: string | null;
  executor: string;
  kind: string;
  model: string | null;
  tokens: number | null;
  tokensEstimated: boolean;
  title: string | null;
  startedAt: string;
}
interface ActiveResponse {
  active?: ActiveDispatch[];
}

// Light poll of the active-dispatch endpoint (matches the crew-strip cadence).
const POLL_MS = 10_000;
// Presence activities that mean Praxis itself is doing work.
const PRAXIS_BUSY: PresenceActivity[] = ["thinking", "executing", "waiting", "blocked"];

export interface ActiveWork {
  /** true when an in-flight dispatch, Praxis, or a crew executor indicates live work */
  running: boolean;
  /** presence activity (idle/thinking/executing/…), for the state label + tone */
  activity: PresenceActivity;
  /** human-readable name of the task/activity in flight, if known */
  taskLabel: string | null;
  /** the model running THIS task (from its dispatch row); null when unavailable */
  model: string | null;
  /** token total for THIS task's dispatches; null when none recorded yet */
  tokens: number | null;
  /** whether `tokens` is an estimate (text-volume) rather than an exact count */
  tokensEstimated: boolean;
  /** which executor is running it (dispatch executor or crew id), if known */
  executor: string | null;
  /** presence stream connection state */
  connected: boolean;
}

export function useActiveWork(): ActiveWork {
  const { presence, connected } = usePraxisStream();
  const { crew } = useCrewActivity();
  const [active, setActive] = useState<ActiveDispatch[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch("/api/dispatches/active?limit=5", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as ActiveResponse;
        if (alive) setActive(data.active ?? []);
      } catch {
        /* strip degrades to presence + crew only */
      }
    };
    load();
    const poll = setInterval(load, POLL_MS);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return useMemo(() => {
    const activity: PresenceActivity = connected ? (presence?.activity ?? "offline") : "offline";

    // Freshest in-flight dispatch is the authoritative source for the numbers.
    const dispatch = active?.[0] ?? null;
    const busyCrew = crew.filter((m) => m.state === "active");
    const praxisBusy = PRAXIS_BUSY.includes(activity);
    const running = Boolean(dispatch) || praxisBusy || busyCrew.length > 0;

    // Model & tokens are TASK-CORRELATED: only ever from the in-flight dispatch
    // row, or null (→ "unavailable") when no dispatch is attributable.
    let taskLabel: string | null = null;
    let model: string | null = null;
    let tokens: number | null = null;
    let tokensEstimated = false;
    let executor: string | null = null;

    if (dispatch) {
      const base = dispatch.title ?? `task ${dispatch.taskId.slice(0, 8)}`;
      taskLabel = dispatch.kind === "follow_up" ? `${base} · follow-up` : base;
      model = dispatch.model;
      tokens = dispatch.tokens;
      tokensEstimated = dispatch.tokensEstimated;
      executor = dispatch.executor;
    } else if (praxisBusy && presence?.summary) {
      // Praxis itself is working; no dispatch row → model/tokens stay unavailable.
      taskLabel = presence.summary;
    } else if (busyCrew.length > 0) {
      const m = busyCrew[0];
      taskLabel = m.detail ? `${m.label} · ${m.detail}` : m.label;
      executor = m.id;
    } else if (presence?.summary) {
      taskLabel = presence.summary;
    }

    return { running, activity, taskLabel, model, tokens, tokensEstimated, executor, connected };
  }, [presence, crew, active, connected]);
}
