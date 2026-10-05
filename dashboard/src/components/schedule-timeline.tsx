"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { calendarEventsUrl, calendarEventTone, type CalendarEvent, type CalendarEventStatus } from "@/lib/calendar";
import { getLiveWork, type LiveWorkItem, type LiveWorkLane } from "@/lib/nexus/dispatch-insight";
import {
  applyLiveWorkRead,
  executorLabel,
  INITIAL_LIVE_WORK_READ,
  laneWord,
  liveItemLabel,
  liveWorkAvailability,
  liveWorkAvailabilityText,
  mergeLiveWork,
  type LiveScheduleRow,
  type LiveWorkReadState,
} from "@/lib/schedule-live-work";
import { taskHref } from "@/lib/task-links";
import { useArrivalPulse } from "@/hooks/use-arrival-pulse";
import { useLiveRefetch } from "@/components/live-board-state";
import { HudPanel } from "@/components/bridge/hud";
import { CalendarDays, ChevronDown, ChevronUp, ScrollText, ArrowRight, ArrowUpRight, Clock } from "lucide-react";

const DAY_MS = 24 * 60 * 60 * 1000;

// A scheduled item has logs to drill into once it has actually run (or is
// running). Upcoming items that haven't started yet carry no dispatch history,
// so the detail shows a clean "no logs yet" state instead of an empty viewer.
function eventHasLogs(event: CalendarEvent): boolean {
  return event.status === "in_progress" || event.status === "completed" || Boolean(event.result);
}

function formatTime(isoString: string) {
  return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Where an event actually sits in the day: completed items move to the time
 * they finished and running items to the time they started (updated_at flips
 * on the status change) rather than their planned slot — otherwise early
 * completions read as "future work already done" and an early-started run
 * shows as a future task somehow live. Waiting items stay at their slot.
 */
function effectiveTimeIso(event: CalendarEvent): string {
  const started = event.status === "completed" || event.status === "in_progress";
  if (started && event.updated_at && !Number.isNaN(new Date(event.updated_at).getTime())) {
    return event.updated_at;
  }
  return event.start_time;
}

/** True when an event actually ran meaningfully off its planned slot. */
function ranOffSchedule(event: CalendarEvent): boolean {
  const effective = effectiveTimeIso(event);
  return (
    effective !== event.start_time &&
    Math.abs(new Date(effective).getTime() - new Date(event.start_time).getTime()) > 60_000
  );
}

/** Local midnight on the day containing `ts`. */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight *after* the day containing `ts`. */
function endOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Position (0–100%) of a timestamp across the panel's span. The span is the
 * calendar day in the ordinary case, but a plan whose slots run past midnight
 * stretches it to cover the spill-over day too — otherwise a 1:33 AM slot
 * belonging to *tomorrow* renders at 6% of the track, on top of today's small
 * hours, and reads as work that already came and went.
 */
function pctOfSpan(ts: number, spanStart: number, spanEnd: number) {
  const width = Math.max(spanEnd - spanStart, 1);
  return ((ts - spanStart) / width) * 100;
}

/** "Mon, Aug 25" — labels the divider where one calendar day hands off to the next. */
function dayLabel(ts: number) {
  return new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/**
 * Time, qualified by day once the panel spans more than one. A bare "01:33" is
 * actively misleading when the item is tomorrow's — or yesterday's, for a run
 * still going since before midnight.
 */
function formatWhen(isoString: string, spanStart: number) {
  const ts = new Date(isoString).getTime();
  return startOfDay(ts) === spanStart ? formatTime(isoString) : `${dayLabel(ts)} ${formatTime(isoString)}`;
}

/** Glowing status node on the timeline rail. */
function nodeClasses(status: CalendarEventStatus): string {
  switch (status) {
    case "completed":
      return "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]";
    case "in_progress":
      return "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)] motion-safe:animate-pulse";
    case "skipped":
      return "bg-slate-700";
    default:
      return "border border-cyan-400/70 bg-slate-950";
  }
}

/** Event dot on the day track. */
function trackDot(status: CalendarEventStatus): string {
  switch (status) {
    case "completed":
      return "bg-emerald-400";
    case "in_progress":
      return "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.9)] motion-safe:animate-pulse";
    case "skipped":
      return "bg-slate-600";
    default:
      return "bg-cyan-400/70";
  }
}

/**
 * Rail node for a row that comes from the runtime rather than a day-plan slot.
 * Running pulses amber like an in_progress slot; a reviewer run is violet so
 * "finished, under review" never reads as done; queued and waiting rows are
 * hollow (nothing has run); a finished row is emerald only when the BOARD
 * says completed.
 */
function liveNodeClasses(lane: LiveWorkLane, item: LiveWorkItem, runtimeLive: boolean): string {
  switch (lane) {
    case "running":
      return runtimeLive
        ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)] motion-safe:animate-pulse"
        : "bg-amber-400/40";
    case "qa":
      return "bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.7)]";
    case "queued":
      return "border border-cyan-400/70 bg-slate-950";
    case "waiting":
      return "border border-dashed border-slate-500 bg-slate-950";
    case "finished":
      return liveItemLabel(item) === "completed on the board"
        ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]"
        : "bg-slate-500";
  }
}

function liveTrackDot(lane: LiveWorkLane, item: LiveWorkItem, runtimeLive: boolean): string {
  switch (lane) {
    case "running":
      return runtimeLive ? "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.9)] motion-safe:animate-pulse" : "bg-amber-400/40";
    case "qa":
      return "bg-violet-400";
    case "finished":
      return liveItemLabel(item) === "completed on the board" ? "bg-emerald-400" : "bg-slate-500";
    default:
      return "bg-cyan-400/70";
  }
}

function liveTitleTone(lane: LiveWorkLane): string {
  switch (lane) {
    case "running":
      return "text-amber-300";
    case "qa":
      return "text-violet-300";
    case "finished":
      return "text-slate-300";
    case "waiting":
      return "text-slate-400";
    default:
      return "text-cyan-300";
  }
}

/** One dot on the day track — a calendar event or a timed live row. */
interface TrackMark {
  id: string;
  ts: number;
  title: string;
  dotClass: string;
}

/**
 * DayTrack — the whole day as one strip: hour ticks, the elapsed portion lit,
 * a glowing NOW cursor, and one dot per timed item (click warps the list to
 * that item). Marks before the span (a run still going since yesterday) pin
 * to the left edge rather than vanishing off the track.
 */
function DayTrack({
  marks,
  nowTs,
  spanStart,
  spanEnd,
  onJump,
}: {
  marks: TrackMark[];
  nowTs: number;
  spanStart: number;
  spanEnd: number;
  onJump: (id: string) => void;
}) {
  const nowPct = pctOfSpan(nowTs, spanStart, spanEnd);
  // A tick every 6 hours across the span. Midnight ticks are taller and carry
  // the weekday instead of an hour, so a two-day span reads as two days rather
  // than one 48-hour smear. Stepped with setHours (not fixed ms) so a DST day
  // still lands its ticks on the clock hours it labels.
  const ticks: { ts: number; midnight: boolean }[] = [];
  for (let d = new Date(spanStart); d.getTime() <= spanEnd; d.setHours(d.getHours() + 6)) {
    ticks.push({ ts: d.getTime(), midnight: d.getHours() === 0 });
  }
  return (
    <div className="mb-2.5">
      <div className="relative h-5">
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-slate-800" />
        <span
          className="absolute left-0 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-purple-500/20 to-cyan-500/60"
          style={{ width: `${Math.max(0, Math.min(100, nowPct))}%` }}
        />
        {ticks.map(({ ts, midnight }) => (
          <span
            key={ts}
            className={`absolute top-1/2 w-px -translate-y-1/2 ${midnight ? "h-3.5 bg-slate-600" : "h-1.5 bg-slate-700"}`}
            style={{ left: `${pctOfSpan(ts, spanStart, spanEnd)}%` }}
          />
        ))}
        {marks.map((m) => (
          <button
            key={m.id}
            onClick={() => onJump(m.id)}
            className={`absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform hover:scale-150 ${m.dotClass}`}
            style={{ left: `${Math.max(0, Math.min(100, pctOfSpan(m.ts, spanStart, spanEnd)))}%` }}
            title={m.title}
            aria-label={`Jump to ${m.title}`}
          />
        ))}
        <span
          className="absolute top-0 h-full w-px bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.9)]"
          style={{ left: `${nowPct}%` }}
        />
      </div>
      <div className="flex justify-between text-[8px] tabular-nums text-slate-600">
        {ticks.map(({ ts, midnight }) => (
          <span key={ts} className={midnight ? "text-slate-500" : undefined}>
            {midnight
              ? new Date(ts).toLocaleDateString([], { weekday: "short" })
              : String(new Date(ts).getHours()).padStart(2, "0")}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A timed item on the schedule: a calendar event, or a live row with a real clock. */
type TimedEntry =
  | { kind: "event"; id: string; ts: number; event: CalendarEvent }
  | { kind: "live"; id: string; ts: number; row: LiveScheduleRow };

export function ScheduleTimeline() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastGoodAt, setLastGoodAt] = useState(0);
  const [signalError, setSignalError] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());
  // Runtime truth about chat-dispatched work (lib/schedule-live-work): kept
  // separately from the calendar read so one failing never blanks the other.
  const [liveRead, setLiveRead] = useState<LiveWorkReadState>(INITIAL_LIVE_WORK_READ);
  const listRef = useRef<HTMLDivElement>(null);
  const nowMarkerRef = useRef<HTMLDivElement>(null);
  const didAutoScrollRef = useRef(false);

  const fetchSchedule = useCallback(async () => {
    // The plan is not guaranteed to fit inside the calendar day. When the
    // morning slate is approved late, slots roll past midnight — the
    // 2026-08-24 plan put 7 of its 12 between 1:33 AM and 11:42 AM the
    // following day. Clamping this fetch to 00:00–23:59 dropped those from
    // the panel outright: the day read as "4 items" with nothing to indicate
    // the other 7 existed. Pull the next day too and let the render group by
    // date; on an ordinary day the extra window is simply empty.
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const windowEnd = new Date(dayStart);
    windowEnd.setDate(windowEnd.getDate() + 2);
    const start = dayStart.toISOString();
    const end = new Date(windowEnd.getTime() - 1).toISOString();

    // Calendar events and the runtime's live work are read together. Work
    // Praxis queued from chat has no calendar event until it finishes, so the
    // calendar alone cannot show that it is in the queue (Robert,
    // 2026-10-04); the live-work read is what puts it here.
    const [calendar, live] = await Promise.allSettled([
      fetch(calendarEventsUrl(start, end)).then(async (res) => {
        if (!res.ok) throw new Error(`Calendar API returned ${res.status}`);
        const data = await res.json();
        return (Array.isArray(data) ? data : []) as CalendarEvent[];
      }),
      getLiveWork(),
    ]);

    if (calendar.status === "fulfilled") {
      const sorted = calendar.value.sort(
        (a, b) => new Date(effectiveTimeIso(a)).getTime() - new Date(effectiveTimeIso(b)).getTime(),
      );
      setEvents(sorted);
      const fetchedAt = Date.now();
      setLastGoodAt(fetchedAt); setNowTs(fetchedAt); setSignalError(false);
    } else {
      setSignalError(true);
      console.error("Failed to fetch schedule events:", calendar.reason);
    }

    setLiveRead((prev) =>
      applyLiveWorkRead(
        prev,
        live.status === "fulfilled"
          ? { ok: true, response: live.value }
          : { ok: false, error: live.reason instanceof Error ? live.reason.message : String(live.reason ?? "runtime read failed") },
      ),
    );
    setLoading(false);
  }, []);

  // Live refresh when the day plan, a task, or the dispatch lane changes
  // (task.started / task.completed / executor.progress / schedule.updated all
  // bump one of these), on the shared subscription, with a slow
  // drift-correction poll behind it. Reconnects re-run it through the
  // provider's recovery signal.
  useLiveRefetch(["schedule", "dispatch", "board"], fetchSchedule);

  // Keep the NOW cursor and past/upcoming split current.
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const scrollListTo = useCallback((el: HTMLElement | null) => {
    const list = listRef.current;
    if (!list || !el) return;
    list.scrollTop =
      el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - list.clientHeight / 2 + 20;
  }, []);

  const toggleExpand = (id: string) => {
    setExpandedEventId(prev => (prev === id ? null : id));
  };

  const jumpToEvent = useCallback(
    (id: string) => {
      setExpandedEventId(id);
      scrollListTo(document.getElementById(`sched-${id}`));
    },
    [scrollListTo],
  );

  const scheduleLive = !signalError && lastGoodAt > 0 && nowTs - lastGoodAt >= 0 && nowTs - lastGoodAt < 90_000;
  const doneCount = events.filter((e) => e.status === "completed").length;

  // Today, and the tail the plan pushed past midnight. Splitting on the day
  // boundary (rather than filtering it away) is what lets the operator scroll
  // into the rest of the slate instead of it silently not existing.
  const spanStart = startOfDay(nowTs);
  const nextMidnight = endOfDay(nowTs);

  // Runtime truth folded in: one row per task (a task that is also a calendar
  // event keeps that row and gets a badge), real clocks only, finished work
  // outside this window treated as history.
  const live = useMemo(
    () => mergeLiveWork(events, liveRead.response, { start: spanStart, end: spanStart + 2 * DAY_MS }),
    [events, liveRead.response, spanStart],
  );
  const availability = liveWorkAvailability(liveRead);
  const availabilityText = liveWorkAvailabilityText(availability);
  const runtimeLive = availability.state === "live";
  const waitingCount = live.untimed.filter((r) => r.lane === "waiting").length;

  const transitions = useArrivalPulse(
    [...events.map(e => `${e.id}:${e.status}`), ...live.timed.concat(live.untimed).map((r) => `${r.key}:${r.lane}`)],
    !loading,
  );

  const timed: TimedEntry[] = useMemo(() => {
    const entries: TimedEntry[] = [
      ...events.map((event): TimedEntry => ({ kind: "event", id: event.id, ts: new Date(effectiveTimeIso(event)).getTime(), event })),
      ...live.timed.map((row): TimedEntry => ({ kind: "live", id: row.key, ts: new Date(row.whenIso as string).getTime(), row })),
    ];
    return entries.sort((a, b) => a.ts - b.ts);
  }, [events, live.timed]);

  const todayEntries = timed.filter((entry) => entry.ts < nextMidnight);
  const spillEntries = timed.filter((entry) => entry.ts >= nextMidnight);
  const lastTs = timed.length ? Math.max(...timed.map((entry) => entry.ts)) : spanStart;
  const spanEnd = Math.max(nextMidnight, endOfDay(lastTs));

  const nowIndex = todayEntries.findIndex((entry) => entry.ts > nowTs);
  const nowAt = nowIndex === -1 ? todayEntries.length : nowIndex;
  const nextScheduled = events.find((e) => e.status === "scheduled" && new Date(e.start_time).getTime() > nowTs);
  // The head of the WHOLE queue, badged entries included: a head that also
  // has a day-plan slot is still what starts next (QA round 1, 2026-10-04).
  const queueHead = live.queue[0];

  const marks: TrackMark[] = timed.map((entry) =>
    entry.kind === "event"
      ? {
          id: entry.id,
          ts: entry.ts,
          title: `${formatWhen(effectiveTimeIso(entry.event), spanStart)} · ${entry.event.title}${ranOffSchedule(entry.event) ? ` (planned ${formatWhen(entry.event.start_time, spanStart)})` : ""}`,
          dotClass: !scheduleLive && entry.event.status === "in_progress" ? "bg-amber-400/40" : trackDot(entry.event.status),
        }
      : {
          id: entry.id,
          ts: entry.ts,
          title: `${formatWhen(entry.row.whenIso as string, spanStart)} · ${entry.row.title} · ${liveItemLabel(entry.row.item)}`,
          dotClass: liveTrackDot(entry.row.lane, entry.row.item, runtimeLive),
        },
  );

  const hasRows = timed.length > 0 || live.untimed.length > 0;

  // First load: center the list on the NOW divider so the operator lands on
  // the live part of the day, not 2 AM.
  useEffect(() => {
    if (loading || didAutoScrollRef.current || !hasRows) return;
    didAutoScrollRef.current = true;
    scrollListTo(nowMarkerRef.current);
  }, [loading, hasRows, scrollListTo]);

  const nowDivider = (
    <div key="now-divider" ref={nowMarkerRef} className="relative flex items-center gap-2 py-0.5 pl-5">
      <span className="absolute left-0 h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.9)] motion-safe:animate-pulse" />
      <span className="text-[9px] font-semibold uppercase tracking-widest text-cyan-300">
        now · {new Date(nowTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-cyan-500/50 to-transparent" />
    </div>
  );

  const availabilityNote = availabilityText && (
    <p
      data-live-availability={availability.state}
      className="mb-2 text-[10px] text-amber-300"
      title="Queued and running work comes from the Praxis runtime, not the calendar. Without that read the panel cannot say what is queued."
    >
      {availabilityText}
    </p>
  );

  const renderEvent = (event: CalendarEvent) => {
    const tone = calendarEventTone(event);
    const isExpanded = expandedEventId === event.id;
    const shownTime = effectiveTimeIso(event);
    const isPast = new Date(shownTime).getTime() <= nowTs;
    const badge = live.badges.get(event.id);

    return (
      <div
        key={event.id}
        id={`sched-${event.id}`}
        className={`relative rounded-md pl-5 ${transitions.has(`${event.id}:${event.status}`) ? "module-new" : ""} ${event.status === "skipped" ? "opacity-50" : isPast && event.status === "completed" ? "opacity-80" : ""}`}
      >
        <span className={`absolute left-[1px] top-[7px] h-2 w-2 rounded-full ${!scheduleLive && event.status === "in_progress" ? "bg-amber-400/40" : nodeClasses(event.status)}`} />
        {(() => {
          const rowClass = `relative flex w-full min-w-0 items-center gap-2 overflow-hidden rounded px-1 py-1 text-left transition-colors hover:bg-slate-800/40 ${event.status === "in_progress" ? "bg-amber-400/5 text-amber-200" : ""}`;
          const sheen = scheduleLive && event.status === "in_progress" && <span aria-hidden="true" className="hud-sheen pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-amber-300/15 to-transparent"/>;
          const clock = (
            <span
              className="w-[46px] shrink-0 font-mono text-[10px] tabular-nums text-slate-500"
              title={
                ranOffSchedule(event)
                  ? `${event.status === "completed" ? "completed" : "started"} ${formatTime(shownTime)} · planned ${formatTime(event.start_time)}`
                  : undefined
              }
            >
              {formatTime(shownTime)}
            </span>
          );
          // The same task is live in the runtime (queued / running / under
          // review): say so on THIS row rather than listing it twice.
          const badgeChip = badge && (
            <span
              data-live-badge={badge.lane}
              className={`max-w-[45%] shrink-0 truncate rounded border border-slate-700/70 bg-slate-950/70 px-1 text-[9px] font-semibold ${liveTitleTone(badge.lane)}`}
              title={`${badge.label} · from the Praxis runtime`}
            >
              {badge.label}
            </span>
          );
          const chevron = isExpanded ? (
            <ChevronUp size={13} className="shrink-0 text-slate-500" />
          ) : (
            <ChevronDown size={13} className="shrink-0 text-slate-600" />
          );
          // A task-bound event keeps its task link in the title (the live
          // rows do the same), with the chevron as the expand control. An
          // event without a task stays one click-anywhere button.
          if (event.task_id) {
            return (
              <div className={rowClass}>
                {sheen}
                {clock}
                <Link
                  href={taskHref(event.task_id)}
                  className={`min-w-0 flex-1 truncate text-xs font-semibold hover:underline ${tone.title}`}
                  title={`${event.title} — open the task`}
                >
                  {event.title}
                </Link>
                {badgeChip}
                <button
                  onClick={() => toggleExpand(event.id)}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? "Hide details" : "Show details"}
                  className="shrink-0 rounded transition-colors hover:text-slate-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-purple-500/60"
                >
                  {chevron}
                </button>
              </div>
            );
          }
          return (
            <button
              onClick={() => toggleExpand(event.id)}
              aria-expanded={isExpanded}
              className={`${rowClass} focus:outline-none focus-visible:ring-1 focus-visible:ring-purple-500/60`}
            >
              {sheen}
              {clock}
              <span className={`min-w-0 flex-1 truncate text-xs font-semibold ${tone.title}`} title={event.title}>
                {event.title}
              </span>
              {badgeChip}
              {chevron}
            </button>
          );
        })()}

        {isExpanded && (
          <div className="ml-1 mt-1 space-y-2 rounded-md border border-slate-800/60 bg-slate-950/50 p-2.5 text-xs text-slate-400">
            {event.description && (
              <div>
                <span className="font-semibold text-slate-300">Description:</span>
                <p className="mt-0.5">{event.description}</p>
              </div>
            )}
            {event.result && (
              <div>
                <span className="font-semibold text-slate-300">Result:</span>
                <p className="mt-0.5 overflow-x-auto whitespace-pre-wrap rounded border border-slate-800/60 bg-slate-950 p-2 font-mono text-[10px]">{event.result}</p>
              </div>
            )}
            {badge && (
              <div>
                <span className="font-semibold text-slate-300">Runtime:</span> {badge.label}
              </div>
            )}
            <div className="flex items-center justify-between pt-1 text-[10px] text-slate-500">
              <span>
                Status: <span className="font-semibold uppercase">{event.status}</span>
              </span>
              <span className="flex items-center gap-2">
                {ranOffSchedule(event) && <span>planned {formatTime(event.start_time)}</span>}
                {event.end_time && <span>until {formatTime(event.end_time)}</span>}
                {event.event_type && <span>Type: {event.event_type}</span>}
              </span>
            </div>

            {/* Drill-down: one more click into the run logs (the task's
                dispatch console on /task/[id]) when this item maps to a
                task. Upcoming items with no run yet get a clean
                "no logs" state rather than an empty viewer. */}
            {event.task_id && (
              <div className="border-t border-slate-800/40 pt-2">
                {eventHasLogs(event) ? (
                  <Link
                    href={`/task/${event.task_id}`}
                    className="group flex items-center gap-1.5 text-[11px] font-semibold text-purple-300 transition-colors hover:text-purple-200"
                    title="Open the task detail and its run logs"
                  >
                    <ScrollText size={12} />
                    View run logs &amp; full detail
                    <ArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ) : (
                  <div className="flex flex-col gap-1">
                    <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
                      <Clock size={12} />
                      No logs yet — this run hasn&apos;t started.
                    </span>
                    <Link
                      href={`/task/${event.task_id}`}
                      className="flex items-center gap-1 text-[11px] text-slate-400 transition-colors hover:text-purple-300"
                      title="Open the task detail"
                    >
                      Open task detail
                      <ArrowRight size={11} />
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  /**
   * A row from the runtime: work Praxis is running, has queued, is reviewing,
   * or holds for linked work — none of it a day-plan slot. The clock column
   * shows a real time only when there is one (started / finished); a queued
   * row shows its position and a waiting row "after", never an invented
   * start. The title links straight to the task.
   */
  const renderLiveRow = (row: LiveScheduleRow) => {
    const { item } = row;
    const isExpanded = expandedEventId === row.key;
    const clock = row.whenIso
      ? formatTime(row.whenIso)
      : row.lane === "queued"
        ? `#${item.position ?? "·"}`
        : row.lane === "waiting"
          ? "after"
          : "—";
    const clockTitle = row.whenIso
      ? `${row.lane === "running" ? "started" : "implementation finished"} ${formatWhen(row.whenIso, spanStart)}`
      : row.lane === "queued"
        ? `Queue position ${item.position ?? "?"}${item.queueLength != null ? ` of ${item.queueLength}` : ""} — starts when the CLI slot frees; no planned time`
        : "Starts after the work it waits on — no planned time";

    return (
      <div
        key={row.key}
        id={`sched-${row.key}`}
        data-live-row={row.lane}
        data-task-id={row.taskId}
        className={`relative rounded-md pl-5 ${transitions.has(`${row.key}:${row.lane}`) ? "module-new" : ""} ${row.lane === "waiting" ? "opacity-80" : ""}`}
      >
        <span className={`absolute left-[1px] top-[7px] h-2 w-2 rounded-full ${liveNodeClasses(row.lane, item, runtimeLive)}`} />
        <div
          className={`relative flex w-full min-w-0 items-center gap-2 overflow-hidden rounded px-1 py-1 ${row.lane === "running" ? "bg-amber-400/5" : ""}`}
        >
          {runtimeLive && row.lane === "running" && <span aria-hidden="true" className="hud-sheen pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-amber-300/15 to-transparent"/>}
          <span data-live-clock className="w-[46px] shrink-0 font-mono text-[10px] tabular-nums text-slate-500" title={clockTitle}>
            {clock}
          </span>
          <Link
            href={taskHref(row.taskId)}
            className={`min-w-0 flex-1 truncate text-xs font-semibold hover:underline ${liveTitleTone(row.lane)}`}
            title={`${row.title} — open the task`}
          >
            {row.title}
          </Link>
          <button
            onClick={() => toggleExpand(row.key)}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? "Hide details" : "Show details"}
            className="shrink-0 rounded text-slate-600 transition-colors hover:text-slate-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-purple-500/60"
          >
            {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
        <p data-live-label className="truncate pl-[54px] pr-1 text-[10px] text-slate-500" title={liveItemLabel(item)}>
          {liveItemLabel(item)}
        </p>

        {isExpanded && (
          <div className="ml-1 mt-1 space-y-1.5 rounded-md border border-slate-800/60 bg-slate-950/50 p-2.5 text-xs text-slate-400">
            <div className="text-[10px] text-slate-500">
              From the Praxis runtime — not a day-plan slot. Shown here so queued work is visible; nothing on this panel dispatches or re-orders it.
            </div>
            {item.projectName && (
              <div>
                <span className="font-semibold text-slate-300">Project:</span> {item.projectName}
              </div>
            )}
            {item.boardStatus && (
              <div>
                <span className="font-semibold text-slate-300">Board status:</span> <span className="uppercase">{item.boardStatus}</span>
                {item.statusMessage && <span className="text-slate-500"> · {item.statusMessage}</span>}
              </div>
            )}
            {row.lane === "running" && (
              <div>
                <span className="font-semibold text-slate-300">Run:</span>{" "}
                {item.startedAt ? `started ${formatWhen(item.startedAt, spanStart)}` : "start time not reported"}
                {executorLabel(item.executor) && ` · ${executorLabel(item.executor)}`}
                {item.phase && ` · phase ${item.phase}`}
              </div>
            )}
            {row.lane === "qa" && (
              <div>
                <span className="font-semibold text-slate-300">Review:</span>{" "}
                {item.finishedAt ? `implementation finished ${formatWhen(item.finishedAt, spanStart)}` : "implementation finished"}
                {executorLabel(item.qa?.executor) && ` · reviewer ${executorLabel(item.qa?.executor)}`}
                {item.qa?.startedAt && ` since ${formatWhen(item.qa.startedAt, spanStart)}`}
                {" · verdict not in yet"}
              </div>
            )}
            {row.lane === "queued" && (
              <div>
                <span className="font-semibold text-slate-300">Queue:</span>{" "}
                position {item.position ?? "?"}{item.queueLength != null && ` of ${item.queueLength}`}
                {item.enqueuedAt && ` · waiting since ${formatWhen(item.enqueuedAt, spanStart)}`}
                {executorLabel(item.executor) && ` · ${executorLabel(item.executor)}`}
                {item.correction && " · QA correction round"}
                {" · starts when the CLI slot frees"}
              </div>
            )}
            {row.lane === "finished" && (
              <div>
                <span className="font-semibold text-slate-300">Run:</span>{" "}
                {item.finishedAt ? `finished ${formatWhen(item.finishedAt, spanStart)}` : "finished"}
                {item.outcome && ` · outcome ${item.outcome}`}
                {item.qaDeferred?.reason && ` · review deferred: ${item.qaDeferred.reason}`}
              </div>
            )}
            {row.lane === "waiting" && (
              <div>
                <span className="font-semibold text-slate-300">Waits on:</span>
                <ul className="mt-0.5 space-y-0.5">
                  {(item.waitingOn ?? []).map((dep) => (
                    <li key={dep.taskId} className="flex items-center gap-1.5">
                      <Link href={taskHref(dep.taskId)} className="truncate text-slate-300 hover:text-purple-300" title={dep.title}>
                        {dep.title}
                      </Link>
                      <span className="shrink-0 text-[10px] text-slate-500">{laneWord(dep)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 text-[10px] text-slate-500">
                  {item.autoStart
                    ? "Praxis starts this task itself when its predecessor completes."
                    : "Needs its predecessors complete before it can be dispatched."}
                </div>
              </div>
            )}
            <div className="border-t border-slate-800/40 pt-2">
              <Link
                href={taskHref(row.taskId)}
                className="group flex items-center gap-1.5 text-[11px] font-semibold text-purple-300 transition-colors hover:text-purple-200"
                title="Open the task detail"
              >
                <ScrollText size={12} />
                Open task detail
                <ArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderEntry = (entry: TimedEntry) => (entry.kind === "event" ? renderEvent(entry.event) : renderLiveRow(entry.row));

  return (
    <HudPanel
      icon={<CalendarDays size={16} />}
      title="TODAY'S SCHEDULE"
      activity={(scheduleLive && events.some(e => e.status === "in_progress")) || (runtimeLive && live.runningCount > 0) ? "active" : "idle"}
      accent="purple"
      headerRight={
        <>
          <span className="text-[10px] tabular-nums text-slate-500" title={`${doneCount} of ${events.length} scheduled items completed`}>
            {doneCount}/{events.length} done
          </span>
          {live.queuedCount > 0 && (
            <span
              data-live-queued-count
              className="text-[10px] tabular-nums text-cyan-300/90"
              title={`${live.queuedCount} task${live.queuedCount === 1 ? "" : "s"} queued behind the CLI slot — runtime truth, not day-plan slots`}
            >
              {live.queuedCount} queued
            </span>
          )}
          {spillEntries.length > 0 && (
            <span
              className="text-[10px] tabular-nums text-purple-300/90"
              title={`${spillEntries.length} of this plan's items are scheduled after midnight — scroll the list to reach them`}
            >
              +{spillEntries.length} after midnight
            </span>
          )}
          <Link href="/calendar" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
            calendar <ArrowUpRight size={12} />
          </Link>
        </>
      }
    >
      {loading ? (
        <div className="py-6 text-center text-xs text-slate-500">Loading schedule…</div>
      ) : !hasRows ? (
        <div className="rounded border border-dashed border-slate-800 px-2 py-6 text-center text-xs text-slate-600">
          No events scheduled for today.
          {availabilityNote && <div className="mt-2 text-left">{availabilityNote}</div>}
        </div>
      ) : (
        <>
          {!scheduleLive && !loading && <p className="mb-2 text-[10px] text-amber-300">Schedule signal delayed · last reported state</p>}
          {availabilityNote}
          <DayTrack marks={marks} nowTs={nowTs} spanStart={spanStart} spanEnd={spanEnd} onJump={jumpToEvent} />

          <div ref={listRef} className="custom-scrollbar relative max-h-[300px] space-y-1 overflow-y-auto pr-1">
            {/* Timeline rail behind the status nodes */}
            <span className="pointer-events-none absolute bottom-1 left-[4px] top-1 w-px bg-slate-800/70" />
            {todayEntries.slice(0, nowAt).map(renderEntry)}
            {nowDivider}
            {/* The runtime queue sits right after NOW: it is what runs next,
                in Praxis's own order, and it has no clock of its own. Linked
                work waiting on it follows. */}
            {live.untimed.length > 0 && (
              <>
                <div data-live-queue-header className="relative flex items-center gap-2 py-1 pl-5">
                  <span className="absolute left-0 h-2 w-2 rounded-full border border-cyan-400/70 bg-slate-950" />
                  <span className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-widest text-cyan-300">
                    queue · {live.queuedCount} queued{waitingCount > 0 ? ` · ${waitingCount} linked` : ""}
                  </span>
                  <span className="h-px flex-1 bg-gradient-to-r from-cyan-500/50 to-transparent" />
                </div>
                {live.untimed.map(renderLiveRow)}
              </>
            )}
            {todayEntries.slice(nowAt).map(renderEntry)}
            {spillEntries.length > 0 && (
              <>
                <div className="relative flex items-center gap-2 py-1 pl-5">
                  <span className="absolute left-0 h-2 w-2 rounded-full border border-purple-400/70 bg-slate-950" />
                  <span className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-widest text-purple-300">
                    {dayLabel(spillEntries[0].ts)} · past midnight
                  </span>
                  <span className="h-px flex-1 bg-gradient-to-r from-purple-500/50 to-transparent" />
                </div>
                {spillEntries.map(renderEntry)}
              </>
            )}
          </div>

          {queueHead ? (
            <div data-live-up-next className="mt-2 truncate border-t border-slate-800/60 pt-1.5 text-[10px] text-slate-500">
              up next: <span className="text-cyan-300">{queueHead.title || queueHead.taskId}</span> · queued #{queueHead.position ?? 1}, starts when the slot frees
            </div>
          ) : nextScheduled ? (
            <div className="mt-2 truncate border-t border-slate-800/60 pt-1.5 text-[10px] text-slate-500">
              up next: <span className="text-purple-300">{nextScheduled.title}</span> · {formatWhen(nextScheduled.start_time, spanStart)}
            </div>
          ) : null}
        </>
      )}
    </HudPanel>
  );
}
