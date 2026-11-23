// The real terminal against a controllable chat stream: steps appear live and
// in order, fold into one expandable line, stay out of the conversation, and
// an in-flight turn is picked up again after a dropped stream or a reload.
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { mountTerminal, findComposerInput, typeCharacter, act, cortexTestStore } from "./helpers.mjs";
import { chatTurnSteps } from "../src/lib/chat-turn-steps.ts";
import { useChatTurnSteps } from "../src/hooks/use-chat-turn-steps.ts";
import { setParams } from "./stubs/next-navigation.mjs";
import ChatTurnPage from "../src/app/chat/turns/[id]/page.tsx";

const RETIRED = "Chat is taking longer than expected";
const flush = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(setImmediate); }); };
const step = (seq, status, text, extra = {}) => ({ type: "step", turn_id: "x", id: `s${seq}`, seq, kind: "tool", text, status, started_ms: seq * 100, elapsed_ms: seq * 150, ...extra });
const live = (container) => container.querySelector('[data-turn-steps="live"]');
const fold = (container) => container.querySelector('[data-turn-steps="folded"]');
const unconfirmed = (container) => container.querySelector("[data-turn-unconfirmed]");
const rows =(root) => [...root.querySelectorAll("[data-step-status]")].map((row) => [row.textContent.replace(/(running|done|failed|did not finish)$/, ""), row.dataset.stepStatus]);

/** A chat POST answered with a stream the test writes to; other reads go to `routes`. */
function installChat(t, routes = () => null) {
    const original = globalThis.fetch;
    const state = { controller: null, body: null, reads: [] };
    globalThis.fetch = async (url, init = {}) => {
        const href = String(url);
        if (href.startsWith("/api/ai/chat?")) {
            state.body = JSON.parse(init.body);
            const stream = new ReadableStream({ start(controller) { state.controller = controller; } });
            return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
        }
        if (href.includes("/api/ai/chat/turns/")) state.reads.push(href);
        return routes(href) ?? Response.json({});
    };
    t.after(() => { globalThis.fetch = original; });
    state.write = async (event) => {
        await act(async () => { state.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); });
        await flush();
    };
    state.close = async () => { await act(async () => { state.controller.close(); }); await flush(); };
    state.fail = async () => { await act(async () => { state.controller.error(new TypeError("network error")); }); await flush(); };
    return state;
}

async function send(container, text = "Check the repo") {
    const input = findComposerInput(container);
    for (const character of text) typeCharacter(input, character);
    await act(async () => { container.querySelector('button[aria-label="Send message"]').click(); });
    await flush();
}

/** The step hook alone, for paths a composer send cannot reach in jsdom (voice and attachments). */
function mountStepsHook(t) {
    const hook = { api: null };
    function Probe() {
        hook.api = useChatTurnSteps({ messages: [], conversationId: "c", isLoadingHistory: false });
        return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(Probe)));
    t.after(() => { act(() => root.unmount()); host.remove(); });
    return hook;
}

function begin(t, messages = []) {
    chatTurnSteps.resetForTests();
    const terminal = mountTerminal(messages);
    t.after(() => { terminal.unmount(); chatTurnSteps.resetForTests(); });
    return terminal;
}

test("each step appears in order while the turn runs, with elapsed time and no empty reply bubble", async (t) => {
    const chat = installChat(t);
    const { container } = begin(t);
    await send(container);
    assert.ok(live(container), "working indicator shows before the first step");
    assert.match(live(container).querySelector("[data-turn-elapsed]").textContent, /s$/);
    assert.equal(rows(live(container)).length, 0);

    await chat.write({ type: "status", state: "running", message: "The chat session is working.", elapsed_ms: 400 });
    assert.equal(live(container).querySelector('[role="status"]').textContent, "The chat session is working.");

    await chat.write(step(1, "running", "Run git status"));
    assert.deepEqual(rows(live(container)), [["Run git status", "running"]]);
    await chat.write(step(1, "done", "Run git status"));
    await chat.write(step(2, "running", "Read src/app.ts"));
    await chat.write(step(3, "running", "Search the repo"));
    assert.deepEqual(rows(live(container)), [["Run git status", "done"], ["Read src/app.ts", "running"], ["Search the repo", "running"]]);
    assert.equal(cortexTestStore.messages.filter((m) => m.role === "assistant").length, 0, "no empty assistant row sits above the steps");

    await chat.write({ type: "delta", delta: "Here is" });
    assert.equal(cortexTestStore.messages.filter((m) => m.role === "assistant").length, 1);
    assert.equal(rows(live(container)).length, 3, "the steps stay under the reply while it streams");
    await chat.write({ type: "final", response: "Here is the answer.", assistantMessageId: "reply-1", duration_ms: 72_000, step_count: 3 });
    await chat.close();
});

test("the final reply folds the steps into one line that expands, and they never become messages", async (t) => {
    const chat = installChat(t);
    const { container } = begin(t);
    await send(container);
    await chat.write(step(1, "done", "Run git status"));
    await chat.write(step(2, "done", "Read src/app.ts"));
    await chat.write({ type: "delta", delta: "Answer" });
    await chat.write({ type: "final", response: "Answer", assistantMessageId: "reply-2", duration_ms: 72_000, step_count: 2 });
    await chat.close();

    assert.equal(live(container), null, "the live panel is gone");
    const line = fold(container);
    const button = line.querySelector("button");
    assert.equal(button.textContent, "Worked for 1m 12s · 2 steps");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(rows(line).length, 0, "collapsed by default");

    await act(async () => { button.click(); });
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.deepEqual(rows(line), [["Run git status", "done"], ["Read src/app.ts", "done"]]);
    await act(async () => { button.click(); });
    assert.equal(rows(line).length, 0);

    const replyRow = container.querySelector('[data-message-row="assistant"]');
    assert.equal(line.nextElementSibling, replyRow, "the line sits directly above the reply");
    const saved = JSON.stringify(cortexTestStore.messages);
    assert.equal(saved.includes("Run git status"), false, "step text is in no message");
    assert.equal(saved.includes("duration_ms"), false, "timing is in no message");
});

test("a real degraded state is shown, and a long healthy turn shows no timer warning", async (t) => {
    const chat = installChat(t);
    const { container } = begin(t);
    await send(container);
    await chat.write({ type: "status", state: "running", message: "The chat session is working.", elapsed_ms: 60_000 });
    await chat.write(step(1, "running", "Run the test suite", { elapsed_ms: 90_000 }));
    assert.equal(live(container).querySelector('[role="alert"]'), null, "time alone raises no warning");
    assert.equal(container.textContent.includes(RETIRED), false);

    await chat.write({ type: "status", state: "degraded", message: "This chat turn ran into a problem. No final result is confirmed yet.", elapsed_ms: 91_000 });
    assert.match(live(container).querySelector('[role="alert"]').textContent, /ran into a problem/);
    await chat.write({ type: "final", response: "Outcome unconfirmed.", state: "uncertain", error: "outcome_uncertain", assistantMessageId: "reply-3", duration_ms: 95_000, step_count: 1 });
    await chat.close();
    assert.match(fold(container).textContent, /1 step/);
    assert.equal(container.textContent.includes(RETIRED), false);
});

test("a step that never reported back folds as unfinished", async (t) => {
    const chat = installChat(t);
    const { container } = begin(t);
    await send(container);
    await chat.write(step(1, "running", "Run a slow command"));
    await chat.write(step(1, "unfinished", "Run a slow command"));
    await chat.write({ type: "final", response: "Stopped.", assistantMessageId: "reply-4", duration_ms: 5_000, step_count: 1 });
    await chat.close();
    assert.equal(fold(container).querySelector("button").textContent, "Worked for 5s · 1 step · 1 did not finish");
});

test("after a reload a finished turn shows its reply and no steps", async (t) => {
    const chat = installChat(t);
    const first = begin(t);
    await send(first.container);
    await chat.write(step(1, "done", "Run git status"));
    await chat.write({ type: "final", response: "Answer", assistantMessageId: "reply-5", duration_ms: 2_000, step_count: 1 });
    await chat.close();
    const savedRows = cortexTestStore.messages.map((m) => ({ ...m }));
    first.unmount();

    // A reload starts with empty page memory and the saved conversation.
    chatTurnSteps.resetForTests();
    const second = mountTerminal(savedRows);
    t.after(() => second.unmount());
    await flush();
    assert.equal(second.container.querySelector("[data-turn-steps]"), null);
    assert.equal(second.container.textContent.includes("Run git status"), false);
    assert.equal(second.container.querySelectorAll("[data-message-row]").length, 2);
    assert.equal(chat.reads.length, 0, "a conversation ending in a reply reads no turn status");
});

test("a dropped stream keeps following the turn and folds it when its saved reply lands", async (t) => {
    // setTimeout only: a mocked clearInterval cannot stop jsdom's real animation
    // frame interval from the test before, and that interval holds the run open.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let receipt = { state: "in_progress", steps: [{ id: "s1", seq: 1, kind: "tool", text: "Run git status", status: "done" }, { id: "s2", seq: 2, kind: "tool", text: "Read src/app.ts", status: "running" }], step_count: 2, elapsed_ms: 4_000, duration_ms: null };
    const chat = installChat(t, (href) => (href.includes("/api/ai/chat/turns/") ? Response.json(receipt) : null));
    const { container } = begin(t);
    // Runs after begin's unmount: the shared socket's linger fires on this clock.
    t.after(() => t.mock.timers.tick(6_000));
    await send(container);
    await chat.write(step(1, "running", "Run git status"));
    await chat.fail();

    assert.equal(chat.reads.length, 1, "reads the turn at once");
    assert.ok(chat.reads[0].endsWith(`/api/ai/chat/turns/${chat.body.clientMessageId}`));
    assert.deepEqual(rows(live(container)), [["Run git status", "done"], ["Read src/app.ts", "running"]]);
    assert.equal(live(container).querySelector('[role="status"]').textContent, "Praxis is still working on this message.");
    assert.ok(container.querySelector("textarea"), "the composer stays available");

    receipt = { ...receipt, state: "completed", steps: [receipt.steps[0], { ...receipt.steps[1], status: "done" }], duration_ms: 9_000, reply: { response: "Answer" } };
    await act(async () => { t.mock.timers.tick(2_500); });
    await flush();
    assert.equal(live(container), null);
    await act(async () => {
        cortexTestStore.update((messages) => [...messages, { id: `${chat.body.clientMessageId}:reply`, role: "assistant", content: "Saved answer", timestamp: new Date() }]);
    });
    assert.equal(fold(container).querySelector("button").textContent, "Worked for 9s · 2 steps");
    assert.equal(cortexTestStore.messages.filter((m) => m.role === "assistant").length, 1, "replay added no second reply");
});

test("a reload during a turn picks the turn up from its status route, without sending anything", async (t) => {
    const turnId = "in-flight-turn-1";
    const receipt = { state: "in_progress", steps: [{ id: "s1", seq: 1, kind: "tool", text: "Run the build", status: "running" }], step_count: 1, elapsed_ms: 30_000, duration_ms: null };
    const chat = installChat(t, (href) => (href.includes(`/turns/${turnId}`) ? Response.json(receipt) : null));
    const { container } = begin(t, [{ id: turnId, role: "user", content: "Build it", timestamp: new Date() }]);
    await flush();
    assert.deepEqual(rows(live(container)), [["Run the build", "running"]]);
    assert.match(live(container).querySelector("[data-turn-elapsed]").textContent, /^30s$|^31s$/);
    assert.equal(chat.body, null, "no POST: reading a turn never runs it again");
});

test("a saved turn that already ended is not shown as running after a reload", async (t) => {
    const turnId = "finished-turn-1";
    const chat = installChat(t, (href) => (href.includes(`/turns/${turnId}`) ? Response.json({ state: "uncertain", steps: [], step_count: 0 }) : null));
    const { container } = begin(t, [{ id: turnId, role: "user", content: "Did this land?", timestamp: new Date() }]);
    await flush();
    assert.equal(chat.reads.length, 1);
    assert.equal(live(container), null);
    assert.equal(fold(container), null);
    assert.match(unconfirmed(container).textContent, /ended without a confirmed reply/, "the unanswered message says how it ended");
    assert.equal(unconfirmed(container).querySelector("a").getAttribute("href"), `/chat/turns/${turnId}`);
});

test("a followed turn that ends uncertain says so until a later message follows it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const turnId = "uncertain-turn-1";
    let receipt = { state: "in_progress", steps: [{ id: "s1", seq: 1, kind: "tool", text: "Run the build", status: "running" }], step_count: 1, elapsed_ms: 3_000, duration_ms: null };
    installChat(t, (href) => (href.includes(`/turns/${turnId}`) ? Response.json(receipt) : null));
    const { container } = begin(t, [{ id: turnId, role: "user", content: "Build it", timestamp: new Date() }]);
    t.after(() => t.mock.timers.tick(6_000));
    await flush();
    assert.deepEqual(rows(live(container)), [["Run the build", "running"]]);
    assert.equal(unconfirmed(container), null, "no notice while it runs");

    receipt = { ...receipt, state: "uncertain", duration_ms: 8_000 };
    await act(async () => { t.mock.timers.tick(2_500); });
    await flush();
    assert.equal(live(container), null);
    assert.match(unconfirmed(container).textContent, /ended without a confirmed reply/);

    await act(async () => {
        cortexTestStore.update((messages) => [...messages, { id: `${turnId}:reply`, role: "assistant", content: "Outcome unconfirmed.", timestamp: new Date() }]);
    });
    assert.equal(unconfirmed(container), null, "the saved reply takes over");
    assert.match(fold(container).textContent, /1 step/);
});

test("a send still on its way survives a status read that finds no turn yet", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ error: "turn_not_found" }, { status: 404 });
    t.after(() => { globalThis.fetch = original; });
    chatTurnSteps.resetForTests();
    const hook = mountStepsHook(t);
    t.after(() => { chatTurnSteps.resetForTests(); });

    chatTurnSteps.begin("slow-send", "c", "Sending your message…");
    act(() => hook.api.followWithoutStream("slow-send"));
    await act(async () => { t.mock.timers.tick(2_500); });
    await flush();
    assert.equal(chatTurnSteps.has("slow-send"), true, "the request is still open, so Praxis may not have the turn yet");

    // The request ended with no reply: now the same answer means there is no such turn.
    act(() => hook.api.release("slow-send"));
    await act(async () => { t.mock.timers.tick(2_500); });
    await flush();
    assert.equal(chatTurnSteps.has("slow-send"), false);
});

test("a reply that lands folds the steps even as the send ends, and a hung read cannot hold the panel open", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = globalThis.fetch;
    // Answers only when aborted, like a status request that never comes back.
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
    t.after(() => { globalThis.fetch = original; });
    chatTurnSteps.resetForTests();
    const hook = mountStepsHook(t);
    t.after(() => { chatTurnSteps.resetForTests(); });

    chatTurnSteps.begin("json-reply", "c", "Working");
    chatTurnSteps.noteStep("json-reply", { id: "s1", seq: 1, kind: "tool", text: "Run git status", status: "done" });
    let settled = false;
    await act(async () => {
        hook.api.foldAfterReply("json-reply", "json-reply:reply").then(() => { settled = true; });
        hook.api.release("json-reply");
        await new Promise(setImmediate);
    });
    assert.equal(chatTurnSteps.has("json-reply"), true, "the turn outlives its send until the read settles");
    assert.equal(settled, false);

    await act(async () => { t.mock.timers.tick(5_000); await new Promise(setImmediate); });
    await flush();
    assert.equal(settled, true);
    assert.equal(chatTurnSteps.has("json-reply"), false);
    assert.equal(chatTurnSteps.getFolded().get("json-reply:reply").stepCount, 1);
});

test("the saved-turn page lists the steps of an in-flight turn and still copes without any", async (t) => {
    const original = globalThis.fetch;
    let receipt = { state: "in_progress", steps: [{ id: "s1", seq: 1, kind: "tool", text: "Run the build", status: "running" }, { bad: true }], step_count: 1 };
    globalThis.fetch = async () => Response.json(receipt);
    t.after(() => { globalThis.fetch = original; });
    setParams({ id: "saved-steps-turn" });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    t.after(() => { act(() => root.unmount()); host.remove(); });
    await act(async () => { root.render(createElement(ChatTurnPage)); await new Promise(setImmediate); });
    assert.deepEqual(rows(host), [["Run the build", "running"]]);
    assert.match(host.textContent, /1 step/);

    receipt = { state: "completed", reply: { response: "Saved answer" } };
    await act(async () => { host.querySelector("button").click(); await new Promise(setImmediate); });
    assert.equal(rows(host).length, 0);
    assert.match(host.textContent, /Saved answer/);
});
