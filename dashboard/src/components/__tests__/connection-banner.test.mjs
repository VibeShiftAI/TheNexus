import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ConnectionBanner, RECOVERING_GRACE_MS } from "../connection-banner.tsx";
import { LiveBoardStateProvider } from "../live-board-state.tsx";
import { __setConnectionLifecycleForTests, createConnectionLifecycle } from "../../lib/connection-lifecycle.ts";

const T0 = Date.parse("2026-10-03T15:00:00Z");

function harness(t, probe, overrides = {}) {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: T0 });
    const opened = [];
    const lifecycle = createConnectionLifecycle({
        probe,
        target: window,
        isVisible: () => true,
        currentHref: () => "http://localhost/",
        storage: null,
        signInHref: () => "http://localhost/session/renewed",
        openSignIn: (href) => {
            opened.push(href);
            return { closed: false, close() {}, focus() {} };
        },
        ...overrides,
    });
    __setConnectionLifecycleForTests(lifecycle);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    return {
        lifecycle,
        opened,
        container,
        banner: () => container.querySelector("[data-connection-banner]"),
        async mount() {
            await act(async () => root.render(createElement(LiveBoardStateProvider, null, createElement(ConnectionBanner))));
        },
        async step(ms) {
            await act(async () => {
                t.mock.timers.tick(ms);
                await new Promise((r) => setImmediate(r));
            });
        },
        cleanup() {
            act(() => root.unmount());
            // Let the shared socket's and SSE store's 5s linger timers fire
            // under THIS test's mock clock, so no handle from this clock is
            // left for the next test's clearTimeout (which would corrupt the
            // next mock timer queue).
            t.mock.timers.tick(6_000);
            container.remove();
            lifecycle.dispose();
            __setConnectionLifecycleForTests(null);
            t.mock.timers.reset();
        },
    };
}

test("hidden while live; `offline` shows an honest dated pill with a manual retry that probes again", async (t) => {
    let outcome = "unreachable";
    const probes = [];
    const h = harness(t, async () => {
        probes.push(outcome);
        return outcome;
    });
    try {
        await h.mount();
        assert.equal(h.banner(), null, "nothing to say while live");
        h.lifecycle.signal("manual");
        await h.step(500);
        const pill = h.banner();
        assert.equal(pill.getAttribute("data-connection-banner"), "offline");
        assert.match(pill.textContent, /Nexus unreachable/);
        assert.match(pill.textContent, /retrying automatically/);
        assert.match(pill.textContent, /showing data as of/);
        const retry = pill.querySelector("button");
        assert.equal(retry.textContent, "Retry now");
        outcome = "ok";
        await act(async () => retry.click());
        await h.step(500);
        assert.deepEqual(probes, ["unreachable", "ok"]);
        assert.equal(h.banner(), null, "back to live: the pill is gone");
    } finally {
        h.cleanup();
    }
});

test("`reauth` in a browser offers one explicit sign-in action, never navigates on its own, and the click opens the sign-in window while this document stays", async (t) => {
    const h = harness(t, async () => "reauth");
    try {
        await h.mount();
        h.lifecycle.noteTransportFailure("fetch");
        await h.step(500);
        const pill = h.banner();
        assert.equal(pill.getAttribute("data-connection-banner"), "reauth");
        assert.equal(pill.getAttribute("role"), "alert");
        assert.match(pill.textContent, /session has expired/);
        assert.match(pill.textContent, /anything you typed is kept/);
        assert.equal(pill.querySelector("[data-connection-banner-hint]")?.textContent ?? null, null, "no relaunch hint outside the travel shell");
        assert.equal(pill.querySelector('[data-connection-banner-action="sign-in-here"]')?.textContent ?? null, null, "no same-tab path while the window route is open");
        await h.step(2 * 60_000);
        assert.deepEqual(h.opened, [], "and no window opened by itself");

        const buttons = [...pill.querySelectorAll("button")].map((b) => b.textContent);
        assert.deepEqual(buttons, ["Sign in again"]);
        await act(async () => pill.querySelector("button").click());
        assert.deepEqual(h.opened, ["http://localhost/session/renewed"]);
        const after = h.banner();
        assert.equal(after.getAttribute("data-connection-banner-signin"), "window-open");
        assert.match(after.textContent, /Finish signing in in the window that opened/);
        assert.match(after.textContent, /anything you typed stay as they are/);
    } finally {
        h.cleanup();
    }
});

test("a blocked sign-in window keeps all edits and offers another window attempt", async (t) => {
    const h = harness(t, async () => "reauth", { openSignIn: () => null });
    try {
        await h.mount();
        h.lifecycle.noteTransportFailure("fetch");
        await h.step(500);
        await act(async () => h.banner().querySelector("button").click());
        const pill = h.banner();
        assert.equal(pill.getAttribute("data-connection-banner-signin"), "blocked");
        assert.match(pill.textContent, /sign-in window was blocked/);
        const here = pill.querySelector('[data-connection-banner-action="sign-in-here"]');
        assert.equal(here.textContent, "Try sign-in window again");
        assert.match(pill.querySelector('[data-connection-banner-cost="sign-in-here"]').textContent, /all unsent edits stay open/);
        await act(async () => here.click());
    } finally {
        h.cleanup();
    }
});

test("inside the travel shell: `renewing` shows after the grace window while the shell is asked; once every attempt fails, sign-in opens a separate window", async (t) => {
    const requests = [];
    const h = harness(t, async () => "reauth", {
        renewal: {
            kind: "travel-shell",
            request: () => {
                requests.push(1);
                return true;
            },
        },
    });
    try {
        await h.mount();
        h.lifecycle.noteTransportFailure("fetch");
        await h.step(500);
        assert.equal(h.lifecycle.getState().phase, "renewing");
        assert.equal(h.banner(), null, "inside the grace window: a quick renewal never flashes a banner");
        await h.step(RECOVERING_GRACE_MS);
        assert.equal(h.banner().getAttribute("data-connection-banner"), "renewing");
        assert.match(h.banner().textContent, /Renewing your Nexus session/);

        // Attempt 2 is already waiting (4s), then attempt 3 (8s), then the
        // operator's turn. Each wait is scheduled once its probe settles, so
        // the mocked clock is stepped one stage at a time.
        await h.step(4_000);
        await h.step(8_000);
        assert.equal(requests.length, 3);
        const pill = h.banner();
        assert.equal(pill.getAttribute("data-connection-banner"), "reauth");
        assert.match(pill.textContent, /Automatic renewal did not restore the session/);
        assert.equal(pill.querySelector('[data-connection-banner-hint="relaunch"]'), null);
        const buttons = [...pill.querySelectorAll("button")].map((b) => b.textContent);
        assert.deepEqual(buttons, ["Sign in again"]);
        assert.deepEqual(h.opened, []);
        await act(async () => pill.querySelector("button").click());
        assert.deepEqual(h.opened, ["http://localhost/session/renewed"]);
    } finally {
        h.cleanup();
    }
});

test("a probe that drags on shows `recovering` only after the grace window, so an ordinary foreground return never flashes a banner", async (t) => {
    let resolveProbe;
    const h = harness(t, () => new Promise((resolve) => { resolveProbe = resolve; }));
    try {
        await h.mount();
        h.lifecycle.signal("manual");
        await h.step(500);
        assert.equal(h.banner(), null, "probe in flight, inside the grace");
        await h.step(RECOVERING_GRACE_MS - 1000);
        assert.equal(h.banner(), null);
        await h.step(2000);
        assert.equal(h.banner().getAttribute("data-connection-banner"), "recovering");
        assert.match(h.banner().textContent, /Reconnecting to the Nexus/);
        resolveProbe("ok");
        await h.step(0);
        assert.equal(h.banner(), null);
    } finally {
        h.cleanup();
    }
});
