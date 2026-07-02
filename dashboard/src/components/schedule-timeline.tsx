"use client"

import { useCallback, useEffect, useState } from "react";
import { calendarEventsUrl, calendarEventTone, type CalendarEvent } from "@/lib/calendar";
import { useStreamRefetch } from "@/hooks/use-stream-refetch";
import { Calendar, ChevronDown, ChevronUp, CheckCircle, Play, Circle } from "lucide-react";

export function ScheduleTimeline() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchTodayEvents = useCallback(async () => {
    try {
      const today = new Date();
      const start = new Date(new Date(today).setHours(0, 0, 0, 0)).toISOString();
      const end = new Date(new Date(today).setHours(23, 59, 59, 999)).toISOString();
      const res = await fetch(calendarEventsUrl(start, end));
      if (res.ok) {
        const data = await res.json();
        const sorted = (data || []).sort((a: CalendarEvent, b: CalendarEvent) =>
          new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
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

  const toggleExpand = (id: string) => {
    setExpandedEventId(prev => (prev === id ? null : id));
  };

  const formatTime = (isoString: string) => {
    return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
      <div className="bg-slate-950/60 border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar size={16} className="text-teal-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Today's Schedule</span>
        </div>
        <span className="text-xs text-slate-500 font-medium">{events.length} items</span>
      </div>

      <div className="p-4 max-h-[300px] overflow-y-auto space-y-3">
        {loading ? (
          <div className="text-center text-xs text-slate-500 py-6">Loading schedule...</div>
        ) : events.length === 0 ? (
          <div className="text-center text-xs text-slate-500 py-6">No events scheduled for today.</div>
        ) : (
          events.map((event) => {
            const tone = calendarEventTone(event);
            const isExpanded = expandedEventId === event.id;

            return (
              <div 
                key={event.id}
                className={`border rounded-lg transition-all ${tone.block}`}
              >
                <div 
                  className="p-3 flex items-center justify-between cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/50 rounded-lg"
                  onClick={() => toggleExpand(event.id)}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleExpand(event.id);
                    }
                  }}
                >
                  <div className="flex items-center gap-3">
                    {event.status === "completed" && <CheckCircle size={16} className="text-emerald-400" />}
                    {event.status === "in_progress" && <Play size={16} className="text-amber-400 animate-pulse" />}
                    {event.status === "scheduled" && <Circle size={16} className="text-cyan-400" />}
                    <div>
                      <div className="text-xs text-slate-400 font-medium">
                        {formatTime(event.start_time)}
                        {event.end_time && ` - ${formatTime(event.end_time)}`}
                      </div>
                      <h4 className={`text-sm font-semibold ${tone.title}`}>{event.title}</h4>
                    </div>
                  </div>
                  {isExpanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                </div>

                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 border-t border-slate-800/40 text-xs text-slate-400 space-y-2 bg-slate-950/20">
                    {event.description && (
                      <div>
                        <span className="font-semibold text-slate-300">Description:</span>
                        <p className="mt-0.5">{event.description}</p>
                      </div>
                    )}
                    {event.result && (
                      <div>
                        <span className="font-semibold text-slate-300">Result:</span>
                        <p className="mt-0.5 font-mono text-[10px] bg-slate-950 p-2 rounded border border-slate-800/60 overflow-x-auto whitespace-pre-wrap">{event.result}</p>
                      </div>
                    )}
                    <div className="flex justify-between items-center pt-1 text-[10px] text-slate-500">
                      <span>Status: <span className="font-semibold uppercase">{event.status}</span></span>
                      {event.event_type && <span>Type: {event.event_type}</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
