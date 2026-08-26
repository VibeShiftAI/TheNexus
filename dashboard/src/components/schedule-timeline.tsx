"use client"

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { calendarEventsUrl, calendarEventTone, type CalendarEvent, type CalendarEventStatus } from "@/lib/calendar";
import { useStreamRefetch } from "@/hooks/use-stream-refetch";
import { HudPanel } from "@/components/bridge/hud";
import { CalendarDays, ChevronDown, ChevronUp, ScrollText, ArrowRight, ArrowUpRight, Clock } from "lucide-react";

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
 * actively misleading when the item is tomorrow's.
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
 * DayTrack — the whole day as one strip: hour ticks, the elapsed portion lit,
 * a glowing NOW cursor, and one dot per scheduled item (click warps the list
 * to that item).
 */
function DayTrack({
  events,
  nowTs,
  spanStart,
  spanEnd,
  onJump,
}: {
  events: CalendarEvent[];
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
        {events.map((e) => (
          <button
            key={e.id}
            onClick={() => onJump(e.id)}
            className={`absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform hover:scale-150 ${trackDot(e.status)}`}
            style={{ left: `${pctOfSpan(new Date(effectiveTimeIso(e)).getTime(), spanStart, spanEnd)}%` }}
            title={`${formatWhen(effectiveTimeIso(e), spanStart)} · ${e.title}${ranOffSchedule(e) ? ` (planned ${formatWhen(e.start_time, spanStart)})` : ""}`}
            aria-label={`Jump to ${e.title}`}
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

export function ScheduleTimeline() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const nowMarkerRef = useRef<HTMLDivElement>(null);
  const didAutoScrollRef = useRef(false);

  const fetchTodayEvents = useCallback(async () => {
    try {
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
      const res = await fetch(calendarEventsUrl(start, end));
      if (res.ok) {
        const data = await res.json();
        const sorted = (data || []).sort((a: CalendarEvent, b: CalendarEvent) =>
          new Date(effectiveTimeIso(a)).getTime() - new Date(effectiveTimeIso(b)).getTime()
        );
        setEvents(sorted);
      }
    } catch (e) {
      console.error("Failed to fetch schedule events:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTodayEvents();
    // Event-driven via the stream below; slow poll only corrects drift.
    const interval = setInterval(fetchTodayEvents, 60_000);
    return () => clearInterval(interval);
  }, [fetchTodayEvents]);

  // Live refresh when the day plan or task state changes.
  useStreamRefetch(["schedule.updated", "task.completed", "task.started"], fetchTodayEvents);

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

  // First load: center the list on the NOW divider so the operator lands on
  // the live part of the day, not 2 AM.
  useEffect(() => {
    if (loading || didAutoScrollRef.current || events.length === 0) return;
    didAutoScrollRef.current = true;
    scrollListTo(nowMarkerRef.current);
  }, [loading, events, scrollListTo]);

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

  const doneCount = events.filter((e) => e.status === "completed").length;

  // Today, and the tail the plan pushed past midnight. Splitting on the day
  // boundary (rather than filtering it away) is what lets the operator scroll
  // into the rest of the slate instead of it silently not existing.
  const spanStart = startOfDay(nowTs);
  const nextMidnight = endOfDay(nowTs);
  const startedToday = (e: CalendarEvent) => new Date(effectiveTimeIso(e)).getTime() < nextMidnight;
  const todayEvents = events.filter(startedToday);
  const spillEvents = events.filter((e) => !startedToday(e));
  const lastTs = events.length
    ? Math.max(...events.map((e) => new Date(effectiveTimeIso(e)).getTime()))
    : spanStart;
  const spanEnd = Math.max(nextMidnight, endOfDay(lastTs));

  const nowIndex = todayEvents.findIndex((e) => new Date(effectiveTimeIso(e)).getTime() > nowTs);
  const nowAt = nowIndex === -1 ? todayEvents.length : nowIndex;
  const nextUp = events.find((e) => e.status === "scheduled" && new Date(e.start_time).getTime() > nowTs);

  const nowDivider = (
    <div key="now-divider" ref={nowMarkerRef} className="relative flex items-center gap-2 py-0.5 pl-5">
      <span className="absolute left-0 h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.9)] motion-safe:animate-pulse" />
      <span className="text-[9px] font-semibold uppercase tracking-widest text-cyan-300">
        now · {new Date(nowTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-cyan-500/50 to-transparent" />
    </div>
  );

  const renderEvent = (event: CalendarEvent) => {
    const tone = calendarEventTone(event);
    const isExpanded = expandedEventId === event.id;
    const shownTime = effectiveTimeIso(event);
    const isPast = new Date(shownTime).getTime() <= nowTs;

    return (
      <div
        key={event.id}
        id={`sched-${event.id}`}
        className={`relative pl-5 ${event.status === "skipped" ? "opacity-50" : isPast && event.status === "completed" ? "opacity-80" : ""}`}
      >
        <span className={`absolute left-[1px] top-[7px] h-2 w-2 rounded-full ${nodeClasses(event.status)}`} />
        <button
          onClick={() => toggleExpand(event.id)}
          aria-expanded={isExpanded}
          className="flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-slate-800/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-purple-500/60"
        >
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
          <span className={`min-w-0 flex-1 truncate text-xs font-semibold ${tone.title}`} title={event.title}>
            {event.title}
          </span>
          {isExpanded ? (
            <ChevronUp size={13} className="shrink-0 text-slate-500" />
          ) : (
            <ChevronDown size={13} className="shrink-0 text-slate-600" />
          )}
        </button>

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

  return (
    <HudPanel
      icon={<CalendarDays size={16} />}
      title="TODAY'S SCHEDULE"
      accent="purple"
      headerRight={
        <>
          <span className="text-[10px] tabular-nums text-slate-500" title={`${doneCount} of ${events.length} items completed`}>
            {doneCount}/{events.length} done
          </span>
          {spillEvents.length > 0 && (
            <span
              className="text-[10px] tabular-nums text-purple-300/90"
              title={`${spillEvents.length} of this plan's items are scheduled after midnight — scroll the list to reach them`}
            >
              +{spillEvents.length} after midnight
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
      ) : events.length === 0 ? (
        <div className="rounded border border-dashed border-slate-800 px-2 py-6 text-center text-xs text-slate-600">
          No events scheduled for today.
        </div>
      ) : (
        <>
          <DayTrack events={events} nowTs={nowTs} spanStart={spanStart} spanEnd={spanEnd} onJump={jumpToEvent} />

          <div ref={listRef} className="custom-scrollbar relative max-h-[300px] space-y-1 overflow-y-auto pr-1">
            {/* Timeline rail behind the status nodes */}
            <span className="pointer-events-none absolute bottom-1 left-[4px] top-1 w-px bg-slate-800/70" />
            {todayEvents.slice(0, nowAt).map(renderEvent)}
            {nowDivider}
            {todayEvents.slice(nowAt).map(renderEvent)}
            {spillEvents.length > 0 && (
              <>
                <div className="relative flex items-center gap-2 py-1 pl-5">
                  <span className="absolute left-0 h-2 w-2 rounded-full border border-purple-400/70 bg-slate-950" />
                  <span className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-widest text-purple-300">
                    {dayLabel(new Date(effectiveTimeIso(spillEvents[0])).getTime())} · past midnight
                  </span>
                  <span className="h-px flex-1 bg-gradient-to-r from-purple-500/50 to-transparent" />
                </div>
                {spillEvents.map(renderEvent)}
              </>
            )}
          </div>

          {nextUp && (
            <div className="mt-2 truncate border-t border-slate-800/60 pt-1.5 text-[10px] text-slate-500">
              up next: <span className="text-purple-300">{nextUp.title}</span> · {formatWhen(nextUp.start_time, spanStart)}
            </div>
          )}
        </>
      )}
    </HudPanel>
  );
}
