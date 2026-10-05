/**
 * schedule-live-work — folds runtime truth about chat-dispatched work into
 * Today's Schedule.
 *
 * The schedule surfaces (the home timeline and /calendar) read calendar
 * events: day-plan slots and the [Ad-hoc] completions the reconciler writes
 * AFTER a task finishes. Work Praxis queued from chat had no row until then,
 * so Robert could not see that it was in the queue (2026-10-04). Nexus
 * GET /api/dispatch-insight/live-work now projects what is running, queued
 * (in Praxis's order), under review, or waiting on that work; these pure
 * helpers merge that projection with the calendar events so both surfaces
 * agree, with one row per task.
 *
 * Rules the merge enforces:
 *   - A task present as a calendar event AND as live work is ONE row: the
 *     event keeps its place and gets a badge; no second row is added.
 *   - Only real clocks place a row in time: running rows sit at startedAt,
 *     review/finished rows at the implementation's finish. Queued and
 *     waiting rows carry no time and never get one invented.
 *   - Finished rows outside the schedule's window are history and drop out;
 *     queued and waiting rows are timeless and carry across midnight; a run
 *     still active, or a review still running, is shown whatever day it
 *     started or its implementation finished.
 *   - The queue is reported whole, badged entries included, so "up next" and
 *     the empty state are decided from everything the runtime reported, not
 *     from the rows that happened to need their own line.
 *   - "Implementation finished" is never written as "QA passed". Completion
 *     is claimed only where the board itself says completed.
 *   - A failed or unreachable runtime read keeps the last good rows marked
 *     stale, or reads unavailable when there never was one. It is never
 *     rendered as "nothing queued".
 */
import { isTaskDone } from "@praxis/contract";
import type { CalendarEvent } from "@/lib/calendar";
import type { LiveWorkItem, LiveWorkLane, LiveWorkResponse } from "@/lib/nexus/dispatch-insight";

const LANE_RANK: Record<LiveWorkLane, number> = { running: 0, qa: 1, queued: 2, finished: 3, waiting: 4 };

const EXECUTOR_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

export function executorLabel(name: string | null | undefined): string | null {
  if (!name) return null;
  return EXECUTOR_LABELS[name] ?? name;
}

/** A schedule row that comes from runtime truth rather than a calendar event. */
export interface LiveScheduleRow {
  /** Stable DOM/React key, distinct from calendar event ids. */
  key: string;
  taskId: string;
  title: string;
  lane: LiveWorkLane;
  item: LiveWorkItem;
  /** The real clock the row sits at (started / finished). Null for queued and waiting rows. */
  whenIso: string | null;
}

/** Live state attached to a calendar event that is the same task. */
export interface LiveBadge {
  lane: LiveWorkLane;
  label: string;
  item: LiveWorkItem;
}

export interface MergedLiveWork {
  /** Calendar events that are also live work, keyed by event id. */
  badges: Map<string, LiveBadge>;
  /** Rows with a real time, sorted ascending: running, qa, finished (inside the window). */
  timed: LiveScheduleRow[];
  /** Rows with no time: queued in Praxis's order, then waiting. */
  untimed: LiveScheduleRow[];
  /**
   * The whole CLI queue in Praxis's order, whether an entry has its own row
   * or is badged on a calendar event. `queue[0]` is what starts next.
   */
  queue: LiveWorkItem[];
  queuedCount: number;
  runningCount: number;
  /**
   * Live items this merge shows at all, as a row or as a badge. Zero is the
   * only honest basis for "nothing running or queued".
   */
  workCount: number;
}

export const EMPTY_MERGE: MergedLiveWork = {
  badges: new Map(),
  timed: [],
  untimed: [],
  queue: [],
  queuedCount: 0,
  runningCount: 0,
  workCount: 0,
};

function toTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function normalizeStatus(status: string | null | undefined): string {
  return String(status ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Completion as the shared contract defines it (legacy spellings included). */
export function boardSaysDone(status: string | null | undefined): boolean {
  return isTaskDone(status ?? "");
}

/** The real clock a live item sits at, or null when it has none. */
export function liveItemClock(item: LiveWorkItem): string | null {
  switch (item.lane) {
    case "running":
      return item.startedAt ?? null;
    case "qa":
    case "finished":
      return item.finishedAt ?? item.startedAt ?? null;
    default:
      return null;
  }
}

/**
 * Merge the live-work projection with the calendar events already on the
 * schedule. `window` is the schedule's span in epoch ms (local midnight to
 * the end of the fetched range); finished rows outside it are history.
 */
export function mergeLiveWork(
  events: CalendarEvent[],
  live: LiveWorkResponse | null | undefined,
  window: { start: number; end: number },
): MergedLiveWork {
  if (!live || !Array.isArray(live.items) || live.items.length === 0) return EMPTY_MERGE;

  const eventsByTask = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    if (!event.task_id) continue;
    const list = eventsByTask.get(event.task_id) ?? [];
    list.push(event);
    eventsByTask.set(event.task_id, list);
  }

  // One item per task: the server already guarantees this, but a merged
  // response from two reads must not double a row either.
  const byTask = new Map<string, LiveWorkItem>();
  for (const item of live.items) {
    if (!item || typeof item.taskId !== "string" || !item.lane || !(item.lane in LANE_RANK)) continue;
    const prev = byTask.get(item.taskId);
    if (!prev || LANE_RANK[item.lane] < LANE_RANK[prev.lane]) byTask.set(item.taskId, item);
  }

  const badges = new Map<string, LiveBadge>();
  const timed: LiveScheduleRow[] = [];
  const untimed: LiveScheduleRow[] = [];
  const queue: LiveWorkItem[] = [];
  let queuedCount = 0;
  let runningCount = 0;
  let badgedTasks = 0;

  for (const item of byTask.values()) {
    if (item.lane === "queued") {
      queuedCount += 1;
      queue.push(item);
    }
    if (item.lane === "running") runningCount += 1;

    const sameTask = eventsByTask.get(item.taskId);
    if (sameTask && sameTask.length > 0) {
      // Dedupe: the calendar row IS this task. A completed event needs no
      // "finished" badge; every other live state adds information.
      let badged = false;
      for (const event of sameTask) {
        if (item.lane === "finished" && event.status === "completed") continue;
        badges.set(event.id, { lane: item.lane, label: liveItemLabel(item), item });
        badged = true;
      }
      if (badged) badgedTasks += 1;
      continue;
    }

    const row: LiveScheduleRow = {
      key: `live:${item.taskId}`,
      taskId: item.taskId,
      title: item.title || item.taskId,
      lane: item.lane,
      item,
      whenIso: liveItemClock(item),
    };

    if (item.lane === "queued" || item.lane === "waiting") {
      untimed.push(row);
      continue;
    }
    const at = toTime(row.whenIso);
    if (item.lane === "running") {
      // Live now, whatever day it started; a run without a start clock is
      // still live and listed with the untimed rows rather than invented.
      if (at === null) untimed.push({ ...row, whenIso: null });
      else timed.push(row);
      continue;
    }
    if (item.lane === "qa") {
      // The reviewer is running now: live work whatever day the
      // implementation finished, exactly like an active run.
      if (at === null) untimed.push({ ...row, whenIso: null });
      else timed.push(row);
      continue;
    }
    // finished: history unless the implementation finished inside the window.
    if (at === null || at < window.start || at >= window.end) continue;
    timed.push(row);
  }

  timed.sort((a, b) => (toTime(a.whenIso) ?? 0) - (toTime(b.whenIso) ?? 0));
  untimed.sort((a, b) => {
    const rank = LANE_RANK[a.lane] - LANE_RANK[b.lane];
    if (rank !== 0) return rank;
    return (a.item.position ?? 0) - (b.item.position ?? 0);
  });
  queue.sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));

  return { badges, timed, untimed, queue, queuedCount, runningCount, workCount: timed.length + untimed.length + badgedTasks };
}

function timeOfDay(iso: string | null | undefined): string | null {
  const t = toTime(iso);
  if (t === null) return null;
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Short lane word for the dependency list and badges. */
export function laneWord(dep: { lane: LiveWorkLane | null; position?: number | null }): string {
  switch (dep.lane) {
    case "running":
      return "running";
    case "qa":
      return "in QA";
    case "queued":
      return dep.position != null ? `queued #${dep.position}` : "queued";
    case "finished":
      return "finished";
    case "waiting":
      return "waiting";
    default:
      return "on the board";
  }
}

/**
 * One-line truthful state for a live item. Names the lane and what is known
 * (executor, phase, position, waiting-since, dependencies) and nothing more:
 * no planned time for queued work, no "passed" for a finished implementation.
 */
export function liveItemLabel(item: LiveWorkItem): string {
  switch (item.lane) {
    case "running": {
      const parts = ["running"];
      const exec = executorLabel(item.executor);
      if (exec) parts.push(exec);
      if (item.phase) parts.push(item.phase);
      return parts.join(" · ");
    }
    case "qa": {
      const exec = executorLabel(item.qa?.executor);
      return `implementation finished · QA running${exec ? ` (${exec})` : ""}`;
    }
    case "queued": {
      const pos = item.position != null
        ? `queued #${item.position}${item.queueLength != null ? ` of ${item.queueLength}` : ""}`
        : "queued";
      const since = timeOfDay(item.enqueuedAt);
      const parts = [pos];
      if (since) parts.push(`waiting since ${since}`);
      if (item.correction) parts.push("correction round");
      return parts.join(" · ");
    }
    case "finished": {
      if (boardSaysDone(item.boardStatus)) return "completed on the board";
      if (normalizeStatus(item.outcome) === "failed") return "run failed";
      if (item.qaDeferred) return "implementation finished · QA waiting for a slot";
      const status = normalizeStatus(item.boardStatus);
      if (status === "in_progress" || status === "review" || status === "ready_for_review" || status === "dispatched") {
        return "implementation finished · QA pending";
      }
      const parts = ["implementation finished"];
      if (status) parts.push(status.replace(/_/g, " "));
      if (item.statusMessage) parts.push(item.statusMessage);
      return parts.join(" · ");
    }
    case "waiting": {
      const deps = item.waitingOn ?? [];
      const named = deps.map((d) => `“${d.title}” (${laneWord(d)})`).join(", ");
      const parts = [named ? `waiting on ${named}` : "waiting on linked work"];
      if (item.autoStart) parts.push("starts automatically when it completes");
      return parts.join(" · ");
    }
    default:
      return String(item.lane);
  }
}

// ── Read state: live, stale, unavailable ─────────────────────────────────

export interface LiveWorkReadState {
  /** The last projection that carried a runtime read (praxis.reachable). */
  response: LiveWorkResponse | null;
  /** When that projection was produced. */
  lastGoodAt: string | null;
  /** Why the LATEST read did not carry runtime truth, or null when it did. */
  error: string | null;
  /** False until the first read settles. */
  loaded: boolean;
}

export const INITIAL_LIVE_WORK_READ: LiveWorkReadState = {
  response: null,
  lastGoodAt: null,
  error: null,
  loaded: false,
};

export type LiveWorkReadResult =
  | { ok: true; response: LiveWorkResponse }
  | { ok: false; error: string };

/**
 * Fold one read into the state. A 200 whose runtime read failed
 * (praxis.reachable=false) is NOT a good read: the last good rows are kept
 * and the panel reads stale. The board alone cannot say what is queued.
 */
export function applyLiveWorkRead(prev: LiveWorkReadState, result: LiveWorkReadResult): LiveWorkReadState {
  if (result.ok && result.response.praxis?.reachable) {
    return { response: result.response, lastGoodAt: result.response.at, error: null, loaded: true };
  }
  const error = result.ok
    ? result.response.praxis?.error || "Praxis unreachable"
    : result.error || "runtime read failed";
  return { response: prev.response, lastGoodAt: prev.lastGoodAt, error, loaded: true };
}

export type LiveWorkAvailability =
  | { state: "loading" }
  | { state: "live"; at: string | null }
  | { state: "stale"; at: string | null; detail: string }
  | { state: "unavailable"; detail: string };

export function liveWorkAvailability(read: LiveWorkReadState): LiveWorkAvailability {
  if (!read.loaded) return { state: "loading" };
  if (read.error === null) return { state: "live", at: read.lastGoodAt };
  if (read.response) return { state: "stale", at: read.lastGoodAt, detail: read.error };
  return { state: "unavailable", detail: read.error };
}

/** The header/footer sentence for a non-live runtime read. */
export function liveWorkAvailabilityText(availability: LiveWorkAvailability): string | null {
  switch (availability.state) {
    case "stale": {
      const at = timeOfDay(availability.at);
      return `Runtime queue stale · last read ${at ?? "unknown"} · ${availability.detail}`;
    }
    case "unavailable":
      return `Runtime queue unavailable · ${availability.detail} · queued and running work cannot be shown`;
    default:
      return null;
  }
}
