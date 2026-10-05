// The Ops console through the real provider, driven the way QA round 1 of
// task 60c8716a drove it: dispatch-state requests are held and answered out
// of order, so a request from before an outage can land AFTER the refetch a
// reconnect triggered. The page must keep the recovered rows, and an empty
// list must never read "no runs on record" while current telemetry is
// unavailable.
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import OpsPage from "../../app/ops/page.tsx";
import { LiveBoardStateProvider } from "../live-board-state.tsx";
import { __setConnectionLifecycleForTests, createConnectionLifecycle } from "../../lib/connection-lifecycle.ts";

const T0 = Date.parse("2026-10-03T18:00:00Z");

const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
});
const EMPTY = { executors: { runs: [], sessions: [] } };
const ACTIVE = {
    executors: {
        runs: [
            {
                taskId: "qa-active",
                title: "QA ACTIVE RUN",
                executor: "codex",
                kind: "task",
                phase: "testing",
                status: "active",
                updatedAt: new Date(T0).toISOString(),
            },
        ],
        sessions: [],
    },
};

function harness(t) {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: T0 });
    /** Resolvers for every dispatch-state request, in request order; nothing answers until the test says so. */
    const pending = [];
    globalThis.fetch = (url) => {
        const path = String(url);
        if (path.includes("dispatch-state")) return new Promise((resolve) => pending.push(resolve));
        if (path.includes("/autonomy")) return Promise.resolve(response({ paused: false, flag: null, inFlight: [] }));
        if (path.includes("/council/sessions")) return Promise.resolve(response({ sessions: [] }));
        if (path.includes("/council/benches")) return Promise.resolve(response({ benches: [] }));
        if (path.includes("/local-queue/work")) {
            return Promise.resolve(
                response({
                    lmStudio: { available: false, models: [] },
                    background: { available: false, jobs: [], counts: {}, worker: null },
                }),
            );
        }
        if (path.includes("/board")) return Promise.resolve(response([]));
        return Promise.resolve(response({}));
    };
    let outcome = "ok";
    const lifecycle = createConnectionLifecycle({
        probe: async () => outcome,
        target: window,
        isVisible: () => true,
        storage: null,
    });
    __setConnectionLifecycleForTests(lifecycle);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const h = {
        lifecycle,
        pending,
        container,
        setProbe: (o) => {
            outcome = o;
        },
        hasActiveRun: () => container.textContent.includes("QA ACTIVE RUN"),
        tone: () => container.querySelector("[data-ops-tone]")?.getAttribute("data-ops-tone") ?? null,
        empty: () => {
            const el = container.querySelector("[data-ops-runs-empty]");
            return el ? { kind: el.getAttribute("data-ops-runs-empty"), text: el.textContent.trim() } : null;
        },
        async mount() {
            await act(async () => root.render(createElement(LiveBoardStateProvider, null, createElement(OpsPage))));
        },
        async resolve(index, body, status) {
            await act(async () => pending[index](response(body, status)));
        },
        async step(ms) {
            await act(async () => {
                t.mock.timers.tick(ms);
                await new Promise((r) => setImmediate(r));
            });
        },
        /** A network return: the lifecycle probes (500ms coalesce), passes, invalidates every domain (400ms refetch debounce). */
        async reconnect() {
            await act(async () => lifecycle.signal("online"));
            await h.step(500);
            await h.step(400);
        },
        cleanup() {
            act(() => root.unmount());
            // Drain the shared socket's / stream store's 5s linger under this
            // test's clock before resetting it (see test harness notes).
            t.mock.timers.tick(6_000);
            container.remove();
            lifecycle.dispose();
            __setConnectionLifecycleForTests(null);
            t.mock.timers.reset();
        },
    };
    return h;
}

test("an obsolete dispatch-state answer that lands after the reconnect refetch cannot overwrite the recovered rows (the missing-active-run sequence)", async (t) => {
    const h = harness(t);
    try {
        await h.mount();
        // Two requests at mount: the shared dispatch-state hook (0) and the page's own load (1).
        assert.equal(h.pending.length, 2);
        await h.resolve(0, EMPTY);

        // The network comes back before the page's first request has answered.
        await h.reconnect();
        assert.equal(h.pending.length, 4, "the recovery refetches: one per consumer");

        // The newer requests answer first, with the run that started during the outage.
        for (let i = 2; i < h.pending.length; i += 1) await h.resolve(i, ACTIVE);
        assert.equal(h.hasActiveRun(), true);
        assert.equal(h.tone(), "live");

        // The old, slow request from before the outage answers last: empty.
        await h.resolve(1, EMPTY);
        assert.equal(h.hasActiveRun(), true, "the obsolete answer did not remove the recovered run");
        assert.equal(h.tone(), "live");
        assert.equal(h.empty(), null, "no empty-state text while a run is on screen");
    } finally {
        h.cleanup();
    }
});

test("telemetry that becomes unavailable while the last answer was 'no runs' says so; it never reads as 'no runs on record'", async (t) => {
    const h = harness(t);
    try {
        await h.mount();
        await h.resolve(0, EMPTY);
        await h.resolve(1, EMPTY);
        assert.equal(h.tone(), "live");
        assert.deepEqual(h.empty(), { kind: "none", text: "No dispatch or agent runs on record yet." }, "confirmed by current telemetry");

        // Praxis goes dark behind a healthy Nexus: the API answers its own JSON 502.
        await h.step(11_000);
        const before = h.pending.length;
        await h.reconnect();
        assert.ok(h.pending.length > before, "the reconnect refetched");
        for (let i = before; i < h.pending.length; i += 1) await h.resolve(i, { error: "unavailable" }, 502);
        assert.equal(h.tone(), "stale");
        const empty = h.empty();
        assert.equal(empty.kind, "stale-none");
        assert.match(empty.text, /No runs in the last telemetry received \(as of /);
        assert.match(empty.text, /current telemetry is unavailable/);
        assert.match(empty.text, /cannot be shown yet/);
        assert.match(empty.text, /Retrying automatically/);
        assert.doesNotMatch(empty.text, /on record yet/);
    } finally {
        h.cleanup();
    }
});

test("the Nexus API itself unreachable with a cached empty list: offline tone, and the empty text acknowledges the gap", async (t) => {
    const h = harness(t);
    try {
        await h.mount();
        await h.resolve(0, EMPTY);
        await h.resolve(1, EMPTY);
        h.setProbe("unreachable");
        await act(async () => h.lifecycle.noteTransportFailure("socket"));
        await h.step(500);
        assert.equal(h.lifecycle.getState().phase, "offline");
        assert.equal(h.tone(), "offline");
        const empty = h.empty();
        assert.equal(empty.kind, "stale-none");
        assert.match(empty.text, /current telemetry is unavailable/);
        assert.doesNotMatch(empty.text, /on record yet/);

        // Back: the probe passes, every domain refetches, and current telemetry confirms "none".
        h.setProbe("ok");
        const before = h.pending.length;
        await act(async () => h.lifecycle.signal("manual"));
        await h.step(500);
        await h.step(400);
        for (let i = before; i < h.pending.length; i += 1) await h.resolve(i, EMPTY);
        assert.equal(h.tone(), "live");
        assert.equal(h.empty().kind, "none");
    } finally {
        h.cleanup();
    }
});
