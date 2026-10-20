/**
 * THE NEXUS MENU (nav-sidebar.tsx), mounted for real in jsdom: the dialog
 * semantics, focus and scroll handling, close paths and the controls that
 * must keep their behaviour after the 2026-10-20 redesign (task 91f1f758).
 * Layout and reachability at real viewport sizes are proven in a browser by
 * scripts/nav-menu-browser-check.mjs; jsdom has no layout engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { NavSidebar } from "../nav-sidebar.tsx";

const DESTINATIONS = [
    "/documents", "/activity", "/task-board", "/ops", "/session",
    "/academy", "/council", "/codex", "/knowledge-ingestion", "/intake-reports", "/studio",
    "/model-control", "/system-monitor", "http://192.168.86.205:7878",
];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function installFetch({ projects = [] } = {}) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        calls.push({ url: u, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
        if (u.startsWith("/api/projects")) return json(projects);
        if (u.startsWith("/api/model-control/options")) return json({ localOnly: { enabled: false, reason: null }, aliases: [], models: [] });
        if (u.startsWith("/api/model-control/local-only")) {
            const body = JSON.parse(init.body);
            return json({ enabled: body.enabled, reason: body.reason });
        }
        return json({}, 404);
    };
    return { calls, restore: () => { globalThis.fetch = original; } };
}

async function flush() {
    await act(async () => {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
    });
}

function harness(t, fetchOptions) {
    const net = installFetch(fetchOptions);
    const trigger = document.createElement("button");
    trigger.textContent = "Open navigation menu";
    const container = document.createElement("div");
    document.body.append(trigger, container);
    // jsdom does not navigate; keep link clicks from trying.
    container.addEventListener("click", (e) => e.preventDefault());
    const root = createRoot(container);
    const counts = { close: 0, settings: 0 };
    const props = { onClose: () => { counts.close++; }, onOpenSettings: () => { counts.settings++; } };
    const h = {
        net, trigger, container, counts,
        host: () => container.querySelector("[data-nav-menu]"),
        dialog: () => container.querySelector('[role="dialog"]'),
        button: (text) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent.trim().startsWith(text)),
        async render(isOpen) {
            await act(async () => root.render(createElement(NavSidebar, { isOpen, ...props })));
            await flush();
        },
        // Unmount before the next harness mounts, so page-lock and fetch restores nest correctly.
        dispose() {
            if (h.disposed) return;
            h.disposed = true;
            act(() => root.unmount());
            container.remove();
            trigger.remove();
            net.restore();
        },
    };
    t.after(() => h.dispose());
    return h;
}

function key(target, keyName, shiftKey = false) {
    const event = new KeyboardEvent("keydown", { key: keyName, shiftKey, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(event); });
    return event;
}

test("closed menu is inert; opening labels the dialog, takes focus and locks the page; closing gives both back", async (t) => {
    const h = harness(t);
    h.trigger.focus();
    await h.render(false);
    assert.equal(h.host().hasAttribute("inert"), true, "closed menu must not take focus or clicks");
    assert.equal(document.documentElement.style.overflow, "");

    await h.render(true);
    const dialog = h.dialog();
    assert.equal(h.host().hasAttribute("inert"), false);
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.equal(document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent, "THE NEXUS MENU");
    assert.equal(document.activeElement === dialog, true, "focus moves into the menu");
    assert.equal(document.documentElement.style.overflow, "hidden", "the page behind does not scroll");
    assert.ok(h.container.querySelector('button[aria-label="Close menu"]'), "Close is labelled");

    await h.render(false);
    assert.equal(h.host().hasAttribute("inert"), true);
    assert.equal(document.documentElement.style.overflow, "");
    assert.equal(document.activeElement === h.trigger, true, "focus returns to the opener");
});

test("Escape, the backdrop, Close and every destination close the menu", async (t) => {
    const h = harness(t);
    await h.render(true);
    key(window, "Escape");
    assert.equal(h.counts.close, 1, "Escape");
    act(() => h.host().firstElementChild.click());
    assert.equal(h.counts.close, 2, "backdrop");
    act(() => h.container.querySelector('button[aria-label="Close menu"]').click());
    assert.equal(h.counts.close, 3, "Close button");
    const links = Array.from(h.container.querySelectorAll("nav a"));
    for (const link of links) act(() => link.click());
    assert.equal(h.counts.close, 3 + links.length, "each destination closes the menu");
});

test("every destination is listed in its group without search, Reviews first, LARS in a new tab", async (t) => {
    const h = harness(t);
    await h.render(true);
    const links = Array.from(h.container.querySelectorAll("nav a"));
    assert.deepEqual(links.map((a) => a.getAttribute("href")).sort(), [...DESTINATIONS].sort());
    assert.equal(links[0].getAttribute("href"), "/documents");
    assert.match(links[0].textContent, /^Reviews/);
    assert.deepEqual(Array.from(h.container.querySelectorAll("nav h3")).map((el) => el.textContent), ["Operate", "Knowledge and studio", "Models and systems"]);
    const lars = links.find((a) => a.textContent.startsWith("LARS Dashboard"));
    assert.equal(lars.getAttribute("target"), "_blank");
    assert.equal(lars.getAttribute("rel"), "noreferrer");
    assert.equal(h.container.querySelector('input[type="search"], [role="search"]'), null, "no search needed");
});

test("Tab and Shift+Tab wrap inside the open menu", async (t) => {
    const h = harness(t);
    await h.render(true);
    const dialog = h.dialog();
    const focusable = Array.from(dialog.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    assert.equal(first.getAttribute("aria-label"), "Close menu");
    assert.equal(last.textContent.trim(), "Settings");

    assert.equal(key(dialog, "Tab", true).defaultPrevented, true);
    assert.equal(document.activeElement === last, true, "Shift+Tab from the dialog lands on the last control");
    assert.equal(key(last, "Tab").defaultPrevented, true);
    assert.equal(document.activeElement === first, true, "Tab from the last control wraps to Close");
    assert.equal(key(first, "Tab", true).defaultPrevented, true);
    assert.equal(document.activeElement === last, true, "Shift+Tab from Close wraps to the last control");
    first.focus();
    assert.equal(key(first, "Tab").defaultPrevented, false, "ordinary Tab inside the menu is left to the browser");
});

// Robert's review of 2026-10-20 (submission cd98d2e4): projects live on the
// dashboard, so the menu has no Active Projects section and no projects fetch.
test("the menu has no Active Projects section and never requests the project list", async (t) => {
    const projects = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, type: "tool" }));
    const h = harness(t, { projects });
    await h.render(true);
    const text = h.container.textContent;
    assert.doesNotMatch(text, /Active Projects/);
    assert.doesNotMatch(text, /Loading projects/);
    assert.doesNotMatch(text, /No active projects/);
    assert.equal(h.container.querySelectorAll('a[href^="/project/"]').length, 0, "no project links");
    assert.equal(h.container.querySelector('[role="status"]'), null, "no loading status");
    assert.deepEqual(Array.from(h.container.querySelectorAll("h3")).map((el) => el.textContent), ["Operate", "Knowledge and studio", "Models and systems", "Controls", "Model Aliases"]);
    assert.equal(h.net.calls.filter((c) => c.url.startsWith("/api/projects")).length, 0, "no menu-only projects request");
    h.dispose();
    assert.equal(document.documentElement.style.overflow, "", "the mount gave the page lock back");
});

test("the page lock keeps an existing overflow value and is released when the menu unmounts open", async (t) => {
    document.documentElement.style.overflow = "clip";
    t.after(() => { document.documentElement.style.overflow = ""; });
    const h = harness(t);
    await h.render(true);
    assert.equal(document.documentElement.style.overflow, "hidden");
    h.dispose();
    assert.equal(document.documentElement.style.overflow, "clip");
});

test("a closed menu ignores Escape, and closing does not steal focus that already moved elsewhere", async (t) => {
    const h = harness(t);
    await h.render(false);
    key(window, "Escape");
    assert.equal(h.counts.close, 0, "Escape does nothing while closed");

    h.trigger.focus();
    await h.render(true);
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    t.after(() => elsewhere.remove());
    elsewhere.focus();
    await h.render(false);
    assert.equal(document.activeElement === elsewhere, true);
});

test("when the opener never took focus (Safari), focus returns to the menu trigger", async (t) => {
    const h = harness(t);
    h.trigger.setAttribute("aria-label", "Open navigation menu");
    document.activeElement?.blur();
    await h.render(true);
    await h.render(false);
    assert.equal(document.activeElement === h.trigger, true);
});

test("Local Only sends the same request as before and shows the answer", async (t) => {
    const h = harness(t);
    await h.render(true);
    const toggle = h.container.querySelector('button[aria-label="Toggle local-only mode"]');
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    await act(async () => toggle.click());
    await flush();
    const put = h.net.calls.find((c) => c.url.startsWith("/api/model-control/local-only"));
    assert.equal(put?.method, "PUT");
    assert.deepEqual(put.body, { enabled: true, reason: "manual_override" });
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.ok(h.button("Save Alias"), "model aliases stay in the menu");
});

test("Settings opens settings and closes; Connection settings appears only in the Android shell", async (t) => {
    const h = harness(t);
    await h.render(true);
    assert.equal(h.button("Connection settings"), undefined);
    act(() => h.button("Settings").click());
    assert.deepEqual(h.counts, { close: 1, settings: 1 });

    const posted = [];
    window.ReactNativeWebView = { postMessage: (data) => posted.push(JSON.parse(data)) };
    window.__NEXUS_MOBILE_SHELL__ = Object.freeze({ platform: "android", appVersion: "1.2.3", origin: window.location.origin, capabilities: [] });
    t.after(() => {
        delete window.ReactNativeWebView;
        delete window.__NEXUS_MOBILE_SHELL__;
    });
    const shell = harness(t);
    await shell.render(true);
    const connection = shell.button("Connection settings");
    assert.match(connection.textContent, /app v1\.2\.3/);
    act(() => connection.click());
    assert.deepEqual(posted, [{ type: "open-settings" }]);
    assert.deepEqual(shell.counts, { close: 1, settings: 0 });
});
