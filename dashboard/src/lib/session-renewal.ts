/**
 * session-renewal: the supported ways a Nexus session comes back after the
 * Cloudflare Access edge starts refusing requests, and the seams the shared
 * connection lifecycle (`lib/connection-lifecycle`) uses to drive them.
 *
 * Two mechanisms exist, both documented by Cloudflare, neither reachable from
 * page JavaScript on its own:
 *
 *   1. Service-token exchange (the native shells). A request carrying the
 *      CF-Access-Client-Id / CF-Access-Client-Secret headers is answered with
 *      a fresh CF_Authorization cookie for the application's session length.
 *      The Windows travel shell does this at launch (desktop/src-tauri,
 *      `exchange_and_inject`) and, since 2026-10-03, again on request from
 *      this page (`nexus-shell://renew-session`, intercepted by the shell's
 *      navigation handler, so nothing leaves the document) and on a schedule.
 *      The Android shell can offer the same through its message channel
 *      (`{ type: "renew-session" }`) once it advertises the capability. The
 *      secret never reaches the page; the page only asks and then re-probes.
 *
 *   2. The login redirect flow (user sessions in a browser). When the
 *      application token expires, Access re-issues it without asking the
 *      user again as long as the global session is still valid, but only on
 *      a top-level navigation through the team domain. There is no refresh
 *      token and no fetch-based renewal (the team-domain cookie is not sent on
 *      cross-site subrequests, and WebKit blocks third-party cookies in
 *      frames). So the page opens the flow in a SEPARATE window aimed at
 *      `/session/renewed`, which announces itself and closes; this document,
 *      with every unsaved edit in it, stays exactly as it was. Travel shells
 *      advertise a native sign-in window in the same cookie profile. Blocked
 *      windows never fall back to document replacement.
 *
 * Nothing here holds, logs or forwards a credential.
 */
import { getMobileShell, postToShell } from "./mobile-shell";

/** Window event a shell (or the sign-in window, via the channel) fires once the session is renewed. */
export const RENEWED_EVENT = "nexus:session-renewed";
/** BroadcastChannel the sign-in window uses to reach the page that opened it. */
export const SESSION_CHANNEL = "nexus:session";
/** The travel shell intercepts this "navigation" and re-runs its service-token exchange. */
export const RENEW_REQUEST_URL = "nexus-shell://renew-session";
/** Where the sign-in window lands after the Access flow; the page there announces and closes. */
export const SIGN_IN_RETURN_PATH = "/session/renewed";
/** The Android shell capability that means `{ type: "renew-session" }` is understood. */
export const RENEW_SESSION_CAPABILITY = "renew-session";

export const RENEWAL_RESULT_EVENT = "nexus:session-renewal-result";
export const SIGN_IN_CLOSED_EVENT = "nexus:sign-in-closed";
export const NATIVE_REQUEST_TIMEOUT_MS = 60_000;
export type RenewalResult = { status: "renewed" | "failed" } | { status: "deferred"; retryAfterMs: number };
let requestSequence = 0;

export type RenewalBridgeKind = "travel-shell" | "mobile-shell";

/** A native shell that can renew the session without the page leaving. */
export interface RenewalBridge {
    kind: RenewalBridgeKind;
    /** Travel shells report completion/deferral; mobile bridges may acknowledge only dispatch. */
    request(signal?: AbortSignal): boolean | Promise<RenewalResult>;
}

/** The slice of a popup `Window` the lifecycle watches. */
export interface SignInWindow {
    readonly closed: boolean;
    close(): void;
    focus(): void;
}

type WindowLike = Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent"> & {
    location: Pick<Location, "origin" | "assign">;
    open?: Window["open"];
    opener?: unknown;
    BroadcastChannel?: typeof BroadcastChannel;
    __NEXUS_SHELL__?: unknown;
};

function defaultWindow(): WindowLike | undefined {
    return typeof window === "undefined" ? undefined : (window as unknown as WindowLike);
}

export function isTravelShell(w: WindowLike | undefined = defaultWindow()): boolean {
    const shell = w?.__NEXUS_SHELL__ as { tabs?: unknown } | undefined;
    return !!shell && Array.isArray(shell.tabs);
}

function travelCapability(w: WindowLike, capability: string): boolean {
    const shell = w.__NEXUS_SHELL__ as { capabilities?: unknown } | undefined;
    return isTravelShell(w) && Array.isArray(shell?.capabilities) && shell.capabilities.includes(capability);
}

/**
 * The shell this page runs in, if it can renew the session: the Windows
 * travel shell (which injects `window.__NEXUS_SHELL__` into hosted tabs) or
 * the Android shell when it advertises the capability. Null in a browser.
 */
export function detectRenewalBridge(w: WindowLike | undefined = defaultWindow()): RenewalBridge | null {
    if (!w) return null;
    if (travelCapability(w, RENEW_SESSION_CAPABILITY)) {
        return {
            kind: "travel-shell",
            request: (signal) => new Promise<RenewalResult>((resolve) => {
                const requestId = `${Date.now()}-${++requestSequence}`;
                const finish = (result: RenewalResult) => {
                    clearTimeout(timeout);
                    signal?.removeEventListener("abort", onAbort);
                    w.removeEventListener(RENEWAL_RESULT_EVENT, onResult);
                    resolve(result);
                };
                const onResult = (event: Event) => {
                    const detail = (event as CustomEvent).detail;
                    if (detail?.requestId !== requestId) return;
                    if (detail.status === "renewed" || detail.status === "failed") finish({ status: detail.status });
                    else if (detail.status === "deferred" && Number.isFinite(detail.retryAfterMs)) {
                        finish({ status: "deferred", retryAfterMs: Math.max(1_000, Math.min(60_000, detail.retryAfterMs)) });
                    }
                };
                const onAbort = () => finish({ status: "failed" });
                const timeout = setTimeout(onAbort, NATIVE_REQUEST_TIMEOUT_MS);
                w.addEventListener(RENEWAL_RESULT_EVENT, onResult);
                signal?.addEventListener("abort", onAbort, { once: true });
                if (signal?.aborted) { onAbort(); return; }
                try { w.location.assign(`${RENEW_REQUEST_URL}?request=${requestId}`); }
                catch { finish({ status: "failed" }); }
            }),
        };
    }
    const mobile = getMobileShell();
    if (mobile && Array.isArray(mobile.capabilities) && mobile.capabilities.includes(RENEW_SESSION_CAPABILITY)) {
        return { kind: "mobile-shell", request: () => postToShell({ type: "renew-session" }) };
    }
    return null;
}

/**
 * Hear "the session was renewed" from a shell (window event) or from the
 * sign-in window (BroadcastChannel, same origin). Returns the unsubscribe.
 */
export function subscribeSessionRenewed(cb: () => void, w: WindowLike | undefined = defaultWindow()): () => void {
    if (!w) return () => {};
    const onEvent = () => cb();
    w.addEventListener(RENEWED_EVENT, onEvent);
    let channel: BroadcastChannel | null = null;
    if (typeof w.BroadcastChannel === "function") {
        try {
            channel = new w.BroadcastChannel(SESSION_CHANNEL);
            channel.onmessage = (e: MessageEvent) => {
                if (e.data && typeof e.data === "object" && (e.data as { type?: unknown }).type === "renewed") cb();
            };
        } catch {
            channel = null;
        }
    }
    return () => {
        w.removeEventListener(RENEWED_EVENT, onEvent);
        try {
            channel?.close();
        } catch {
            /* already closed */
        }
    };
}

/**
 * Called by `/session/renewed` once the Access flow has brought it back:
 * tell the page that opened the window (channel, and the opener directly
 * when reachable) that a probe will pass now.
 */
export function announceSessionRenewed(w: WindowLike | undefined = defaultWindow()): void {
    if (!w) return;
    if (typeof w.BroadcastChannel === "function") {
        try {
            const channel = new w.BroadcastChannel(SESSION_CHANNEL);
            channel.postMessage({ type: "renewed" });
            channel.close();
        } catch {
            /* best-effort */
        }
    }
    try {
        const opener = w.opener as { dispatchEvent?: (e: Event) => boolean } | null | undefined;
        opener?.dispatchEvent?.(new Event(RENEWED_EVENT));
    } catch {
        /* cross-origin or gone */
    }
}

/** The URL the sign-in window is opened at (same origin; Access brings it back here). */
export function signInHref(w: WindowLike | undefined = defaultWindow()): string {
    return `${w?.location.origin ?? ""}${SIGN_IN_RETURN_PATH}`;
}

/**
 * Open the sign-in flow in its own window so this document is untouched.
 * Travel shells use a native window in the same profile. An unsupported
 * shell or blocked popup returns null; the caller keeps the original page.
 */
export function openSignInWindow(href: string, w: WindowLike | undefined = defaultWindow()): SignInWindow | null {
    if (!w) return null;
    if (isTravelShell(w)) {
        // Old shells send window.open to a different cookie profile. Never
        // replace this document or pretend that external login signs it in.
        if (!travelCapability(w, "sign-in-window")) return null;
        let closed = false;
        const onClosed = () => { closed = true; w.removeEventListener(SIGN_IN_CLOSED_EVENT, onClosed); };
        w.addEventListener(SIGN_IN_CLOSED_EVENT, onClosed);
        const command = (action: string) => w.location.assign(`nexus-shell://${action}`);
        try { command("sign-in"); } catch { onClosed(); return null; }
        return {
            get closed() { return closed; },
            close() { if (!closed) { command("close-sign-in"); onClosed(); } },
            focus() { if (!closed) command("sign-in"); },
        };
    }
    if (typeof w.open !== "function") return null;
    let win: Window | null = null;
    try {
        win = w.open(href, "nexus-sign-in", "popup=yes,width=560,height=720");
    } catch {
        win = null;
    }
    if (!win) return null;
    const handle = win;
    return {
        get closed() {
            try {
                return handle.closed;
            } catch {
                return true;
            }
        },
        close() {
            try {
                handle.close();
            } catch {
                /* already gone */
            }
        },
        focus() {
            try {
                handle.focus();
            } catch {
                /* not focusable */
            }
        },
    };
}
