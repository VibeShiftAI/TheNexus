/**
 * ShellBridgeCore is the dashboard half of the Android shell bridge: it tells
 * the shell when the page is ready / where it is / how many HITL requests are
 * pending, and turns the shell's navigate events into router pushes — but only
 * for sanitised same-origin paths. Mounted for real (createRoot + act) with a
 * fake native channel on the jsdom window.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

import { ShellBridgeCore } from "../mobile-shell-bridge.tsx";

const EVENT = "nexus-mobile-navigate";

function withShell(run) {
    const sent = [];
    window.__NEXUS_MOBILE_SHELL__ = Object.freeze({
        platform: "android", appVersion: "0.6.0", origin: window.location.origin,
        capabilities: ["navigate"], navigateEvent: EVENT,
    });
    window.ReactNativeWebView = { postMessage: (data) => sent.push(JSON.parse(data)) };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        return run({ sent, root });
    } finally {
        act(() => root.unmount());
        container.remove();
        delete window.__NEXUS_MOBILE_SHELL__;
        delete window.ReactNativeWebView;
        window.history.replaceState(null, "", "/");
    }
}

function dispatch(detail) {
    act(() => {
        window.dispatchEvent(new window.CustomEvent(EVENT, { detail }));
    });
}

test("announces ready, location and badge count to the shell", () => {
    withShell(({ sent, root }) => {
        window.history.replaceState(null, "", "/inbox?filter=all");
        act(() => root.render(createElement(ShellBridgeCore, { navigateEvent: EVENT, badgeCount: 4, onNavigate: () => {} })));
        assert.deepEqual(sent.find((m) => m.type === "ready"), { type: "ready", path: "/inbox?filter=all" });
        assert.deepEqual(sent.find((m) => m.type === "navigated"), { type: "navigated", path: "/inbox?filter=all" });
        assert.deepEqual(sent.find((m) => m.type === "badge"), { type: "badge", count: 4 });

        act(() => root.render(createElement(ShellBridgeCore, { navigateEvent: EVENT, badgeCount: 2000, onNavigate: () => {} })));
        assert.deepEqual(sent.filter((m) => m.type === "badge").at(-1), { type: "badge", count: 999 });
    });
});

test("routes sanitised navigate events and ignores origin escapes", () => {
    withShell(({ root }) => {
        const pushed = [];
        act(() => root.render(createElement(ShellBridgeCore, { navigateEvent: EVENT, badgeCount: 0, onNavigate: (p) => pushed.push(p) })));

        dispatch("/task/abc?tab=qa");
        dispatch("/inbox#h1");
        assert.deepEqual(pushed, ["/task/abc?tab=qa", "/inbox#h1"]);

        dispatch("https://evil.example/");
        dispatch("//evil.example");
        dispatch({ path: "/x" });
        dispatch("/javascript:alert(1)");
        assert.deepEqual(pushed, ["/task/abc?tab=qa", "/inbox#h1"]);
    });
});

test("a hash-only change on the current page updates the hash instead of re-routing", () => {
    withShell(({ root }) => {
        const pushed = [];
        window.history.replaceState(null, "", "/inbox");
        act(() => root.render(createElement(ShellBridgeCore, { navigateEvent: EVENT, badgeCount: 0, onNavigate: (p) => pushed.push(p) })));

        dispatch("/inbox#hitl-42");
        assert.equal(window.location.hash, "#hitl-42");
        assert.deepEqual(pushed, []);
    });
});

test("stops listening once unmounted", () => {
    withShell(({ root }) => {
        const pushed = [];
        act(() => root.render(createElement(ShellBridgeCore, { navigateEvent: EVENT, badgeCount: 0, onNavigate: (p) => pushed.push(p) })));
        act(() => root.render(null));
        dispatch("/ops");
        assert.deepEqual(pushed, []);
    });
});
