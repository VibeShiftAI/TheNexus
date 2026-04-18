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
  created_at: string | null;
  updated_at: string | null;
}

export interface CalendarEventForm {
  title: string;
  start_time: string;
  end_time: string;
  description: string;
  result: string;
  status: CalendarEventStatus;
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
  };
}

export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
