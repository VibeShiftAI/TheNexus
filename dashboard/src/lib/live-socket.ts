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
 */
"use client";

import { io, type Socket } from "socket.io-client";

const TEARDOWN_LINGER_MS = 5000;

let socket: Socket | null = null;
let holders = 0;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;

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
                socket?.disconnect();
                socket = null;
            }, TEARDOWN_LINGER_MS);
        },
    };
}
