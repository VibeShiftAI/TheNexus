/**
 * AutonomyIndicator renders the three autonomy states apart from one another —
 * running, an EXPLICIT pause (who asked, since when), and no-live-schedule —
 * with the full reason reachable on hover and to a screen reader.
 *
 * Mounts the real component against a stubbed relay response, so the poller,
 * the derivation and the chip are all exercised together.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

import { AutonomyIndicator } from "../bridge/autonomy-indicator.tsx";

/**
 * Serve one /api/dispatch-insight/autonomy payload. The hook's module-level
 * store is shared across mounts, so each case installs its own fetch and waits
 * for the poll to land before asserting.
 */
async function mountWith(payload) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        assert.match(String(url), /\/api\/dispatch-insight\/autonomy/);
        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(createElement(AutonomyIndicator, {}));
    });
    // Let the in-flight poll resolve and re-render.
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const chip = container.querySelector('[role="status"]');
    return {
        chip,
        text: container.textContent,
        title: chip?.getAttribute("title") ?? "",
        ariaLabel: chip?.getAttribute("aria-label") ?? "",
        cleanup() {
            act(() => root.unmount());
            container.remove();
            globalThis.fetch = realFetch;
        },
    };
}

test("running renders as running, with the reason on hover", async () => {
    const view = await mountWith({
        praxis: { reachable: true, error: null },
        paused: false,
        flag: { paused: false },
        inFlight: [{ taskId: "a" }],
        scheduleLive: true,
        scheduleDetail: "📅 **Day Schedule** (12 tasks):",
    });
    try {
        assert.match(view.text, /running/i);
        assert.match(view.title, /Autonomy is RUNNING/);
        assert.match(view.ariaLabel, /Autonomy: Autonomy is RUNNING/);
        assert.match(view.chip.className, /emerald/);
    } finally {
        view.cleanup();
    }
});

test("an explicit pause names who asked for it and how long it has held", async () => {
    const since = new Date(Date.now() - 90 * 60_000).toISOString();
    const view = await mountWith({
        praxis: { reachable: true, error: null },
        paused: true,
        flag: { paused: true, requestedBy: "Robert", since, reason: "pause everything" },
        inFlight: [{ taskId: "a" }, { taskId: "b" }],
        scheduleLive: null,
    });
    try {
        assert.match(view.text, /paused/i);
        assert.match(view.text, /Robert/);
        assert.match(view.text, /1h 30m/);
        assert.match(view.title, /PAUSED explicitly by Robert/);
        assert.match(view.title, /including for tasks Robert started by hand/);
        assert.match(view.title, /2 runs still in flight/);
        assert.match(view.chip.className, /rose/);
    } finally {
        view.cleanup();
    }
});

test("no-live-schedule renders distinctly from an explicit pause", async () => {
    const view = await mountWith({
        praxis: { reachable: true, error: null },
        paused: false,
        flag: { paused: false },
        inFlight: [],
        scheduleLive: false,
        scheduleDetail: "No active day schedule. Use `schedule_day` during the morning standup to create one.",
    });
    try {
        assert.match(view.text, /no schedule/i);
        // Explicitly NOT the word the explicit pause uses.
        assert.doesNotMatch(view.text, /paused/i);
        assert.match(view.title, /No live day schedule/);
        assert.match(view.title, /NOT an explicit stop/);
        assert.match(view.chip.className, /amber/);
    } finally {
        view.cleanup();
    }
});

test("an unreachable Praxis renders unknown, never running", async () => {
    const view = await mountWith({
        praxis: { reachable: false, error: "Praxis autonomy HTTP 502" },
        paused: false,
        flag: null,
        inFlight: [],
        scheduleLive: null,
    });
    try {
        assert.match(view.text, /unknown/i);
        assert.doesNotMatch(view.text, /running/i);
        assert.match(view.title, /Praxis is unreachable/);
        assert.match(view.title, /reads unknown rather than running/);
    } finally {
        view.cleanup();
    }
});

test("the chip is keyboard reachable", async () => {
    const view = await mountWith({
        praxis: { reachable: true, error: null },
        paused: false,
        flag: { paused: false },
        inFlight: [],
        scheduleLive: true,
    });
    try {
        assert.equal(view.chip.getAttribute("tabindex"), "0");
        assert.ok(view.chip.getAttribute("aria-label"));
    } finally {
        view.cleanup();
    }
});
