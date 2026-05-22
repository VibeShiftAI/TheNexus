export type CalendarEventStatus = "scheduled" | "in_progress" | "completed" | "skipped";

export interface CalendarEvent {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  description: string | null;
  result: string | null;
  status: CalendarEventStatus;
  event_type: string | null;
  project_id: string | null;
  task_id: string | null;
  model_assignment: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CalendarEventTone {
  block: string;
  title: string;
}

export interface CalendarEventForm {
  title: string;
  start_time: string;
  end_time: string;
  description: string;
  result: string;
  status: CalendarEventStatus;
  model_assignment: string;
}

const CALENDAR_EVENT_STATUSES = new Set<string>([
  "scheduled",
  "in_progress",
  "completed",
  "skipped",
]);

export function calendarEventsUrl(start: string, end: string): string {
  return `/api/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
}

export function parseCalendarEventStatus(value: string): CalendarEventStatus {
  return CALENDAR_EVENT_STATUSES.has(value) ? (value as CalendarEventStatus) : "scheduled";
}

export function emptyCalendarEventForm(): CalendarEventForm {
  return {
    title: "",
    start_time: "",
    end_time: "",
    description: "",
    result: "",
    status: "scheduled",
    model_assignment: "",
  };
}

export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function calendarEventTone(event: Pick<CalendarEvent, "event_type" | "status">): CalendarEventTone {
  if (event.event_type?.startsWith("local_llm:")) {
    const source = event.event_type.split(":")[1] || "adhoc";
    const tones: Record<string, CalendarEventTone> = {
      knowledge: { block: "bg-cyan-500/20 border-cyan-500/50 shadow-cyan-500/10", title: "text-cyan-300" },
      journal: { block: "bg-violet-500/20 border-violet-500/50 shadow-violet-500/10", title: "text-violet-300" },
      synthesis: { block: "bg-fuchsia-500/20 border-fuchsia-500/50 shadow-fuchsia-500/10", title: "text-fuchsia-300" },
      lars: { block: "bg-emerald-500/20 border-emerald-500/50 shadow-emerald-500/10", title: "text-emerald-300" },
      stocks: { block: "bg-amber-500/20 border-amber-500/50 shadow-amber-500/10", title: "text-amber-300" },
      trading: { block: "bg-orange-500/20 border-orange-500/50 shadow-orange-500/10", title: "text-orange-300" },
      youtube: { block: "bg-rose-500/20 border-rose-500/50 shadow-rose-500/10", title: "text-rose-300" },
      adhoc: { block: "bg-blue-500/20 border-blue-500/50 shadow-blue-500/10", title: "text-blue-300" },
    };
    return tones[source] || tones.adhoc;
  }

  if (event.status === "in_progress") return { block: "bg-amber-500/20 border-amber-500/50 shadow-amber-500/10", title: "text-amber-300" };
  if (event.status === "completed") return { block: "bg-emerald-500/20 border-emerald-500/50 shadow-emerald-500/10", title: "text-emerald-300" };
  return { block: "bg-cyan-500/20 border-cyan-500/50 shadow-cyan-500/10", title: "text-cyan-300" };
}
