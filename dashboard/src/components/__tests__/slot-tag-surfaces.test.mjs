/**
 * One task, one tag. Mounts the real schedule timeline, approval card and slate
 * strip for the same task and asserts each shows the same `S<number>`, that a
 * finished chat task is one row carrying it, and that titles stored before day
 * numbering change only in how they read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { HitlCard } from "../hitl-card.tsx";
import { ScheduleTimeline } from "../schedule-timeline.tsx";
import { SlateLifecycleStrip } from "../slate-lifecycle-strip.tsx";

const HOUR = 3600_000;
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();

const TASK = "c1b2a3d4-0000-4000-8000-000000000007";
const TITLE = "Ship the day numbering";

const calendarEvent = (partial) => ({
    id: "evt", title: "event", start_time: new Date(now + HOUR).toISOString(), end_time: null, description: null, result: null,
    status: "scheduled", event_type: "praxis_task", project_id: null, task_id: null,
    model_assignment: null, created_at: null, updated_at: null, ...partial,
});
const liveResponse = (items) => ({ at: new Date().toISOString(), praxis: { reachable: true, error: null }, items });
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function settle() {
    for (let round = 0; round < 3; round += 1) {
        await act(async () => {
            await new Promise((resolve) => setImmediate(resolve));
        });
    }
}

async function mount(element, answers = {}) {
    const realFetch = globalThis.fetch;
    const methods = [];
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        methods.push(init?.method ?? "GET");
        if (u.includes("/api/calendar")) return json(answers.calendar ?? []);
        if (u.includes("/api/dispatch-insight/live-work")) return json(answers.live ?? liveResponse([]));
        if (u.includes("/api/slate/lifecycle")) return json(answers.lifecycle);
        throw new Error(`unexpected fetch ${u}`);
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(element);
    });
    await settle();
    return {
        container,
        methods,
        row: (taskId) => container.querySelector(`[data-live-row][data-task-id="${taskId}"]`),
        cleanup() {
            act(() => root.unmount());
            container.remove();
            globalThis.fetch = realFetch;
        },
    };
}

test("the timeline, the approval card and the slate strip show the same tag for the same task", async () => {
    const timeline = await mount(createElement(ScheduleTimeline), {
        calendar: [calendarEvent({ id: "planned", title: `S7 · ${TITLE}`, task_id: TASK })],
    });
    let timelineTag;
    try {
        const row = timeline.container.querySelector("#sched-planned");
        const link = row.querySelector(`a[href="/task/${TASK}"]`);
        assert.equal(link.textContent, `S7 · ${TITLE}`);
        timelineTag = link.textContent.split(" · ")[0];
    } finally {
        timeline.cleanup();
    }

    const request = {
        id: "day-card", reason: "explicit_request", question: "Approve the day?", requestedAt: new Date().toISOString(),
        options: ["approve", "reject"],
        metadata: {
            kind: "day-schedule", date: "2026-11-23", nightlySummary: "The day ahead.",
            slots: [{
                slotNumber: 7, nexusTaskId: TASK, title: TITLE, workspace: "/project", executor: "codex",
                estimatedMinutes: 30, startTime: new Date(now + HOUR).toISOString(),
            }],
        },
    };
    const card = await mount(createElement(HitlCard, { request, resolving: false, onResolve: async () => {} }));
    let cardTag;
    try {
        const row = [...card.container.querySelectorAll("tbody tr")].find((tr) => tr.textContent.includes(TITLE));
        cardTag = row.querySelector("td").textContent;
    } finally {
        card.cleanup();
    }

    const lifecycle = {
        at: new Date().toISOString(), available: true, date: "2026-11-23", stale: false, carriedOver: false,
        stages: [{ stage: "drafted", reached: true, at: ago(HOUR), detail: "1 slot planned", counts: {} }],
        stall: null,
        slots: [{ slotNumber: 7, taskId: TASK, title: TITLE, status: "pending" }],
    };
    const strip = await mount(createElement(SlateLifecycleStrip), { lifecycle });
    let stripTag;
    try {
        const toggle = [...strip.container.querySelectorAll("button")].find((b) => /slots/.test(b.textContent));
        await act(async () => toggle.click());
        const row = [...strip.container.querySelectorAll("li")].find((li) => li.textContent.includes(TITLE));
        stripTag = row.querySelector("span").textContent;
    } finally {
        strip.cleanup();
    }

    assert.deepEqual([timelineTag, cardTag, stripTag], ["S7", "S7", "S7"]);
});

test("running work and the head of the queue are named by their tags", async () => {
    const running = {
        taskId: "c1b2a3d4-0000-4000-8000-000000000008", title: "Chat work", lane: "running", executor: "claude-code",
        phase: "testing", startedAt: ago(5 * 60_000), boardStatus: "in_progress", slotNumber: 8,
    };
    const queued = {
        taskId: "c1b2a3d4-0000-4000-8000-000000000009", title: "Queued work", lane: "queued", executor: "codex",
        enqueuedAt: ago(60_000), position: 1, queueLength: 1, correction: false, boardStatus: "todo", slotNumber: 9,
    };
    const view = await mount(createElement(ScheduleTimeline), { live: liveResponse([running, queued]) });
    try {
        assert.equal(view.row(running.taskId).querySelector(`a[href="/task/${running.taskId}"]`).textContent, "S8 · Chat work");
        assert.equal(view.row(queued.taskId).querySelector(`a[href="/task/${queued.taskId}"]`).textContent, "S9 · Queued work");
        assert.match(view.container.querySelector("[data-live-up-next]").textContent, /S9 · Queued work/);
    } finally {
        view.cleanup();
    }
});

test("a completed chat-dispatched task is one row carrying its tag", async () => {
    const finishedAt = ago(HOUR);
    const finished = {
        taskId: TASK, title: "Chat work", lane: "finished", startedAt: ago(2 * HOUR), finishedAt,
        outcome: "completed", boardStatus: "completed", slotNumber: 8,
    };
    const view = await mount(createElement(ScheduleTimeline), {
        calendar: [calendarEvent({ id: "done", title: "S8 · Chat work", task_id: TASK, status: "completed", start_time: finishedAt, updated_at: finishedAt })],
        live: liveResponse([finished]),
    });
    try {
        assert.equal(view.row(TASK), null, "the finished live item folds into the calendar row");
        assert.ok(view.container.querySelector("#sched-done").textContent.includes("S8 · Chat work"));
        assert.equal(view.container.textContent.split("Chat work").length - 1, 1, "the task appears once");
        assert.ok(!view.container.textContent.includes("[Ad-hoc]"));
    } finally {
        view.cleanup();
    }
});

test("titles stored before day numbering read the new way and nothing is written back", async () => {
    const view = await mount(createElement(ScheduleTimeline), {
        calendar: [
            calendarEvent({ id: "old-plan", title: "[Slot 3] Old plan work", task_id: "old-1", status: "completed", start_time: ago(3 * HOUR) }),
            calendarEvent({ id: "old-chat", title: "[Ad-hoc] Old chat work", task_id: "old-2", status: "completed", start_time: ago(2 * HOUR) }),
        ],
    });
    try {
        const text = view.container.textContent;
        assert.match(text, /S3 · Old plan work/);
        assert.match(text, /Old chat work/);
        assert.doesNotMatch(text, /\[Ad-hoc\]|\[Slot/);
        assert.ok(view.methods.every((method) => method === "GET"), "display never writes");
    } finally {
        view.cleanup();
    }
});
