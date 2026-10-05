// All sign-in routes retain the mounted editor, including native and blocked-popup fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ConnectionBanner } from "../connection-banner.tsx";
import { LiveBoardStateProvider } from "../live-board-state.tsx";
import { TaskEditModal } from "../task-edit-modal.tsx";
import { __setConnectionLifecycleForTests, createConnectionLifecycle } from "../../lib/connection-lifecycle.ts";

const T0 = Date.parse("2026-10-03T15:00:00Z");
const TASK = {
    id: "task-1",
    projectId: "proj-1",
    projectName: "TheNexus",
    title: "Original title",
    description: "Original description",
    status: "todo",
    priority: 1,
};

const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;

/** Replace a controlled textarea's value the way a browser keystroke does (native setter + bubbling input). */
function typeInto(textarea, text) {
    act(() => {
        valueSetter.call(textarea, text);
        textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
}

function harness(t, overrides = {}) {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: T0 });
    let outcome = "ok";
    const opened = [];
    const windows = [];
    const lifecycle = createConnectionLifecycle({
        probe: async () => outcome,
        target: window,
        isVisible: () => true,
        currentHref: () => "http://localhost/",
        storage: null,
        signInHref: () => "http://localhost/session/renewed",
        openSignIn: (href) => {
            opened.push(href);
            const w = { closed: false, closeCalls: 0, close() { this.closeCalls += 1; this.closed = true; }, focus() {} };
            windows.push(w);
            return w;
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
        windows,
        container,
        setProbe: (o) => {
            outcome = o;
        },
        banner: () => container.querySelector("[data-connection-banner]"),
        description: () => container.querySelector("textarea"),
        async mount() {
            await act(async () =>
                root.render(
                    createElement(
                        LiveBoardStateProvider,
                        null,
                        createElement(ConnectionBanner),
                        createElement(TaskEditModal, { task: TASK, isOpen: true, onClose() {}, onSaved() {} }),
                    ),
                ),
            );
        },
        async step(ms) {
            await act(async () => {
                t.mock.timers.tick(ms);
                await new Promise((r) => setImmediate(r));
            });
        },
        cleanup() {
            act(() => root.unmount());
            t.mock.timers.tick(6_000);
            container.remove();
            lifecycle.dispose();
            __setConnectionLifecycleForTests(null);
            t.mock.timers.reset();
        },
    };
}

test("an unsent task-description edit survives 'Sign in again' (separate window, this document untouched) and the renewed session's recovery", async (t) => {
    const h = harness(t);
    try {
        await h.mount();
        assert.equal(h.description().value, "Original description");
        typeInto(h.description(), "Unsent operator edit");
        assert.equal(h.description().value, "Unsent operator edit");

        // The session expires under the open editor.
        h.setProbe("reauth");
        await act(async () => h.lifecycle.noteTransportFailure("fetch"));
        await h.step(500);
        assert.equal(h.banner().getAttribute("data-connection-banner"), "reauth");
        assert.equal(h.description().value, "Unsent operator edit", "the expiry itself touches nothing");

        const signIn = [...h.banner().querySelectorAll("button")].find((b) => b.textContent === "Sign in again");
        await act(async () => signIn.click());
        assert.deepEqual(h.opened, ["http://localhost/session/renewed"]);
        assert.equal(h.description().value, "Unsent operator edit", "the edit is still on screen after the click");
        assert.match(h.banner().textContent, /window that opened/);

        // The window finishes the Access flow and announces it; the probe passes.
        h.setProbe("ok");
        await act(async () => window.dispatchEvent(new window.Event("nexus:session-renewed")));
        await h.step(500);
        assert.equal(h.banner()?.textContent ?? null, null, "live again: the banner is gone");
        assert.equal(h.windows[0].closeCalls, 1, "the sign-in window was closed for the operator");
        assert.equal(h.description().value, "Unsent operator edit", "and the edit is intact, ready to save");
    } finally {
        h.cleanup();
    }
});

test("when sign-in is blocked, retrying the window keeps the editor intact", async (t) => {
    const h = harness(t, { openSignIn: () => null });
    try {
        await h.mount();
        typeInto(h.description(), "Unsent operator edit");
        h.setProbe("reauth");
        await act(async () => h.lifecycle.noteTransportFailure("fetch"));
        await h.step(500);

        const signIn = [...h.banner().querySelectorAll("button")].find((b) => b.textContent === "Sign in again");
        await act(async () => signIn.click());
        assert.equal(h.description().value, "Unsent operator edit");
        const pill = h.banner();
        assert.equal(pill.getAttribute("data-connection-banner-signin"), "blocked");
        assert.match(pill.querySelector('[data-connection-banner-cost="sign-in-here"]').textContent, /all unsent edits stay open/);

        const here = pill.querySelector('[data-connection-banner-action="sign-in-here"]');
        assert.equal(here.textContent, "Try sign-in window again");
        await act(async () => here.click());
    } finally {
        h.cleanup();
    }
});


test("travel shell interactive fallback completes in the native cookie profile without replacing the editor", async (t) => {
    const { openSignInWindow } = await import("../../lib/session-renewal.ts");
    const commands = [];
    const native = {
        __NEXUS_SHELL__: { tabs: [], capabilities: ["sign-in-window"] },
        location: { origin: "https://nexus.example", assign: url => commands.push(url) },
        addEventListener: window.addEventListener.bind(window),
        removeEventListener: window.removeEventListener.bind(window),
        dispatchEvent: window.dispatchEvent.bind(window),
        open: () => { throw new Error("must not use the system browser profile"); },
    };
    const h = harness(t, {
        renewal: { kind: "travel-shell", request: () => false },
        openSignIn: href => openSignInWindow(href, native),
    });
    try {
        await h.mount();
        typeInto(h.description(), "Unsent operator edit");
        const originalTextarea = h.description();
        h.setProbe("reauth");
        await act(async () => h.lifecycle.noteTransportFailure("fetch"));
        await h.step(500);
        await act(async () => h.banner().querySelector("button").click());
        assert.deepEqual(commands, ["nexus-shell://sign-in"]);
        assert.equal(h.description(), originalTextarea);
        assert.equal(h.description().value, "Unsent operator edit");
        // Returning from Access changes the shared cookie profile; the native
        // window notifies the original page, whose real probe is authoritative.
        h.setProbe("ok");
        await act(async () => window.dispatchEvent(new window.Event("nexus:session-renewed")));
        await h.step(500);
        assert.equal(h.lifecycle.getState().phase, "live");
        assert.equal(h.description(), originalTextarea);
        assert.equal(h.description().value, "Unsent operator edit");
        assert.deepEqual(commands, ["nexus-shell://sign-in", "nexus-shell://close-sign-in"]);
    } finally { h.cleanup(); }
});

test('blocked popup fallback completes after popups are allowed, preserving the original editor', async t => {
    let allowed = false;
    let opened = 0;
    const h = harness(t, { openSignIn: () => {
        if (!allowed) return null;
        opened++;
        return { closed: false, close() { this.closed = true; }, focus() {} };
    } });
    try {
        await h.mount();
        typeInto(h.description(), 'Unsent fallback edit');
        const editor = h.description();
        h.setProbe('reauth');
        await act(async () => h.lifecycle.noteTransportFailure('fetch'));
        await h.step(500);
        await act(async () => h.banner().querySelector('button').click());
        assert.equal(h.lifecycle.getState().signIn, 'blocked');
        allowed = true;
        await act(async () => h.banner().querySelector('[data-connection-banner-action="sign-in-here"]').click());
        assert.equal(opened, 1);
        assert.equal(h.lifecycle.getState().signIn, 'window-open');
        h.setProbe('ok');
        await act(async () => window.dispatchEvent(new window.Event('nexus:session-renewed')));
        await h.step(500);
        assert.equal(h.lifecycle.getState().phase, 'live');
        assert.equal(h.description(), editor);
        assert.equal(h.description().value, 'Unsent fallback edit');
    } finally { h.cleanup(); }
});
