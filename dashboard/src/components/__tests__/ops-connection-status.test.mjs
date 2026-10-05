import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { OpsConnectionStatus, describeOpsConnection, fmtClock } from "../ops-connection-status.tsx";

const T0 = Date.parse("2026-10-03T15:04:05Z");
const base = {
    phase: "live",
    phaseSince: T0 - 60_000,
    loadedAt: T0,
    err: null,
    reauthAttempted: false,
    signIn: "idle",
    renewalKind: null,
};

test("live with telemetry: dated as of the last answer, no action", () => {
    const d = describeOpsConnection(base);
    assert.equal(d.tone, "live");
    assert.equal(d.headline, "Live");
    assert.equal(d.detail, `data as of ${fmtClock(T0)}`);
    assert.deepEqual(d.actions, []);
    assert.equal(describeOpsConnection({ ...base, loadedAt: null }).detail, "loading…");
});

test("the API is healthy but dispatch telemetry failed (Praxis down behind a healthy Nexus): stale, dated, retry offered, never 'no runs'", () => {
    const d = describeOpsConnection({ ...base, err: "dispatch-state 502" });
    assert.equal(d.tone, "stale");
    assert.equal(d.headline, "Dispatch telemetry unavailable");
    assert.match(d.detail, /dispatch-state 502/);
    assert.match(d.detail, new RegExp(`showing data as of ${fmtClock(T0).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(d.detail, /retrying automatically/);
    assert.deepEqual(d.actions, ["retry"]);
    assert.equal(describeOpsConnection({ ...base, err: "x", loadedAt: null }).detail.includes("no runs loaded yet"), true);
});

test("recovering, renewing and offline name the gap honestly; offline says since when and offers a retry", () => {
    const rec = describeOpsConnection({ ...base, phase: "recovering" });
    assert.equal(rec.tone, "stale");
    assert.match(rec.headline, /Reconnecting/);
    assert.deepEqual(rec.actions, []);

    const ren = describeOpsConnection({ ...base, phase: "renewing", renewalKind: "travel-shell" });
    assert.equal(ren.tone, "stale");
    assert.match(ren.headline, /Renewing your session/);
    assert.match(ren.detail, /showing data as of/);
    assert.deepEqual(ren.actions, [], "the shell is working; nothing for the operator to do yet");

    const off = describeOpsConnection({ ...base, phase: "offline" });
    assert.equal(off.tone, "offline");
    assert.equal(off.headline, `Nexus unreachable since ${fmtClock(T0 - 60_000)}`);
    assert.match(off.detail, /showing data as of/);
    assert.match(off.detail, /retrying automatically/);
    assert.deepEqual(off.actions, ["retry"]);
});

test("reauth in a browser offers exactly one explicit action; while its window is open it says so; a blocked window offers a popup retry", () => {
    const first = describeOpsConnection({ ...base, phase: "reauth" });
    assert.equal(first.tone, "reauth");
    assert.equal(first.headline, "Session expired");
    assert.match(first.detail, /sign in to resume/);
    assert.match(first.detail, /keeps what you typed/);
    assert.deepEqual(first.actions, ["reauth"]);
    assert.doesNotMatch(first.detail, /relaunch/);

    const again = describeOpsConnection({ ...base, phase: "reauth", reauthAttempted: true });
    assert.match(again.detail, /did not restore the session/);
    assert.doesNotMatch(again.detail, /relaunch/, "relaunch advice belongs to the travel shell only");
    assert.deepEqual(again.actions, ["reauth"]);

    const open = describeOpsConnection({ ...base, phase: "reauth", reauthAttempted: true, signIn: "window-open" });
    assert.match(open.detail, /window that opened/);
    assert.match(open.detail, /keeps what you typed/);
    assert.deepEqual(open.actions, ["reauth"]);

    const blocked = describeOpsConnection({ ...base, phase: "reauth", reauthAttempted: true, signIn: "blocked" });
    assert.match(blocked.detail, /allow pop-ups/);
    assert.match(blocked.detail, /all unsent edits/);
    assert.deepEqual(blocked.actions, ["sign-in-here"]);
});

test("reauth inside the travel shell preserves the page using the native sign-in window", () => {
    const d = describeOpsConnection({ ...base, phase: "reauth", renewalKind: "travel-shell" });
    assert.equal(d.tone, "reauth");
    assert.match(d.detail, /keeps what you typed/);
    assert.deepEqual(d.actions, ["reauth"]);
    const blocked = describeOpsConnection({ ...base, phase: "reauth", renewalKind: "travel-shell", signIn: "blocked" });
    assert.match(blocked.detail, /update The Nexus/);
    assert.match(blocked.detail, /all unsent edits/);
});

test("the component exposes phase/tone/data-state attributes and wires each offered button to the right handler", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const calls = [];
    const render = (props) =>
        act(() =>
            root.render(
                createElement(OpsConnectionStatus, {
                    ...base,
                    ...props,
                    onRetry: () => calls.push("retry"),
                    onReauth: () => calls.push("reauth"),
                    onSignInHere: () => calls.push("sign-in-here"),
                }),
            ),
        );
    const buttons = () => [...container.querySelectorAll("button")];
    try {
        await render({});
        let el = container.querySelector("[data-ops-connection]");
        assert.equal(el.getAttribute("data-ops-connection"), "live");
        assert.equal(el.getAttribute("data-ops-tone"), "live");
        assert.equal(el.getAttribute("data-ops-data-state"), "fresh");
        assert.equal(buttons().length, 0, "no action while live");

        await render({ phase: "offline" });
        el = container.querySelector("[data-ops-connection]");
        assert.equal(el.getAttribute("data-ops-connection"), "offline");
        assert.equal(el.getAttribute("data-ops-data-state"), "stale");
        assert.deepEqual(buttons().map((b) => b.textContent), ["Retry now"]);
        await act(() => buttons()[0].click());
        assert.deepEqual(calls, ["retry"]);

        await render({ phase: "reauth", loadedAt: null });
        el = container.querySelector("[data-ops-connection]");
        assert.equal(el.getAttribute("data-ops-data-state"), "none");
        assert.deepEqual(buttons().map((b) => b.textContent), ["Sign in again"]);
        await act(() => buttons()[0].click());
        assert.deepEqual(calls, ["retry", "reauth"]);

        await render({ phase: "reauth", loadedAt: null, reauthAttempted: true, signIn: "blocked" });
        assert.deepEqual(buttons().map((b) => b.getAttribute("data-ops-action")), ["sign-in-here"]);
        await act(() => buttons()[0].click());
        assert.deepEqual(calls, ["retry", "reauth", "sign-in-here"]);

        await render({ phase: "reauth", renewalKind: "travel-shell" });
        assert.deepEqual(buttons().map((b) => b.textContent), ["Sign in again"]);
    } finally {
        act(() => root.unmount());
        container.remove();
    }
});
