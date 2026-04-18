import test from "node:test";
import assert from "node:assert/strict";

import {
  calendarEventsUrl,
  emptyCalendarEventForm,
  parseCalendarEventStatus,
  toDatetimeLocalValue,
} from "../calendar";

test("calendarEventsUrl uses the Next.js relative API proxy", () => {
  const url = calendarEventsUrl("2026-04-18T00:00:00.000Z", "2026-04-18T23:59:59.000Z");

  assert.equal(
    url,
    "/api/calendar?start=2026-04-18T00%3A00%3A00.000Z&end=2026-04-18T23%3A59%3A59.000Z",
  );
});

test("emptyCalendarEventForm starts as a scheduled blank event", () => {
  assert.deepEqual(emptyCalendarEventForm(), {
    title: "",
    start_time: "",
    end_time: "",
    description: "",
    result: "",
    status: "scheduled",
  });
});

test("toDatetimeLocalValue formats a Date for datetime-local inputs", () => {
  const value = toDatetimeLocalValue(new Date(2026, 3, 18, 9, 5, 30));

  assert.equal(value, "2026-04-18T09:05");
});

test("parseCalendarEventStatus keeps known statuses and falls back to scheduled", () => {
  assert.equal(parseCalendarEventStatus("completed"), "completed");
  assert.equal(parseCalendarEventStatus("not-a-status"), "scheduled");
});
