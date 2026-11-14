/**
 * THE SYSTEM MAP PAGE (system-map-view.tsx), mounted for real in jsdom: one
 * read on load and one per Refresh with nothing in between, the six views,
 * a component's detail with source locations, keyboard movement, and the
 * states shown when there is no map to show. Layout at real viewport sizes
 * and both themes are proven in a browser by scripts/system-map-browser-check.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { SystemMapView } from "../system-map/system-map-view.tsx";
import { fixtureMap } from "../../lib/__tests__/system-map-fixture.mjs";

const TAB_LABELS = ["Map", "Connections", "Schedule", "Routes", "Drift", "Boundary"];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function flush() {
    await act(async () => {
        for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    });
}

async function mount(t, respond = () => json(fixtureMap()), { narrow = false } = {}) {
    const calls = [];
    const timers = { timeouts: 0, intervals: 0 };
    const original = {
        fetch: globalThis.fetch, matchMedia: window.matchMedia, css: globalThis.CSS,
        setInterval: globalThis.setInterval, scrollIntoView: Element.prototype.scrollIntoView,
    };
    globalThis.fetch = async (url, init = {}) => {
        const call = { url: String(url), method: init.method || "GET" };
        calls.push(call);
        if (call.url.startsWith("/api/system-map")) return respond(call, calls.filter((c) => c.url.startsWith("/api/system-map")).length);
        return json({ operator: false }, 401);
    };
    window.matchMedia = (query) => ({
        matches: narrow && /max-width/.test(query), media: query, addEventListener() {}, removeEventListener() {},
    });
    if (!globalThis.CSS?.escape) globalThis.CSS = { ...(globalThis.CSS || {}), escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&") };
    Element.prototype.scrollIntoView = () => {};
    globalThis.setInterval = (...args) => { timers.intervals++; return original.setInterval(...args); };
    window.localStorage.removeItem("nexus:system-map-theme");

    const container = document.createElement("div");
    document.body.append(container);
    container.addEventListener("click", (e) => { if (e.target.closest?.("a")) e.preventDefault(); });
    const root = createRoot(container);
    await act(async () => root.render(createElement(SystemMapView)));
    await flush();
    t.after(async () => {
        await act(async () => root.unmount());
        container.remove();
        globalThis.fetch = original.fetch;
        window.matchMedia = original.matchMedia;
        globalThis.setInterval = original.setInterval;
        Element.prototype.scrollIntoView = original.scrollIntoView;
        window.history.replaceState(null, "", "/");
    });
    const q = (sel) => container.querySelector(sel);
    return {
        container, calls, timers, q,
        mapCalls: () => calls.filter((c) => c.url.startsWith("/api/system-map")),
        all: (sel) => [...container.querySelectorAll(sel)],
        async click(target) {
            const el = typeof target === "string" ? q(target) : target;
            assert.ok(el, `nothing to click for ${target}`);
            await act(async () => el.click());
            await flush();
        },
        async key(el, key) {
            await act(async () => el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
            await flush();
        },
    };
}

test("one read on load, one more per Refresh, and nothing that writes or repeats", async (t) => {
    const h = await mount(t);
    assert.deepEqual(h.mapCalls(), [{ url: "/api/system-map", method: "GET" }]);
    assert.equal(h.q("[data-sm-generated]").getAttribute("data-sm-generated"), "2026-11-13T18:21:16.068Z");
    assert.equal(h.q("[data-sm-generated]").textContent, "2026-11-13 18:21 UTC");
    assert.equal(h.q("[data-sm-hash]").textContent, "9d77d6536e79b27a");

    // Moving around the page reads nothing more.
    for (const tab of ["connections", "schedule", "routes", "drift", "boundary", "map"]) await h.click(`[data-sm-tab="${tab}"]`);
    await h.click('[data-sm-id="praxis/reports"]');
    await new Promise((r) => setTimeout(r, 60));
    await flush();
    assert.equal(h.mapCalls().length, 1);
    assert.equal(h.timers.intervals, 0, "no interval is ever scheduled");

    await h.click("[data-sm-refresh]");
    assert.equal(h.mapCalls().length, 2);
    assert.deepEqual([...new Set(h.calls.map((c) => c.method))], ["GET"], "the page never sends anything but GET");
});

test("the six views are tabs, movable by arrow keys, and the view is kept in the address", async (t) => {
    const h = await mount(t);
    const tabs = h.all("[role=tab]");
    assert.deepEqual(tabs.map((el) => el.getAttribute("data-sm-tab")), ["map", "connections", "schedule", "routes", "drift", "boundary"]);
    assert.deepEqual(tabs.map((el) => el.textContent.replace(/[\d,]+( warnings?)?$/, "")), TAB_LABELS);
    assert.deepEqual(tabs.map((el) => el.tabIndex), [0, -1, -1, -1, -1, -1]);
    assert.equal(h.q("[role=tabpanel]").getAttribute("data-sm-view"), "map");

    tabs[0].focus();
    await h.key(tabs[0], "ArrowRight");
    assert.equal(h.q("[role=tabpanel]").getAttribute("data-sm-view"), "connections");
    assert.equal(document.activeElement.getAttribute("data-sm-tab"), "connections");
    assert.equal(window.location.search, "?tab=connections");
    await h.key(document.activeElement, "End");
    assert.equal(h.q("[role=tabpanel]").getAttribute("data-sm-view"), "boundary");
    await h.key(document.activeElement, "ArrowRight");
    assert.equal(h.q("[role=tabpanel]").getAttribute("data-sm-view"), "map");
    assert.equal(window.location.search, "");

    for (const [tab, text] of [["schedule", /Praxis\/src\/reports\/attention-economics\.ts:381/], ["routes", /\/api\/tasks\/:taskId/], ["drift", /Jobs in code that are not registered/], ["boundary", /nexus\.example\.test/]]) {
        await h.click(`[data-sm-tab="${tab}"]`);
        assert.match(h.q("[role=tabpanel]").textContent, text, tab);
    }
});

test("selecting a component shows what it is, its size and activity, routes, jobs and both directions with locations", async (t) => {
    const h = await mount(t);
    assert.match(h.q("[data-sm-panel]").textContent, /How to read this/);
    await h.click('[data-sm-id="praxis/reports"]');
    const panel = h.q("[data-sm-panel]").textContent;
    assert.equal(h.q('.sm-tile[data-sm-id="praxis/reports"]').getAttribute("aria-pressed"), "true");
    assert.match(panel, /Builds the weekly reports\./);
    assert.match(panel, /Praxis\/system-map-notes\.json/);
    assert.match(panel, /1,200/, "lines of code");
    assert.match(panel, /2026-11-01/, "last change");
    const out = h.q('[data-sm-section="out"]').textContent, incoming = h.q('[data-sm-section="in"]').textContent;
    assert.match(out, /tasks/);
    assert.match(out, /Praxis\/src\/reports\/attention-economics\.ts:120/);
    assert.match(out, /OpenRouter/);
    assert.match(incoming, /TheNexus\/server\/routes\/tasks\.js:310/);
    assert.match(panel, /attention-economics/);
    assert.match(panel, /Weekly per-project spend\./);
    assert.match(panel, /Praxis\/src\/reports\/attention-economics\.ts:381/);
    assert.match(panel, /\/api\/reports/);
    assert.match(panel, /Praxis\/src\/reports\/routes\.ts:12/);

    // The neighbours are marked on the map, and a connection leads on to its other end.
    assert.equal(h.q('.sm-tile[data-sm-id="nexus/routes/tasks"]').getAttribute("data-near"), "out");
    await h.click('[data-sm-id="nexus/routes/tasks"]');
    const tasks = h.q("[data-sm-panel]").textContent;
    assert.match(tasks, /Task CRUD and lifecycle updates\./);
    assert.match(tasks, /TheNexus\/server\/routes\/tasks\.js:88/);
    assert.match(tasks, /code comment/);
});

test("nothing is cut without saying so: job descriptions are whole, and a long table states its total and hands over the rest", async (t) => {
    const description = `Clusters consumed episodes into lessons. ${"Each cluster is summarised once. ".repeat(12)}Never deletes; dry-run by default.`;
    assert.ok(description.length > 400);
    const base = fixtureMap();
    const h = await mount(t, () => json(fixtureMap({
        edges: [...base.edges, ...Array.from({ length: 170 }, (_, i) => ({ from: "praxis/reports", to: "nexus/routes/tasks", kind: "file", count: 1, evidence: [`Praxis/src/reports/extra.ts:${i + 1}`] }))],
        catalogs: {
            ...base.catalogs,
            crons: base.catalogs.crons.map((c) => (c.key === "attention-economics" ? { ...c, description } : c)),
            docs: [...base.catalogs.docs, ...Array.from({ length: 45 }, (_, i) => ({ file: `Praxis/docs/behind-${i + 1}.md`, kind: "living", lastCommit: "2026-07-01", refs: 6, missingRefs: 1, refsChangedSince: i }))],
        },
    })));

    await h.click('[data-sm-id="praxis/reports"]');
    assert.equal(h.q('[data-sm-section="jobs"]').textContent.includes(description), true, "the detail shows the whole description");
    await h.click('[data-sm-tab="schedule"]');
    assert.equal(h.q("[data-sm-jobs]").textContent.includes(description), true, "the schedule shows the whole description");

    await h.click('[data-sm-tab="connections"]');
    assert.equal(h.all("[data-sm-links] tbody tr").length, 150);
    assert.match(h.q('[data-sm-shown="links"]').textContent, /Showing the 150 strongest of 175 links\./);
    await h.click('[data-sm-show-all="links"]');
    assert.equal(h.all("[data-sm-links] tbody tr").length, 175);
    assert.match(h.q('[data-sm-shown="links"]').textContent, /All 175 links shown, strongest first\./);
    assert.equal(h.q('[data-sm-show-all="links"]').getAttribute("aria-pressed"), "true");

    await h.click('[data-sm-tab="drift"]');
    assert.equal(h.all("[data-sm-docs] tbody tr").length, 40);
    assert.match(h.q('[data-sm-shown="docs"]').textContent, /Showing the 40 stalest of 46 living docs that name missing or changed files\./);
    await h.click('[data-sm-show-all="docs"]');
    assert.equal(h.all("[data-sm-docs] tbody tr").length, 46);
    assert.equal(h.mapCalls().length, 1, "showing the rest reads nothing more");
});

test("a table short enough to open whole states its total and offers no control", async (t) => {
    const h = await mount(t);
    await h.click('[data-sm-tab="connections"]');
    assert.equal(h.q('[data-sm-shown="links"]').textContent, "5 links, strongest first.");
    assert.equal(h.all('[data-sm-show-all="links"]').length, 0);
    await h.click('[data-sm-tab="drift"]');
    assert.equal(h.q('[data-sm-shown="docs"]').textContent, "1 living doc that names missing or changed files, stalest first.");
    assert.equal(h.all('[data-sm-show-all="docs"]').length, 0);
});

test("keyboard: a tile opens its detail, focus moves to it, and Escape returns to the tile", async (t) => {
    const h = await mount(t);
    const tile = h.q('.sm-tile[data-sm-id="praxis/reports"]');
    assert.equal(tile.tagName, "BUTTON");
    tile.focus();
    // A real keyboard activation arrives as a click with no pointer detail.
    await act(async () => tile.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 })));
    await flush();
    assert.ok(h.q("[data-sm-panel]").contains(document.activeElement), "focus is inside the detail");
    await h.key(document.activeElement, "Escape");
    assert.match(h.q("[data-sm-panel]").textContent, /How to read this/);
    // Focus goes back on the next frame.
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    // Compared by attribute: a failed assert on a jsdom element exhausts memory printing it.
    assert.equal(document.activeElement.getAttribute("data-sm-id"), "praxis/reports");
    assert.equal(document.activeElement.className.includes("sm-tile"), true);
});

test("phone width: the detail opens as a sheet over an inert page, and Close gives the page back", async (t) => {
    const h = await mount(t, undefined, { narrow: true });
    assert.equal(h.q("[data-sm-panel]").getAttribute("data-sm-open"), "false");
    await h.click('[data-sm-id="praxis/reports"]');
    assert.equal(h.q("[data-sm-panel]").getAttribute("data-sm-open"), "true");
    assert.ok(h.q("[role=tablist]").hasAttribute("inert"));
    assert.ok(h.q("[role=tabpanel]").hasAttribute("inert"));
    await h.click("[data-sm-close]");
    assert.equal(h.q("[data-sm-panel]").getAttribute("data-sm-open"), "false");
    assert.ok(!h.q("[role=tablist]").hasAttribute("inert"));
});

test("the theme toggle switches the map only and is remembered", async (t) => {
    const h = await mount(t);
    assert.equal(h.q("[data-sm-root]").getAttribute("data-sm-theme"), "dark");
    await h.click("[data-sm-theme-toggle]");
    assert.equal(h.q("[data-sm-root]").getAttribute("data-sm-theme"), "light");
    assert.equal(window.localStorage.getItem("nexus:system-map-theme"), "light");
    await h.click("[data-sm-theme-toggle]");
    assert.equal(h.q("[data-sm-root]").getAttribute("data-sm-theme"), "dark");
    assert.equal(h.mapCalls().length, 1);
});

test("a refused read shows the sign-in state and no map; a missing map says so", async (t) => {
    const refused = await mount(t, () => json({ error: "Sign in to see the system map.", code: "sign_in_required" }, 401));
    assert.equal(refused.q("[data-sm-state]").getAttribute("data-sm-state"), "sign-in");
    assert.equal(refused.q("[role=tablist]"), null);
    assert.equal(refused.q("[data-sm-stamp]"), null);
    assert.equal(refused.mapCalls().length, 1, "a refusal is not retried on its own");

    const missing = await mount(t, () => json({ error: "No map yet.", code: "system_map_missing" }, 404));
    assert.equal(missing.q("[data-sm-state]").getAttribute("data-sm-state"), "missing");
});

test("a failed Refresh keeps the map that was loaded and says the refresh failed", async (t) => {
    const h = await mount(t, (_call, n) => (n === 1 ? json(fixtureMap()) : json({ error: "down" }, 503)));
    await h.click("[data-sm-refresh]");
    assert.ok(h.q("[data-sm-refresh-failed]"));
    assert.equal(h.q("[data-sm-hash]").textContent, "9d77d6536e79b27a");
    assert.equal(h.all("[role=tab]").length, 6);
});
