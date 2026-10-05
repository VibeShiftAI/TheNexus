/**
 * live-socket — ONE Socket.IO connection for the whole dashboard.
 *
 * Before this module every consumer that wanted socket traffic called `io()`
 * itself, so the chat provider and any live-state surface would each open
 * their own websocket to :4000. This is a refcounted module singleton:
 * `acquireLiveSocket()` returns the shared connection and a `release()`; the
 * socket is only torn down once the LAST holder releases it (after a short
 * linger, so a route transition that unmounts and immediately remounts a
 * holder does not churn the connection).
 *
 * Connection target mirrors what CortexProvider used to do inline:
 *   - local dev  → http://localhost:4000 (the Node API)
 *   - remote     → same origin; the Cloudflare tunnel has a path ingress rule
 *                  routing /socket.io/* straight to :4000.
 *
 * Recovery (2026-10-03): the socket reports its connect/disconnect/connect_error
 * to the shared connection lifecycle (`lib/connection-lifecycle`) and, when
 * the lifecycle confirms the API is reachable again (foreground return, network
 * back, backend restarted), it reconnects AT ONCE instead of waiting out the
 * 3s to 15s reconnection backoff. socket.io's engine closes itself on the
 * browser's `offline` event but listens for nothing on `online`, so without
 * this a laptop coming back from sleep sat on a dead socket for a full backoff
 * step. Teardown and the forced reconnect both close the socket ourselves,
 * which socket.io reports as "io client disconnect"; that is not a failure.
 */
"use client";

import { io, type Socket } from "socket.io-client";
import { getConnectionLifecycle } from "./connection-lifecycle";

const TEARDOWN_LINGER_MS = 5000;

let socket: Socket | null = null;
let holders = 0;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
let unbindLifecycle: (() => void) | null = null;

function socketUrl(): string | undefined {
    if (typeof window === "undefined") return undefined;
    const isLocal =
        window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    return isLocal ? "http://localhost:4000" : undefined; // undefined = same origin
}

/**
 * The shared socket, or null on the server (no window). Callers that only want
 * to peek — never to own — can use this; it does not affect the refcount.
 */
export function peekLiveSocket(): Socket | null {
    return socket;
}

/**
 * Reconnect the shared socket now if it is not connected. Safe at any point of
 * socket.io-client's reconnection state machine: `disconnect()` destroys the
 * manager (clearing a pending backoff timer and `_reconnecting`), then
 * `connect()` opens a fresh engine with `skipReconnect` reset, so automatic
 * reconnection keeps working afterwards. (Calling `manager.open()` during a
 * backoff instead leaves `_reconnecting` stuck and kills every later retry.)
 * Returns true when a reconnect was issued.
 */
export function reconnectLiveSocketNow(): boolean {
    if (!socket || socket.connected) return false;
    socket.disconnect();
    socket.connect();
    return true;
}

function bindLifecycle(s: Socket): () => void {
    const lifecycle = getConnectionLifecycle();
    const onConnect = () => lifecycle.noteTransportUp("socket");
    const onDisconnect = (reason: string) => {
        if (reason === "io client disconnect") return; // ours: teardown or forced reconnect
        lifecycle.noteTransportFailure("socket");
    };
    const onConnectError = () => lifecycle.noteTransportFailure("socket");
    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("connect_error", onConnectError);
    const offRecovered = lifecycle.onRecovered(() => {
        reconnectLiveSocketNow();
    });
    return () => {
        s.off("connect", onConnect);
        s.off("disconnect", onDisconnect);
        s.off("connect_error", onConnectError);
        offRecovered();
    };
}

export interface LiveSocketHandle {
    socket: Socket;
    release: () => void;
}

/**
 * Take a reference on the shared socket, creating it if needed. Safe to call
 * from React StrictMode double-effects: the second acquire simply bumps the
 * refcount and cancels any pending teardown.
 */
export function acquireLiveSocket(): LiveSocketHandle | null {
    if (typeof window === "undefined") return null;

    if (teardownTimer) {
        clearTimeout(teardownTimer);
        teardownTimer = null;
    }

    if (!socket) {
        socket = io(socketUrl() as string, {
            path: "/socket.io/",
            reconnectionAttempts: Infinity, // Backend restarts are normal (self_upgrade, launchd)
            reconnectionDelay: 3000,
            reconnectionDelayMax: 15000, // Back off to 15s max between retries
        });
        unbindLifecycle = bindLifecycle(socket);
    }

    holders += 1;
    const held = socket;
    let released = false;

    return {
        socket: held,
        release() {
            if (released) return;
            released = true;
            holders = Math.max(0, holders - 1);
            if (holders > 0) return;
            teardownTimer = setTimeout(() => {
                teardownTimer = null;
                if (holders > 0) return;
                unbindLifecycle?.();
                unbindLifecycle = null;
                socket?.disconnect();
                socket = null;
            }, TEARDOWN_LINGER_MS);
        },
    };
}
