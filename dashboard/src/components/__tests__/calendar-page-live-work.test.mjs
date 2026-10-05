/**
 * /calendar shows the same chat-dispatched work as the home panel.
 *
 * Mounts the real CalendarPage against stubbed /api/calendar and
 * /api/dispatch-insight/live-work responses (same shapes as the home-panel
 * test) and asserts the runtime strip: running, queued (in order) and waiting
 * rows linking to their tasks, one row per task when the grid already has the
 * event (badge on the block instead), an explicit unavailable state, and
 * read-only behaviour (every request is a GET).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

import CalendarPage from "../../app/calendar/page.tsx";

const HOUR = 3600_000;
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();

const RUNNING = {
    taskId: "dade9c64-a289-4665-9d49-0f53a74dc13c", title: "Show chat-dispatched work and its queue in Today’s Schedule",
    lane: "running", executor: "claude-code", phase: "testing", startedAt: ago(5 * 60_000), boardStatus: "in_progress",
};
const QUEUED_1 = {
    taskId: "a2553798-fbf1-4202-8eb4-c6f2947eac60", title: "Enable executor-recorded document approvals",
    lane: "queued", executor: "claude-code", enqueuedAt: ago(2 * HOUR), position: 1, queueLength: 2, correction: true, boardStatus: "todo",
};
const QUEUED_2 = {
    taskId: "9021f20d-7275-4ed8-8888-cd10077dedb0", title: "Honor Robert-originated task contract changes",
    lane: "queued", executor: "claude-code", enqueuedAt: ago(6 * 60_000), position: 2, queueLength: 2, correction: false, boardStatus: "todo",
};
const WAITING = {
    taskId: "b7708e44-7459-47db-a1b6-bcd07ab2669d", title: "Carry contract decisions through dispatch",
    lane: "waiting", boardStatus: "idea", autoStart: true,
    waitingOn: [{ taskId: QUEUED_2.taskId, title: QUEUED_2.title, lane: "queued", position: 2 }],
};

function calendarEvent(partial) {
    const start = new Date(now);
    start.setHours(10, 0, 0, 0);
    return {
        id: "evt", title: "event", start_time: start.toISOString(), end_time: null, description: null, result: null,
        status: "scheduled", event_type: "praxis_task", project_id: null, task_id: null,
        model_assignment: null, created_at: null, updated_at: null, ...partial,
    };
}

const liveResponse = (items) => ({ at: new Date().toISOString(), praxis: { reachable: true, error: null }, items });

function installFetch(plan) {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        calls.push({ url: u, method: init?.method ?? "GET" });
        if (u.includes("/api/calendar")) {
            return new Response(JSON.stringify(plan.calendar), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/api/dispatch-insight/live-work")) {
            if (typeof plan.live === "number") return new Response("<!DOCTYPE html>", { status: plan.live, headers: { "Content-Type": "text/html" } });
            return new Response(JSON.stringify(plan.live), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    return { calls, restore() { globalThis.fetch = realFetch; } };
}

async function settle() {
    for (let round = 0; round < 3; round += 1) {
        await act(async () => {
            await new Promise((resolve) => setImmediate(resolve));
        });
    }
}

async function mount(plan) {
    const fetchStub = installFetch(plan);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(createElement(CalendarPage));
    });
    await settle();
    return {
        container,
        calls: fetchStub.calls,
        strip: () => container.querySelector("[data-live-work-strip]"),
        row: (taskId) => container.querySelector(`[data-live-row][data-task-id="${taskId}"]`),
        rows: () => [...container.querySelectorAll("[data-live-row]")].map((el) => [el.getAttribute("data-live-row"), el.getAttribute("data-task-id")]),
        cleanup() {
            act(() => root.unmount());
            container.remove();
            fetchStub.restore();
        },
    };
}

test("calendar page: the runtime strip lists running, queued and waiting work with task links, in queue order", async () => {
    const view = await mount({ calendar: [], live: liveResponse([RUNNING, QUEUED_1, QUEUED_2, WAITING]) });
    try {
        assert.ok(view.strip(), "the strip renders above the grid");
        assert.deepEqual(view.rows(), [
            ["running", RUNNING.taskId],
            ["queued", QUEUED_1.taskId],
            ["queued", QUEUED_2.taskId],
            ["waiting", WAITING.taskId],
        ]);
        for (const item of [RUNNING, QUEUED_1, QUEUED_2, WAITING]) {
            const link = view.row(item.taskId).querySelector(`a[href="/task/${item.taskId}"]`);
            assert.ok(link, `${item.lane} row links to its task`);
            assert.equal(link.textContent, item.title);
        }
        assert.match(view.row(QUEUED_1.taskId).textContent, /queued #1 of 2/);
        assert.match(view.row(QUEUED_1.taskId).querySelector("[data-live-clock]").textContent, /^#1$/);
        assert.match(view.row(WAITING.taskId).textContent, /waiting on “Honor Robert-originated task contract changes” \(queued #2\)/);
        assert.ok(view.row(WAITING.taskId).querySelector(`a[href="/task/${QUEUED_2.taskId}"]`), "the dependency itself links to its task");
        assert.match(view.container.querySelector("[data-live-queued-count]").textContent, /^2 queued$/);
        assert.equal(view.container.querySelector("[data-live-availability]"), null);
        assert.ok(view.calls.every((c) => c.method === "GET"), "display never writes");
    } finally {
        view.cleanup();
    }
});

test("calendar page: a task on the grid and in the queue is badged on its block, not listed twice", async () => {
    const slot = calendarEvent({ id: "slot-contract", title: "Slot: contract fix", task_id: QUEUED_2.taskId });
    const view = await mount({ calendar: [slot], live: liveResponse([RUNNING, QUEUED_1, QUEUED_2]) });
    try {
        assert.equal(view.row(QUEUED_2.taskId), null, "no second row for the queued task that has a calendar block");
        const badge = view.container.querySelector('[data-live-badge="queued"]');
        assert.ok(badge, "the grid block carries the badge");
        assert.match(badge.textContent, /queued #2 of 2/);
        assert.deepEqual(view.rows(), [["running", RUNNING.taskId], ["queued", QUEUED_1.taskId]]);
        assert.match(view.container.textContent, /Slot: contract fix/);
    } finally {
        view.cleanup();
    }
});

test("calendar page: runtime read unavailable keeps the grid and says the queue cannot be shown", async () => {
    const llm = calendarEvent({ id: "llm", title: "Local LLM Nightly Synthesis", event_type: "local_llm:synthesis" });
    const view = await mount({ calendar: [llm], live: 404 });
    try {
        assert.match(view.container.textContent, /Local LLM Nightly Synthesis/);
        const note = view.container.querySelector('[data-live-availability="unavailable"]');
        assert.ok(note, "an explicit unavailable note");
        assert.match(note.textContent, /Runtime queue unavailable/);
        assert.deepEqual(view.rows(), []);
        assert.doesNotMatch(view.container.textContent, /Nothing running or queued/);
    } finally {
        view.cleanup();
    }
});

test("calendar page: a live read with nothing in flight says so, instead of staying silent", async () => {
    const view = await mount({ calendar: [], live: liveResponse([]) });
    try {
        assert.match(view.container.textContent, /Nothing running or queued in the runtime right now/);
        assert.match(view.container.querySelector("[data-live-queued-count]").textContent, /^0 queued$/);
    } finally {
        view.cleanup();
    }
});

test("calendar page: queued work shown only as a badge is still reported as work, and the block title links to the task", async () => {
    const slot = calendarEvent({ id: "slot-head", title: "Slot: approvals", task_id: QUEUED_1.taskId });
    const view = await mount({ calendar: [slot], live: liveResponse([{ ...QUEUED_1, queueLength: 1 }]) });
    try {
        assert.deepEqual(view.rows(), [], "no standalone row: the slot carries the badge");
        assert.match(view.container.querySelector("[data-live-queued-count]").textContent, /^1 queued$/);
        assert.doesNotMatch(view.container.textContent, /Nothing running or queued/);
        assert.ok(view.container.querySelector("[data-live-badged-only]"), "the strip points at the badged slot instead");
        const link = view.container.querySelector(`a[href="/task/${QUEUED_1.taskId}"]`);
        assert.ok(link, "the grid block's title links to the task");
        assert.equal(link.textContent, "Slot: approvals");
        assert.ok(view.container.querySelector('[data-live-badge="queued"]'));

        // The title link opens the task, not the editor: its click must not
        // bubble into the block's edit handler. The rest of the block still
        // opens the editor. (jsdom has no navigation; preventDefault keeps the
        // anchor's default action quiet without touching React's propagation.)
        const click = (el) => act(() => {
            el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
        });
        view.container.addEventListener("click", (e) => e.preventDefault());
        const editorOpen = () => /Edit Schedule Event/.test(view.container.textContent);
        assert.equal(editorOpen(), false, "no editor before any click");
        click(link);
        assert.equal(editorOpen(), false, "clicking the task title leaves the calendar editor closed");
        const block = link.closest(".cursor-pointer");
        assert.ok(block, "the title sits inside the clickable grid block");
        click(block);
        assert.equal(editorOpen(), true, "clicking the block itself opens the editor for that event");
        assert.equal(view.container.querySelector('input[value="Slot: approvals"]') !== null, true, "the editor is for the clicked event");
    } finally {
        view.cleanup();
    }
});
