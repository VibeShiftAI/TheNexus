/**
 * Today's Schedule shows chat-dispatched work from runtime truth.
 *
 * Mounts the real ScheduleTimeline against stubbed /api/calendar and
 * /api/dispatch-insight/live-work responses shaped like the live snapshot of
 * 2026-10-04 21:33 (the visibility task holding the slot, two tasks queued
 * behind it, a linked successor, and no calendar event for any of them) and
 * asserts what Robert sees: queued and running rows with their order, titles
 * that link to the task, waiting rows naming their dependency, one row per
 * task when the calendar also carries it, lane changes on refetch, and an
 * explicit stale / unavailable state when the runtime read fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

import { ScheduleTimeline } from "../schedule-timeline.tsx";

const HOUR = 3600_000;
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();

const RUNNING = {
    taskId: "dade9c64-a289-4665-9d49-0f53a74dc13c", title: "Show chat-dispatched work and its queue in Today’s Schedule",
    lane: "running", executor: "claude-code", phase: "testing", startedAt: ago(5 * 60_000), boardStatus: "in_progress",
};
const QUEUED_1 = {
    taskId: "a2553798-fbf1-4202-8eb4-c6f2947eac60", title: "Enable executor-recorded document approvals",
    lane: "queued", executor: "claude-code", enqueuedAt: ago(2 * HOUR), position: 1, queueLength: 2, correction: true,
    boardStatus: "todo", statusMessage: "QA failed — corrections required",
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
const DONE_TODAY = {
    taskId: "b07f64ad-9be5-48f0-a1d6-70dd8b3cdfb5", title: "Open the latest document revision",
    lane: "finished", startedAt: ago(3 * HOUR), finishedAt: ago(2.5 * HOUR), outcome: "completed", boardStatus: "completed",
};

function calendarEvent(partial) {
    return {
        id: "evt", title: "event", start_time: ago(HOUR), end_time: null, description: null, result: null,
        status: "scheduled", event_type: "praxis_task", project_id: null, task_id: null,
        model_assignment: null, created_at: null, updated_at: null, ...partial,
    };
}

function liveResponse(items) {
    return { at: new Date().toISOString(), praxis: { reachable: true, error: null }, items };
}

/**
 * Install a fetch that answers the two endpoints the panel reads. `plan`
 * holds the current answers and can be swapped between refetches.
 */
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
            const live = plan.live;
            if (live instanceof Error) throw live;
            if (typeof live === "number") return new Response("<!DOCTYPE html><title>Cannot GET</title>", { status: live, headers: { "Content-Type": "text/html" } });
            return new Response(JSON.stringify(live), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    return { calls, restore() { globalThis.fetch = realFetch; } };
}

// Drain the fetch -> state-update chain. setImmediate (not setTimeout) so the
// same helper works while a test has setTimeout under mock timers.
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
        root.render(createElement(ScheduleTimeline));
    });
    await settle();
    return {
        container,
        calls: fetchStub.calls,
        get text() {
            return container.textContent;
        },
        row(taskId) {
            return container.querySelector(`[data-live-row][data-task-id="${taskId}"]`);
        },
        rows() {
            return [...container.querySelectorAll("[data-live-row]")].map((el) => [el.getAttribute("data-live-row"), el.getAttribute("data-task-id")]);
        },
        cleanup() {
            act(() => root.unmount());
            container.remove();
            fetchStub.restore();
        },
    };
}

test("no day plan + a queue: running and queued work appear at once, in Praxis's order, each linking to its task", async () => {
    const view = await mount({ calendar: [], live: liveResponse([RUNNING, QUEUED_1, QUEUED_2, WAITING]) });
    try {
        assert.doesNotMatch(view.text, /No events scheduled for today/);
        assert.deepEqual(view.rows(), [
            ["running", RUNNING.taskId],
            ["queued", QUEUED_1.taskId],
            ["queued", QUEUED_2.taskId],
            ["waiting", WAITING.taskId],
        ]);
        // Titles link to the task screen.
        for (const item of [RUNNING, QUEUED_1, QUEUED_2, WAITING]) {
            const link = view.row(item.taskId).querySelector(`a[href="/task/${item.taskId}"]`);
            assert.ok(link, `${item.lane} row links to /task/${item.taskId}`);
            assert.equal(link.textContent, item.title);
        }
        // Truthful order and state, no invented clock for queued work.
        const q1 = view.row(QUEUED_1.taskId).textContent;
        const q2 = view.row(QUEUED_2.taskId).textContent;
        assert.match(q1, /queued #1 of 2/);
        assert.match(q1, /correction round/);
        assert.match(q2, /queued #2 of 2/);
        assert.doesNotMatch(q2, /correction round/);
        assert.match(view.row(QUEUED_1.taskId).querySelector("[data-live-clock]").textContent, /^#1$/);
        assert.match(view.row(RUNNING.taskId).textContent, /running · Claude Code · testing/);
        // The waiting successor names its dependency and that dependency's queue position.
        const waiting = view.row(WAITING.taskId).textContent;
        assert.match(waiting, /waiting on “Honor Robert-originated task contract changes” \(queued #2\)/);
        assert.match(waiting, /starts automatically/);
        // A successor Praxis starts itself hangs directly under the row it waits on.
        assert.equal(view.row(WAITING.taskId).getAttribute("data-chained-after"), `live:${QUEUED_2.taskId}`);
        assert.equal(view.container.querySelector("[data-live-followups]"), null, "a chained successor is not a loose follow-up");
        // Header: the queue is counted; the done counter still counts calendar items only.
        assert.match(view.container.querySelector("[data-live-queued-count]").textContent, /^2 queued$/);
        assert.match(view.text, /0\/0 done/);
        assert.equal(view.container.querySelector("[data-live-availability]"), null, "a good read shows no stale/unavailable note");
        assert.ok(view.calls.every((c) => c.method === "GET"), "display never writes");
    } finally {
        view.cleanup();
    }
});

test("mixed schedule + queue: a task on the calendar and in the queue is one row with a badge; a completed calendar row is not doubled", async () => {
    const slot = calendarEvent({ id: "slot-contract", title: "Slot: contract fix", task_id: QUEUED_2.taskId, start_time: new Date(now + HOUR).toISOString() });
    const adHoc = calendarEvent({ id: "adhoc-latest", title: "[Ad-hoc] Open the latest document revision", task_id: DONE_TODAY.taskId, status: "completed", start_time: DONE_TODAY.finishedAt, updated_at: DONE_TODAY.finishedAt });
    const view = await mount({ calendar: [slot, adHoc], live: liveResponse([RUNNING, QUEUED_1, QUEUED_2, DONE_TODAY]) });
    try {
        assert.equal(view.row(QUEUED_2.taskId), null, "the queued task already on the calendar gets no second row");
        const badge = view.container.querySelector(`#sched-slot-contract [data-live-badge="queued"]`);
        assert.ok(badge, "the calendar row carries the live badge");
        assert.match(badge.textContent, /queued #2 of 2/);
        assert.equal(view.row(DONE_TODAY.taskId), null, "a completed [Ad-hoc] row is not duplicated by a finished row");
        assert.equal(view.container.querySelector(`#sched-adhoc-latest [data-live-badge]`), null);
        assert.deepEqual(view.rows(), [["running", RUNNING.taskId], ["queued", QUEUED_1.taskId]]);
        assert.match(view.text, /1\/2 done/);
    } finally {
        view.cleanup();
    }
});

test("runtime read unavailable: the calendar still renders and the panel says the queue cannot be shown — never 'nothing queued'", async () => {
    const llm = calendarEvent({ id: "llm", title: "Local LLM Nightly Synthesis", event_type: "local_llm:synthesis", start_time: ago(3 * HOUR) });
    const view = await mount({ calendar: [llm], live: 404 });
    try {
        assert.match(view.text, /Local LLM Nightly Synthesis/);
        const note = view.container.querySelector('[data-live-availability="unavailable"]');
        assert.ok(note, "an explicit unavailable note");
        assert.match(note.textContent, /Runtime queue unavailable/);
        assert.match(note.textContent, /queued and running work cannot be shown/);
        assert.deepEqual(view.rows(), []);
    } finally {
        view.cleanup();
    }
});

test("no plan and no runtime read: the empty state is explicit about the missing queue", async () => {
    const view = await mount({ calendar: [], live: new Error("fetch failed") });
    try {
        assert.match(view.text, /No events scheduled for today/);
        assert.ok(view.container.querySelector('[data-live-availability="unavailable"]'));
    } finally {
        view.cleanup();
    }
});

test("refetch transitions: a queued task becomes the running one, and a later failed read keeps the rows marked stale", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const plan = { calendar: [], live: liveResponse([RUNNING, QUEUED_1, QUEUED_2, WAITING]) };
    const view = await mount(plan);
    try {
        assert.equal(view.row(QUEUED_1.taskId).getAttribute("data-live-row"), "queued");

        // Slot freed: the queue head is now the active run; its successor's dependency reads running.
        plan.live = liveResponse([
            { ...QUEUED_1, lane: "running", startedAt: new Date().toISOString(), phase: "executing", position: undefined, queueLength: undefined },
            { ...QUEUED_2, position: 1, queueLength: 1 },
            { ...WAITING, waitingOn: [{ taskId: QUEUED_2.taskId, title: QUEUED_2.title, lane: "queued", position: 1 }] },
        ]);
        await act(async () => {
            t.mock.timers.tick(60_000); // the live subscription's fallback poll
        });
        await settle();
        assert.deepEqual(view.rows(), [
            ["running", QUEUED_1.taskId],
            ["queued", QUEUED_2.taskId],
            ["waiting", WAITING.taskId],
        ]);
        assert.match(view.row(QUEUED_2.taskId).textContent, /queued #1 of 1/);
        assert.match(view.row(WAITING.taskId).textContent, /\(queued #1\)/);
        assert.match(view.container.querySelector("[data-live-queued-count]").textContent, /^1 queued$/);

        // Praxis goes away behind a healthy Nexus: last rows kept, marked stale.
        plan.live = { at: new Date().toISOString(), praxis: { reachable: false, error: "Praxis dispatch-state HTTP 502" }, items: [] };
        await act(async () => {
            t.mock.timers.tick(60_000);
        });
        await settle();
        const stale = view.container.querySelector('[data-live-availability="stale"]');
        assert.ok(stale, "a stale note after a failed runtime read");
        assert.match(stale.textContent, /Runtime queue stale · last read/);
        assert.match(stale.textContent, /Praxis dispatch-state HTTP 502/);
        assert.deepEqual(view.rows().map(([lane]) => lane), ["running", "queued", "waiting"], "the last good rows stay visible");
    } finally {
        view.cleanup();
        t.mock.timers.reset();
    }
});

test("queue head on the calendar: 'up next' still names the head, and the badged slot's title links to the task", async () => {
    const slot = calendarEvent({ id: "slot-head", title: "Slot: approvals", task_id: QUEUED_1.taskId, start_time: new Date(now + HOUR).toISOString() });
    const view = await mount({ calendar: [slot], live: liveResponse([RUNNING, QUEUED_1, QUEUED_2]) });
    try {
        assert.equal(view.row(QUEUED_1.taskId), null, "the head is represented by its slot, not a second row");
        const upNext = view.container.querySelector("[data-live-up-next]");
        assert.ok(upNext, "an 'up next' footer");
        assert.match(upNext.textContent, /up next: Enable executor-recorded document approvals · queued #1/);
        assert.doesNotMatch(upNext.textContent, /Honor Robert-originated/);
        const link = view.container.querySelector(`#sched-slot-head a[href="/task/${QUEUED_1.taskId}"]`);
        assert.ok(link, "the badged slot's title links to the task");
        assert.equal(link.textContent, "Slot: approvals");
        assert.ok(view.container.querySelector(`#sched-slot-head [data-live-badge="queued"]`));
    } finally {
        view.cleanup();
    }
});


test('renders optional improvements beside the completed parent with reason and task detail link', async () => {
 const item={taskId:DONE_TODAY.taskId,title:'QA improvements — Completed parent',lane:'waiting',boardStatus:'completed',improvement:{id:'r1',status:'needs_attention',reason:'Independent review needs repair.',updatedAt:ago(60000)}};
 const view=await mount({calendar:[calendarEvent({task_id:item.taskId,title:'Completed parent',status:'completed'})],live:liveResponse([DONE_TODAY,item])});
 try {
  const row=view.row(item.taskId);
  assert.ok(row); assert.match(row.textContent,/QA improvements.*needs attention/);
  assert.match(row.textContent,/Independent review needs repair/);
  assert.ok(row.querySelector(`a[href="/task/${item.taskId}#qa-improvements"]`));
  assert.doesNotMatch(row.textContent,/Queue to start now|Start automatically/);
  assert.match(row.querySelector('[data-live-clock]').title,/Improvement status updated/);
 } finally {view.cleanup();}
});

for (const spill of [false, true]) {
 test(`follow-ups sit in their own section after the whole timeline${spill ? ' even when the plan spills past midnight' : ''}, never between its rows`, async () => {
  const at = (day, hour, minute = 0) => { const d = new Date(now); d.setHours(hour, minute, 0, 0); d.setDate(d.getDate() + day); return d.toISOString(); };
  const improvement = {taskId:'parent',title:'QA improvements — parent',lane:'waiting',boardStatus:'completed',improvement:{id:'review',status:'deferred',reason:'Approved work runs first.',updatedAt:ago(60000)}};
  // The plan's last task finished early this morning; work is running now;
  // system jobs and unrelated work follow later. On 2026-10-17 this exact
  // shape put seven follow-up rows between the morning and the running task.
  const final = calendarEvent({id:'last-work',task_id:'final',title:'[Slot 6] Final planned task',status:'completed',start_time:at(spill ? 1 : 0, spill ? 0 : 4,20)});
  const system = calendarEvent({id:'system-after',title:'Knowledge summaries',event_type:'local_llm:knowledge',start_time:at(1,3)});
  const tomorrow = calendarEvent({id:'tomorrow-work',task_id:'tomorrow',title:'Tomorrow follow-up',start_time:at(1,10)});
  const view = await mount({calendar:[final,system,tomorrow],live:liveResponse([RUNNING,WAITING,improvement])});
  try {
   const ordered = [...view.container.querySelectorAll('[id^="sched-"], [data-live-followups-header]')].map(el => el.id || 'followups');
   assert.equal(ordered.at(-1), 'followups', 'the follow-ups header comes after every timeline row, running work included');
   assert.ok(ordered.indexOf(`sched-live:${RUNNING.taskId}`) < ordered.indexOf('followups'), 'the running task is not behind the follow-ups');
   // The scrolling list holds only timed and queued work; waiting rows live in the section.
   const list = view.container.querySelector('[data-live-row="running"]').closest('.overflow-y-auto');
   assert.ok(list, 'the running row sits in the scroll list');
   assert.equal(list.querySelectorAll('[data-live-row="waiting"]').length, 0, 'no follow-up row inside the timeline list');
   const section = view.container.querySelector('[data-live-followups]');
   assert.equal(section.querySelectorAll('[data-live-row="waiting"]').length, 2, 'both follow-ups are in the section');
   assert.match(section.querySelector('[data-live-followups-count]').textContent, /1 prepared · 1 QA suggestion/);
   assert.match(view.row(WAITING.taskId).textContent, /starts automatically/);
   assert.ok(view.row(WAITING.taskId).querySelector(`a[href="/task/${WAITING.taskId}"]`), 'the follow-up title links to its task');
   assert.ok(view.calls.every(call => call.method === 'GET'), 'display placement never writes a timed dispatch');
  } finally {view.cleanup();}
 });
}

test('a prepared follow-up can be added to the calendar after the last planned task; a saved automatic start hides that button', async () => {
 const prepared = {taskId:'canva',title:'Canva export',taskVersion:7,lane:'waiting',boardStatus:'planning',autoStart:false,waitingOn:[]};
 const plan = {calendar:[calendarEvent({id:'last-work',task_id:'final',title:'[Slot 6] Final planned task'})],live:liveResponse([WAITING,prepared])};
 const realFetch = globalThis.fetch;
 const posts = [];
 const view = await mount(plan);
 const inner = globalThis.fetch;
 globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/api/calendar/follow-ups')) {
   posts.push({method:init.method, body:JSON.parse(init.body)});
   plan.calendar = [...plan.calendar, calendarEvent({id:'followup-1',task_id:'canva',title:'Follow-up: Canva export',start_time:ago(-2*HOUR)})];
   plan.live = liveResponse([WAITING]);
   return new Response(JSON.stringify({event:{id:'followup-1',task_id:'canva',title:'Follow-up: Canva export',start_time:ago(-2*HOUR),status:'scheduled'},after:{id:'last-work',title:'[Slot 6] Final planned task'}}),{status:201});
  }
  return inner(url, init);
 };
 try {
  assert.equal(view.row(WAITING.taskId).querySelector('[data-add-to-schedule]'), null, 'a follow-up with automatic start saved is not offered a second start');
  const button = [...view.row('canva').querySelectorAll('button')].find(b => /Add to calendar after today’s last task/.test(b.textContent));
  assert.ok(button, 'the prepared follow-up offers the calendar slot');
  await act(async () => button.click()); await settle();
  assert.deepEqual(posts, [{method:'POST', body:{taskId:'canva'}}], 'one POST naming the task, nothing else');
  assert.equal(view.row('canva'), null, 'after the refetch the task has a slot and leaves the follow-ups');
  assert.ok(view.container.querySelector('#sched-followup-1'), 'the new calendar event is on the timeline');
 } finally { globalThis.fetch = realFetch; view.cleanup(); }
});

test('a successor with automatic start hangs under its predecessor’s calendar slot; without automatic start it stays a loose follow-up', async () => {
 const slot = calendarEvent({id:'slot-contract',title:'Slot: contract fix',task_id:QUEUED_2.taskId,start_time:new Date(now + HOUR).toISOString()});
 const prepared = {...WAITING, taskId:'prepared-successor', title:'Prepared successor', autoStart:false};
 const view = await mount({calendar:[slot],live:liveResponse([RUNNING,QUEUED_1,QUEUED_2,WAITING,prepared])});
 try {
  const chainedRow = view.row(WAITING.taskId);
  assert.equal(chainedRow.getAttribute('data-chained-after'), 'slot-contract');
  const slotRow = view.container.querySelector('#sched-slot-contract');
  assert.ok(slotRow.compareDocumentPosition(chainedRow) & Node.DOCUMENT_POSITION_FOLLOWING, 'the successor comes right after its predecessor');
  assert.equal(slotRow.nextElementSibling.getAttribute('data-chained-successors'), 'slot-contract');
  assert.match(chainedRow.textContent, /then/);
  assert.doesNotMatch(chainedRow.textContent, /Add to calendar/, 'a chained successor already has its start');
  assert.doesNotMatch(chainedRow.textContent, /Automatic start is set|Review sequence/, 'a successor link needs no label under its predecessor');
  assert.equal(chainedRow.querySelector('button'), null, 'nothing to cancel on a legacy successor link');
  const looseRow = view.row('prepared-successor');
  assert.ok(looseRow.closest('[data-live-followups]'), 'the manual-start successor stays in the follow-ups section');
  assert.match(view.container.querySelector('[data-live-followups-count]').textContent, /^1 prepared$/);
 } finally {view.cleanup();}
});
