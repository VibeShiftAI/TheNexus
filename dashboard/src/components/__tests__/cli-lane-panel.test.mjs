/**
 * CliLanePanel renders the answer to "why is my task not running": which
 * executor holds each CLI slot, the queue with POSITIONS and waiting-since,
 * and the concurrency gate's own reason string.
 *
 * Mounts the real component (createRoot + act, the harness in test/helpers.mjs)
 * against a snapshot trimmed from a live GET /api/dispatch/state, so this is a
 * render assertion rather than a derivation assertion — deriveCliLane itself is
 * covered in lib/__tests__/cli-lane.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

import { CliLanePanel } from "../bridge/cli-lane-panel.tsx";
import { deriveCliLane } from "../../lib/cli-lane.ts";

const NOW = Date.parse("2026-09-03T01:20:00.000Z");

const LIVE_SNAPSHOT = {
    executors: {
        runs: [
            {
                taskId: "338399cd",
                executor: "claude-code",
                title: "Dashboard: show why work is queued",
                kind: "task",
                phase: "testing",
                status: "active",
                startedAt: "2026-09-03T01:14:00.802Z",
            },
        ],
        cliQueue: [
            {
                taskId: "e524649b",
                title: "Living STATE.md replaces the March CONTEXT.md",
                executor: "claude-code",
                enqueuedAt: "2026-09-03T01:14:00.580Z",
            },
            {
                taskId: "5b52e0f0",
                title: "Close the QA learning loop",
                executor: "codex",
                enqueuedAt: "2026-09-03T00:20:00.000Z",
            },
        ],
        cliConcurrency: {
            limit: 1,
            burst: false,
            reason:
                "serial: outside the 6:00–17:00 burst window — cap 1; occupancy 1/1 (claude-code 1/1, codex 0/1, antigravity 0/1), 1 queued",
            slots: { "claude-code": 1, codex: 1, antigravity: 1 },
            metrics: null,
            thresholds: { memFreeMinPct: 25, swapoutMaxMbPerSec: 1 },
            active: 1,
            free: 0,
            queued: 1,
            occupancy: {
                "claude-code": { active: 1, slots: 1, free: 0 },
                codex: { active: 0, slots: 1, free: 0 },
                antigravity: { active: 0, slots: 1, free: 0 },
            },
        },
        posture: { mode: "nominal", available: ["claude-code", "codex", "antigravity"], suspended: [] },
        attemptStalls: { violations: [], requeues: [], pending: 0, graceMinutes: 15 },
    },
};

function mount(state, now = NOW) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(createElement(CliLanePanel, { view: deriveCliLane(state, now) }));
    });
    return {
        container,
        text: container.textContent,
        unmount() {
            act(() => root.unmount());
            container.remove();
        },
    };
}

test("the gate's reason string renders verbatim", () => {
    const view = mount(LIVE_SNAPSHOT);
    try {
        assert.match(view.text, /serial: outside the 6:00–17:00 burst window/);
        assert.match(view.text, /occupancy 1\/1 \(claude-code 1\/1, codex 0\/1, antigravity 0\/1\)/);
        assert.match(view.text, /1\/1 running/);
    } finally {
        view.unmount();
    }
});

test("queue positions render in order, each with its title and wait clock", () => {
    const view = mount(LIVE_SNAPSHOT);
    try {
        const items = [...view.container.querySelectorAll("ol > li")];
        assert.equal(items.length, 2);

        assert.match(items[0].textContent, /^1/);
        assert.match(items[0].textContent, /Living STATE\.md replaces the March CONTEXT\.md/);
        assert.match(items[0].textContent, /waiting 5m/);

        assert.match(items[1].textContent, /^2/);
        assert.match(items[1].textContent, /Close the QA learning loop/);
        assert.match(items[1].textContent, /waiting 1h 0m/);

        // The position number is announced, not just visual.
        assert.ok(view.container.querySelector('[aria-label="Queue position 1"]'));
        assert.ok(view.container.querySelector('[aria-label="Queue position 2"]'));
    } finally {
        view.unmount();
    }
});

test("per-executor rows show the active run, its phase and elapsed time", () => {
    const view = mount(LIVE_SNAPSHOT);
    try {
        assert.match(view.text, /Claude Code/);
        assert.match(view.text, /Dashboard: show why work is queued/);
        assert.match(view.text, /testing · 5m/);
        // Executors with no run read idle rather than disappearing.
        assert.match(view.text, /Codex/);
        assert.match(view.text, /Antigravity/);
        assert.match(view.text, /idle/);
    } finally {
        view.unmount();
    }
});

test("the section carries an accessible summary of the lane state", () => {
    const view = mount(LIVE_SNAPSHOT);
    try {
        const section = view.container.querySelector("section");
        assert.equal(
            section.getAttribute("aria-label"),
            "CLI lane — 1 CLI run active, limit 1, 2 queued",
        );
    } finally {
        view.unmount();
    }
});

test("an older Praxis without the fields says so instead of rendering an empty gate", () => {
    const view = mount({ executors: { runs: [] } });
    try {
        assert.match(view.text, /CLI lane telemetry unavailable/);
        assert.equal(view.container.querySelector("ol"), null);
    } finally {
        view.unmount();
    }
});

test("structured gate numbers render beside the reason once Praxis sends them", () => {
    const state = structuredClone(LIVE_SNAPSHOT);
    state.executors.cliConcurrency.metrics = { memFreePct: 55.4, swapoutMbPerSec: 0.25 };

    const view = mount(state);
    try {
        assert.match(view.text, /mem free 55%/);
        assert.match(view.text, /swap rate 0\.3 MB\/s/);
        // …without displacing the sentence.
        assert.match(view.text, /serial: outside the 6:00–17:00 burst window/);
    } finally {
        view.unmount();
    }
});
