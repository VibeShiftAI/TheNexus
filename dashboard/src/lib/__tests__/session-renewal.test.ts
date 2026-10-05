import test from "node:test";
import assert from "node:assert/strict";

import {
    RENEWED_EVENT,
    RENEW_REQUEST_URL,
    SESSION_CHANNEL,
    SIGN_IN_RETURN_PATH,
    announceSessionRenewed,
    detectRenewalBridge,
    openSignInWindow,
    signInHref,
    subscribeSessionRenewed,
} from "../session-renewal";

type WindowArg = Parameters<typeof detectRenewalBridge>[0];

/** A minimal window double; only what the module touches. */
function fakeWindow(extra: Record<string, unknown> = {}) {
    const listeners = new Map<string, Set<(e: Event) => void>>();
    const assigned: string[] = [];
    const w = {
        addEventListener(type: string, cb: (e: Event) => void) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(cb);
        },
        removeEventListener(type: string, cb: (e: Event) => void) {
            listeners.get(type)?.delete(cb);
        },
        dispatchEvent(e: Event) {
            for (const cb of listeners.get(e.type) ?? []) cb(e);
            return true;
        },
        location: { origin: "https://nexus.example", assign: (href: string) => void assigned.push(href) },
        ...extra,
    };
    return { w: w as unknown as WindowArg, listeners, assigned };
}

class FakeChannel {
    static instances: FakeChannel[] = [];
    name: string;
    posted: unknown[] = [];
    closed = false;
    onmessage: ((e: MessageEvent) => void) | null = null;
    constructor(name: string) {
        this.name = name;
        FakeChannel.instances.push(this);
    }
    postMessage(data: unknown) {
        this.posted.push(data);
    }
    close() {
        this.closed = true;
    }
}

test("detectRenewalBridge: a plain browser has none; the travel shell is recognized by its injected global and waits for native completion", async () => {
    assert.equal(detectRenewalBridge(fakeWindow().w), null);
    assert.equal(detectRenewalBridge(undefined), null, "server render");

    const { w, assigned } = fakeWindow({ __NEXUS_SHELL__: { tabs: [{ id: "bridge" }], active: "bridge", capabilities: ["renew-session"] } });
    const bridge = detectRenewalBridge(w);
    assert.equal(bridge?.kind, "travel-shell");
    const pending = bridge!.request();
    const requestId = new URL(assigned[0]).searchParams.get("request");
    assert.ok(assigned[0].startsWith(RENEW_REQUEST_URL + "?"));
    w!.dispatchEvent(new CustomEvent("nexus:session-renewal-result", { detail: { requestId, status: "deferred", retryAfterMs: 30000 } }));
    assert.deepEqual(await pending, { status: "deferred", retryAfterMs: 30000 });

    // A shell global without a tab roster is not the travel shell.
    assert.equal(detectRenewalBridge(fakeWindow({ __NEXUS_SHELL__: { active: "bridge" } }).w), null);
});

test("detectRenewalBridge: the Android shell counts only when it advertises the capability, and is asked through its message channel", () => {
    const posted: unknown[] = [];
    const win = window as unknown as Record<string, unknown>;
    const before = { shell: win.__NEXUS_MOBILE_SHELL__, rn: win.ReactNativeWebView };
    try {
        win.ReactNativeWebView = { postMessage: (s: string) => void posted.push(JSON.parse(s)) };
        win.__NEXUS_MOBILE_SHELL__ = { platform: "android", appVersion: "1.0", origin: window.location.origin, capabilities: ["badge"] };
        assert.equal(detectRenewalBridge(fakeWindow().w), null, "an older shell never gets a message it does not understand");

        win.__NEXUS_MOBILE_SHELL__ = { platform: "android", appVersion: "1.1", origin: window.location.origin, capabilities: ["badge", "renew-session"] };
        const bridge = detectRenewalBridge(fakeWindow().w);
        assert.equal(bridge?.kind, "mobile-shell");
        assert.equal(bridge!.request(), true);
        assert.deepEqual(posted, [{ type: "renew-session" }], "the page only asks; no credential crosses the seam");
    } finally {
        win.__NEXUS_MOBILE_SHELL__ = before.shell;
        win.ReactNativeWebView = before.rn;
    }
});

test("subscribeSessionRenewed hears the window event and the channel's `renewed` message only, and unsubscribes both", () => {
    FakeChannel.instances = [];
    const { w, listeners } = fakeWindow({ BroadcastChannel: FakeChannel });
    const calls: number[] = [];
    const off = subscribeSessionRenewed(() => calls.push(1), w);
    assert.equal(listeners.get(RENEWED_EVENT)?.size, 1);
    assert.equal(FakeChannel.instances.length, 1);
    assert.equal(FakeChannel.instances[0].name, SESSION_CHANNEL);

    w!.dispatchEvent(new Event(RENEWED_EVENT));
    assert.equal(calls.length, 1);
    FakeChannel.instances[0].onmessage!({ data: { type: "renewed" } } as MessageEvent);
    assert.equal(calls.length, 2);
    FakeChannel.instances[0].onmessage!({ data: { type: "something-else" } } as MessageEvent);
    FakeChannel.instances[0].onmessage!({ data: "renewed" } as MessageEvent);
    assert.equal(calls.length, 2, "only the structured `renewed` message counts");

    off();
    assert.equal(listeners.get(RENEWED_EVENT)?.size, 0);
    assert.equal(FakeChannel.instances[0].closed, true);
    w!.dispatchEvent(new Event(RENEWED_EVENT));
    assert.equal(calls.length, 2);

    // No BroadcastChannel (older WebKit): the window event alone still works.
    const plain = fakeWindow();
    const offPlain = subscribeSessionRenewed(() => calls.push(2), plain.w);
    plain.w!.dispatchEvent(new Event(RENEWED_EVENT));
    assert.equal(calls.at(-1), 2);
    offPlain();
});

test("announceSessionRenewed posts on the channel and pokes the opener directly; signInHref is same-origin", () => {
    FakeChannel.instances = [];
    const openerEvents: string[] = [];
    const { w } = fakeWindow({
        BroadcastChannel: FakeChannel,
        opener: { dispatchEvent: (e: Event) => void openerEvents.push(e.type) },
    });
    announceSessionRenewed(w);
    assert.equal(FakeChannel.instances.length, 1);
    assert.deepEqual(FakeChannel.instances[0].posted, [{ type: "renewed" }]);
    assert.equal(FakeChannel.instances[0].closed, true, "a one-shot channel");
    assert.deepEqual(openerEvents, [RENEWED_EVENT]);

    // No opener, no channel: nothing to do, nothing thrown.
    announceSessionRenewed(fakeWindow().w);

    assert.equal(signInHref(w), `https://nexus.example${SIGN_IN_RETURN_PATH}`);
});

test("openSignInWindow wraps the popup when the browser gives one, and reports null (never a fallback navigation) when it refuses", () => {
    const opens: unknown[][] = [];
    let closeCalls = 0;
    let focusCalls = 0;
    let closed = false;
    const popup = {
        get closed() {
            return closed;
        },
        close: () => {
            closeCalls += 1;
            closed = true;
        },
        focus: () => {
            focusCalls += 1;
        },
    };
    const { w, assigned } = fakeWindow({
        open: (...args: unknown[]) => {
            opens.push(args);
            return popup;
        },
    });
    const win = openSignInWindow("https://nexus.example/session/renewed", w);
    assert.ok(win);
    assert.deepEqual(opens, [["https://nexus.example/session/renewed", "nexus-sign-in", "popup=yes,width=560,height=720"]]);
    assert.equal(win!.closed, false);
    win!.focus();
    assert.equal(focusCalls, 1);
    win!.close();
    assert.equal(closeCalls, 1);
    assert.equal(win!.closed, true);
    assert.deepEqual(assigned, [], "opening a window never navigates this one");

    assert.equal(openSignInWindow("x", fakeWindow({ open: () => null }).w), null, "blocked");
    assert.equal(
        openSignInWindow("x", fakeWindow({ open: () => { throw new Error("denied"); } }).w),
        null,
        "a throwing open() is a blocked window, not a crash",
    );
    assert.equal(openSignInWindow("x", fakeWindow().w), null, "no open() at all");
    assert.equal(openSignInWindow("x", undefined), null, "server render");
});

test('old travel shells do not advertise renewal or send a no-op renewal request', () => {
    const { w, assigned } = fakeWindow({ __NEXUS_SHELL__: { tabs: [] } });
    assert.equal(detectRenewalBridge(w), null);
    assert.deepEqual(assigned, []);
});

test('native completion wait removes listeners on timeout or disposal', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { w, listeners } = fakeWindow({ __NEXUS_SHELL__: { tabs: [], capabilities: ['renew-session'] } });
    const bridge = detectRenewalBridge(w)!;
    try {
        const abort = new AbortController();
        const cancelled = bridge.request(abort.signal);
        assert.equal(listeners.get('nexus:session-renewal-result')?.size, 1);
        abort.abort();
        assert.deepEqual(await cancelled, { status: 'failed' });
        assert.equal(listeners.get('nexus:session-renewal-result')?.size, 0);
        const timedOut = bridge.request();
        t.mock.timers.tick(60_000);
        assert.deepEqual(await timedOut, { status: 'failed' });
        assert.equal(listeners.get('nexus:session-renewal-result')?.size, 0);
    } finally { t.mock.timers.reset(); }
});
