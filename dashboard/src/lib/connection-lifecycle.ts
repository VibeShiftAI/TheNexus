/**
 * connection-lifecycle: ONE recovery coordinator for every live connection
 * the dashboard holds (the shared Socket.IO socket, the Praxis SSE relay
 * stream, and the pollers behind the live surfaces).
 *
 * Why (2026-10-03, task 60c8716a): the transports each recovered on their own
 * schedule, or not at all. A backend restart behind the Next `/api` proxy
 * answers the EventSource with a 500, which the EventSource spec treats as a
 * permanent failure (readyState CLOSED, no retry), so the SSE half stayed dead
 * until a manual reload. Nothing reacted to the window coming back to the
 * foreground, to a network return, or to a sleep/wake gap, so the Ops surfaces
 * sat on whatever they held until a 20s to 60s timer fired, and a Cloudflare
 * Access session that had expired produced only silent JSON parse errors.
 *
 * What this module does:
 *   - Listens for the wake signals (visibilitychange, focus, online, pageshow,
 *     a timer that arrives far later than scheduled = sleep or suspension) and
 *     accepts failure/up reports from the transports.
 *   - Coalesces them into ONE bounded recovery run at a time: a cheap probe of
 *     `/api/health` with redirects left unfollowed, so a Cloudflare Access
 *     bounce (an opaque redirect to the team domain) is distinguishable from a
 *     backend that is simply down.
 *   - On an Access bounce, first tries the SUPPORTED automatic renewal when a
 *     native shell is present (`lib/session-renewal`): the shell re-runs its
 *     service-token exchange and plants a fresh session cookie while this
 *     document stays put; bounded to three attempts with growing waits, each
 *     followed by a re-probe. Only when no shell can renew, or renewal did not
 *     take, does the phase become `reauth`.
 *   - Publishes an honest phase: `live`, `recovering`, `renewing`, `offline`
 *     (retrying with backoff, capped), or `reauth` (interactive sign-in is
 *     required; the page never reloads itself). In `reauth` the operator gets
 *     one explicit action that opens the Access flow in a SEPARATE window, so
 *     every unsaved edit in this document survives; the window announces the
 *     renewed session and closes. If a window is blocked, the page remains
 *     mounted while the operator enables popups or updates an older shell.
 *   - Tells subscribers "we are back" when a probe passes after an outage or
 *     after a wake signal, so the live state provider can invalidate every
 *     domain and the surfaces re-fetch authoritative data instead of trusting
 *     what they held, the socket reconnects at once instead of waiting out its
 *     backoff, and the SSE store reopens a source the browser gave up on. A
 *     transport that fails while the API probes healthy gets no such
 *     broadcast: it recovers on its own backoff, and broadcasting would turn
 *     one surface's failing fetch into a deck-wide refetch loop.
 *
 * No framework imports: the React side binds through `subscribe/getState`.
 * Every dependency (clock, probe, navigation, event target, renewal bridge,
 * sign-in window) is injectable so the behavior is unit-testable without a
 * browser. No credential is ever held, logged or forwarded here.
 */
import {
    detectRenewalBridge,
    isTravelShell,
    openSignInWindow,
    signInHref as defaultSignInHref,
    subscribeSessionRenewed,
    type RenewalBridge,
    type RenewalBridgeKind,
    type SignInWindow,
} from "./session-renewal";

export type { RenewalBridge, RenewalBridgeKind, SignInWindow } from "./session-renewal";

export type LivePhase = "live" | "recovering" | "renewing" | "offline" | "reauth";

export type RecoverySignal =
    | "visible"
    | "focus"
    | "online"
    | "pageshow"
    | "clock-jump"
    | "transport-failure"
    | "transport-up"
    | "retry"
    | "renewal-retry"
    | "renewed"
    | "manual";

export type ProbeOutcome = "ok" | "reauth" | "unreachable";

export type TransportName = "socket" | "sse" | "fetch";

/** Where the explicit sign-in action stands. */
export type SignInState = "idle" | "window-open" | "blocked";

/** What `reauthenticate()` did. */
export type ReauthResult = "opened" | "blocked" | "noop";

export interface ConnectionState {
    phase: LivePhase;
    /** Epoch ms when the current phase began. */
    since: number;
    /** Epoch ms of the last probe that came back `ok` (0 = never probed). */
    lastLiveAt: number;
    /** Consecutive `unreachable` probes in the current outage. */
    failures: number;
    /** Total probes run (diagnostics; tests assert there is no storm). */
    probes: number;
    /** The signal that started the latest recovery run. */
    lastSignal: RecoverySignal | null;
    /** True once the operator was sent to sign in from this tab (loop guard). */
    reauthAttempted: boolean;
    /** Automatic renewal attempts in the current outage (bounded). */
    renewals: number;
    /** The native shell that can renew the session, if any. */
    renewalKind: RenewalBridgeKind | null;
    /** The explicit sign-in action's state. */
    signIn: SignInState;
}

export interface LifecycleDeps {
    now: () => number;
    probe: () => Promise<ProbeOutcome>;
    /** Where wake signals come from; `undefined` on the server (no listeners). */
    target: (Window & typeof globalThis) | undefined;
    isVisible: () => boolean;
    currentHref: () => string;
    /** Survives the sign-in round trip so the banner can say "still refused". */
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
    /** A native shell that renews the session without the page leaving; null in a browser. */
    renewal: RenewalBridge | null;
    /** Opens the Access flow in its own window; null when refused. */
    openSignIn: (href: string) => SignInWindow | null;
    /** Where that window is aimed (same origin). */
    signInHref: () => string;
    /** "The session was renewed" from a shell or the sign-in window. */
    subscribeRenewed: (cb: () => void) => () => void;
}

export interface ConnectionLifecycle {
    /** Attach the wake listeners (refcounted). Returns the matching release. */
    start(): () => void;
    /** Ask for a recovery run; coalesced, single-flight, rate-limited. */
    signal(reason: RecoverySignal): void;
    /** A transport dropped or could not connect. Probes at most every 10s, only while `live`. */
    noteTransportFailure(source: TransportName): void;
    /** A transport (re)connected. Probes only if we were not `live`. */
    noteTransportUp(source: TransportName): void;
    /** Fires when a probe passes after a non-live phase or after a wake signal. */
    onRecovered(cb: (reason: RecoverySignal) => void): () => void;
    subscribe(listener: () => void): () => void;
    getState(): ConnectionState;
    /**
     * The explicit action for an expired session: open the Access flow in a
     * separate window aimed at `/session/renewed`, leaving this document and
     * everything typed in it untouched. When the window closes or announces
     * itself, a probe runs. Only acts in the `reauth` phase. Never automatic.
     */
    reauthenticate(): ReauthResult;
    /** Compatibility action: retry the separate window after a popup was blocked. */
    signInHere(): boolean;
    /** Tear everything down (tests, HMR). */
    dispose(): void;
}

/** Wake signals inside this window collapse into one recovery run. */
export const COALESCE_MS = 500;
/** A wake signal this soon after a successful probe, while live, is redundant. */
export const MIN_RECOVERY_GAP_MS = 10_000;
/** Transport failure reports probe at most this often. */
export const TRANSPORT_FAILURE_THROTTLE_MS = 10_000;
/** While `reauth`, wake signals re-probe at most this often (no storm). */
export const REAUTH_REPROBE_MIN_MS = 30_000;
/** Offline retry backoff: base, cap. */
export const RETRY_BASE_MS = 3_000;
export const RETRY_MAX_MS = 30_000;
/** The suspension detector: a tick this late means the page was asleep. */
export const CLOCK_TICK_MS = 15_000;
export const CLOCK_JUMP_MS = 45_000;
export const PROBE_TIMEOUT_MS = 6_000;
/** The probe target: cheapest JSON route the API serves, same path on every client. */
export const PROBE_PATH = "/api/health";
/** Automatic renewal through a shell: at most this many attempts per outage. */
export const MAX_RENEWAL_ATTEMPTS = 3;
/** Maximum continuous wait for another native exchange and its cooldown. */
export const MAX_RENEWAL_DEFERRAL_MS = 120_000;
/** How long each attempt waits for the shell before re-probing (a `renewed` event cuts it short). */
export const RENEWAL_WAIT_MS: readonly number[] = [2_000, 4_000, 8_000];
/** How often an open sign-in window is checked for having closed. */
export const SIGN_IN_WINDOW_POLL_MS = 1_000;

const REAUTH_FLAG_KEY = "nexus:reauth-attempted-at";
/** A sign-in attempt older than this no longer counts as "just tried". */
const REAUTH_FLAG_TTL_MS = 2 * 60_000;

const WAKE_SIGNALS: ReadonlySet<RecoverySignal> = new Set([
    "visible",
    "focus",
    "online",
    "pageshow",
    "clock-jump",
    "renewed",
    "manual",
]);

/** Signals that bypass the `reauth` re-probe rate limit: the operator or a shell says things changed. */
const URGENT_SIGNALS: ReadonlySet<RecoverySignal> = new Set(["manual", "renewed"]);

/**
 * The default probe. `redirect: "manual"` is the whole trick: an expired
 * Cloudflare Access session answers every request with a 302 to the team
 * domain, which a followed fetch turns into an HTML login page and a JSON
 * parse error somewhere far from here. Unfollowed, it is an `opaqueredirect`
 * and we can name it. A backend that is down answers 500 from the Next proxy
 * or 502 from the tunnel; both read as `unreachable`.
 */
export async function probeApiHealth(fetchImpl: typeof fetch = fetch): Promise<ProbeOutcome> {
    try {
        const res = await fetchImpl(PROBE_PATH, {
            cache: "no-store",
            credentials: "same-origin",
            redirect: "manual",
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.type === "opaqueredirect") return "reauth";
        if (res.redirected) {
            try {
                if (new URL(res.url).hostname.endsWith(".cloudflareaccess.com")) return "reauth";
            } catch {
                /* unparsable url: fall through to the status check */
            }
        }
        if (res.status === 401 || res.status === 403) return "reauth";
        return res.ok ? "ok" : "unreachable";
    } catch {
        return "unreachable";
    }
}

/**
 * Does a failed fetch point at the connection/session layer rather than at
 * the API's own answer? The Nexus API always answers JSON, including its
 * errors (a 502 `{ error }` when Praxis is down behind a healthy Nexus). A
 * thrown fetch (network, abort), an opaque redirect (Access bounce) or a
 * non-JSON body (the Next proxy's plain-text 500 while :4000 restarts, the
 * tunnel's HTML 502, an Access login page) is the connection failing. Only
 * those should wake the shared lifecycle; the API's own error is the
 * surface's to show.
 */
export function looksLikeTransportFailure(res: ResponseLike | null | undefined): boolean {
    if (!res) return true;
    if (res.type === "opaqueredirect") return true;
    const contentType = contentTypeOf(res);
    // No header access at all (a minimal fake in tests): nothing to blame on
    // the connection. A real Response always has `headers`.
    if (contentType === undefined) return false;
    return !(contentType ?? "").toLowerCase().includes("application/json");
}

/** The slice of `Response` the helpers below read; test fakes may omit any of it. */
export type ResponseLike = Partial<Pick<Response, "type" | "headers">>;

/**
 * `undefined` when the response exposes no headers (a test fake), `null`
 * when headers exist but carry no content-type, else the header value.
 */
function contentTypeOf(res: ResponseLike): string | null | undefined {
    const headers = res.headers;
    if (!headers || typeof headers.get !== "function") return undefined;
    return headers.get("content-type");
}

/**
 * Is this the JSON the API always answers with? A 200 whose body is an Access
 * login page or a proxy error page must not reach `res.json()` and surface as
 * a parse error. Responses that expose no headers (test fakes) pass.
 */
export function responseLooksJson(res: ResponseLike): boolean {
    const contentType = contentTypeOf(res);
    if (contentType === undefined) return true;
    return (contentType ?? "").toLowerCase().includes("application/json");
}

function defaultDeps(): LifecycleDeps {
    const hasWindow = typeof window !== "undefined";
    let storage: LifecycleDeps["storage"] = null;
    if (hasWindow) {
        try {
            storage = window.sessionStorage;
        } catch {
            storage = null;
        }
    }
    return {
        now: () => Date.now(),
        probe: () => probeApiHealth(),
        target: hasWindow ? window : undefined,
        isVisible: () => (typeof document === "undefined" ? true : document.visibilityState !== "hidden"),
        currentHref: () => (hasWindow ? window.location.href : "/"),
        storage,
        renewal: hasWindow ? detectRenewalBridge() : null,
        openSignIn: (href) => openSignInWindow(href),
        signInHref: () => defaultSignInHref(),
        subscribeRenewed: (cb) => subscribeSessionRenewed(cb),
    };
}

export function createConnectionLifecycle(overrides: Partial<LifecycleDeps> = {}): ConnectionLifecycle {
    const deps: LifecycleDeps = { ...defaultDeps(), ...overrides };

    const readReauthFlag = (): boolean => {
        try {
            const raw = deps.storage?.getItem(REAUTH_FLAG_KEY);
            const at = raw ? Number(raw) : NaN;
            const age = deps.now() - at;
            return Number.isFinite(at) && age >= 0 && age < REAUTH_FLAG_TTL_MS;
        } catch {
            return false;
        }
    };
    const rememberReauthAttempt = () => {
        try {
            deps.storage?.setItem(REAUTH_FLAG_KEY, String(deps.now()));
        } catch {
            /* storage unavailable: the loop guard is best-effort */
        }
    };
    const clearReauthFlag = () => {
        try {
            deps.storage?.removeItem(REAUTH_FLAG_KEY);
        } catch {
            /* best-effort */
        }
    };

    let state: ConnectionState = {
        phase: "live",
        since: deps.now(),
        lastLiveAt: 0,
        failures: 0,
        probes: 0,
        lastSignal: null,
        reauthAttempted: readReauthFlag(),
        renewals: 0,
        renewalKind: deps.renewal?.kind ?? (isTravelShell() ? "travel-shell" : null),
        signIn: "idle",
    };

    const listeners = new Set<() => void>();
    const recoveredListeners = new Set<(reason: RecoverySignal) => void>();
    let holders = 0;
    let detach: (() => void) | null = null;
    let disposed = false;
    const renewalAbort = new AbortController();

    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let clockTimer: ReturnType<typeof setInterval> | null = null;
    let signInTimer: ReturnType<typeof setInterval> | null = null;
    let signInWindow: SignInWindow | null = null;
    let pendingReason: RecoverySignal | null = null;
    let inFlight: Promise<void> | null = null;
    let queuedReason: RecoverySignal | null = null;
    let renewalNotBefore = 0;
    let renewalDeferredAt: number | null = null;
    let lastOkAt = 0;
    let lastTransportProbeAt = -Infinity;
    let lastReauthProbeAt = -Infinity;

    function publish(patch: Partial<ConnectionState>) {
        state = { ...state, ...patch };
        for (const fn of listeners) fn();
    }

    function setPhase(phase: LivePhase, extra: Partial<ConnectionState> = {}) {
        if (state.phase === phase) {
            if (Object.keys(extra).length) publish(extra);
            return;
        }
        publish({ phase, since: deps.now(), ...extra });
    }

    function clearRetry() {
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
    }

    function scheduleRetry() {
        clearRetry();
        if (disposed) return;
        // A hidden page does not retry on a timer; the next `visible` signal
        // probes immediately instead. Keeps a backgrounded tab quiet.
        if (!deps.isVisible()) return;
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, state.failures - 1));
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void runRecovery("retry");
        }, delay);
    }

    /** After asking a shell to renew: give it this long, then re-probe (a `renewed` event cuts it short). */
    function scheduleRenewalProbe(attempt: number, wait?: number) {
        clearRetry();
        if (disposed) return;
        const delay = wait ?? RENEWAL_WAIT_MS[Math.min(attempt, RENEWAL_WAIT_MS.length) - 1];
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void runRecovery("renewal-retry");
        }, delay);
    }

    function stopWatchingSignIn() {
        if (signInTimer) {
            clearInterval(signInTimer);
            signInTimer = null;
        }
    }

    function watchSignInWindow() {
        stopWatchingSignIn();
        signInTimer = setInterval(() => {
            if (!signInWindow || !signInWindow.closed) return;
            // The operator finished (the page there announced and closed) or
            // gave up: either way, one probe tells which.
            stopWatchingSignIn();
            signInWindow = null;
            publish({ signIn: "idle" });
            requestRecovery("renewed");
        }, SIGN_IN_WINDOW_POLL_MS);
    }

    async function runRecovery(reason: RecoverySignal): Promise<void> {
        if (disposed) return;
        if (inFlight) {
            // Single flight: remember that another run was wanted, run once after.
            queuedReason = reason;
            return inFlight;
        }
        clearRetry();
        const wasLive = state.phase === "live";
        if (wasLive) setPhase("recovering", { lastSignal: reason });
        else publish({ lastSignal: reason });
        inFlight = (async () => {
            let outcome: ProbeOutcome;
            try {
                outcome = await deps.probe();
            } catch {
                outcome = "unreachable";
            }
            if (disposed) return;
            const now = deps.now();
            const probes = state.probes + 1;
            if (outcome === "ok") {
                lastOkAt = now;
                renewalDeferredAt = null;
                renewalNotBefore = 0;
                if (state.reauthAttempted) clearReauthFlag();
                if (signInWindow) {
                    // The session is back; a sign-in window still open has done its job.
                    stopWatchingSignIn();
                    signInWindow.close();
                    signInWindow = null;
                }
                setPhase("live", {
                    lastLiveAt: now,
                    failures: 0,
                    probes,
                    reauthAttempted: false,
                    renewals: 0,
                    signIn: "idle",
                });
                // Back after an outage, or awake after a gap: nothing held is
                // known to be current. A transport failing while the API is
                // healthy is that transport's own business (see module doc).
                if (!wasLive || WAKE_SIGNALS.has(reason)) {
                    for (const fn of recoveredListeners) fn(reason);
                }
            } else if (outcome === "reauth") {
                lastReauthProbeAt = now;
                const bridge = deps.renewal;
                if (bridge && state.renewals < MAX_RENEWAL_ATTEMPTS) {
                    // Supported automatic renewal first: the shell re-runs its
                    // service-token exchange while this document stays put.
                    if (now < renewalNotBefore) {
                        scheduleRenewalProbe(Math.max(1, state.renewals), renewalNotBefore - now);
                        return;
                    }
                    const attempt = state.renewals + 1;
                    setPhase("renewing", { failures: 0, probes });
                    let result;
                    try { result = await bridge.request(renewalAbort.signal); }
                    catch { result = { status: "failed" as const }; }
                    if (disposed) return;
                    if (typeof result === "object" && result.status === "deferred") {
                        // Native did no exchange. Respect its gate without
                        // consuming the bounded exchange budget. A wedged
                        // native process still has a bounded waiting budget.
                        renewalDeferredAt ??= deps.now();
                        if (deps.now() - renewalDeferredAt >= MAX_RENEWAL_DEFERRAL_MS) { setPhase("reauth"); return; }
                        renewalNotBefore = deps.now() + Math.max(1_000, Math.min(60_000, result.retryAfterMs));
                        scheduleRenewalProbe(attempt, renewalNotBefore - deps.now());
                    } else {
                        renewalDeferredAt = null;
                        publish({ renewals: attempt });
                        if (result === false) setPhase("reauth", { failures: 0, probes });
                        else {
                            const delay = typeof result === "object" && result.status === "renewed" ? 0 : RENEWAL_WAIT_MS[attempt - 1];
                            renewalNotBefore = deps.now() + delay;
                            scheduleRenewalProbe(attempt, delay);
                        }
                    }
                } else {
                    setPhase("reauth", { failures: 0, probes });
                }
            } else {
                setPhase("offline", { failures: state.failures + 1, probes });
                scheduleRetry();
            }
        })().finally(() => {
            inFlight = null;
            if (queuedReason && !disposed) {
                const next = queuedReason;
                queuedReason = null;
                // One follow-up at most; `requestRecovery` drops it when the
                // verdict we just reached already answers it.
                requestRecovery(next);
            }
        });
        return inFlight;
    }

    function requestRecovery(reason: RecoverySignal) {
        if (disposed) return;
        const now = deps.now();
        if (reason === "online" && state.phase === "offline") {
            // A real offline-to-online transition starts a new bounded
            // episode; ordinary focus/reauth probes do not replenish it.
            renewalDeferredAt = null;
            publish({ renewals: 0 });
        }
        if (state.phase === "reauth" && !URGENT_SIGNALS.has(reason) && now - lastReauthProbeAt < REAUTH_REPROBE_MIN_MS) return;
        if (state.phase === "live" && WAKE_SIGNALS.has(reason) && lastOkAt > 0 && now - lastOkAt < MIN_RECOVERY_GAP_MS) return;
        // Coalesce: visible + focus + online routinely fire within a few hundred ms.
        if (!pendingReason || WAKE_SIGNALS.has(reason)) pendingReason = reason;
        if (coalesceTimer) return;
        coalesceTimer = setTimeout(() => {
            coalesceTimer = null;
            const r = pendingReason ?? reason;
            pendingReason = null;
            void runRecovery(r);
        }, COALESCE_MS);
    }

    function attach() {
        const target = deps.target;
        if (!target || detach) return;
        const doc = target.document;
        const onVisibility = () => {
            if (deps.isVisible()) requestRecovery("visible");
        };
        const onFocus = () => requestRecovery("focus");
        const onOnline = () => requestRecovery("online");
        const onOffline = () => {
            // The browser knows the network is gone: say so at once, and do
            // not burn probes until it says `online` or the operator returns.
            clearRetry();
            setPhase("offline");
        };
        const onPageShow = (e: Event) => {
            if ((e as PageTransitionEvent).persisted) requestRecovery("pageshow");
        };
        doc?.addEventListener("visibilitychange", onVisibility);
        target.addEventListener("focus", onFocus);
        target.addEventListener("online", onOnline);
        target.addEventListener("offline", onOffline);
        target.addEventListener("pageshow", onPageShow);
        const offRenewed = deps.subscribeRenewed(() => requestRecovery("renewed"));

        let lastTick = deps.now();
        clockTimer = setInterval(() => {
            const now = deps.now();
            const late = now - lastTick - CLOCK_TICK_MS;
            lastTick = now;
            if (late > CLOCK_JUMP_MS) requestRecovery("clock-jump");
        }, CLOCK_TICK_MS);

        detach = () => {
            doc?.removeEventListener("visibilitychange", onVisibility);
            target.removeEventListener("focus", onFocus);
            target.removeEventListener("online", onOnline);
            target.removeEventListener("offline", onOffline);
            target.removeEventListener("pageshow", onPageShow);
            offRenewed();
            if (clockTimer) clearInterval(clockTimer);
            clockTimer = null;
            detach = null;
        };
    }

    function reauthenticate(): ReauthResult {
        if (disposed || state.phase !== "reauth") return "noop";
        rememberReauthAttempt();
        if (signInWindow && !signInWindow.closed) {
            // Already open: bring it forward rather than opening a second one.
            signInWindow.focus();
            publish({ reauthAttempted: true, signIn: "window-open" });
            return "opened";
        }
        const win = deps.openSignIn(deps.signInHref());
        if (!win) {
            publish({ reauthAttempted: true, signIn: "blocked" });
            return "blocked";
        }
        signInWindow = win;
        publish({ reauthAttempted: true, signIn: "window-open" });
        watchSignInWindow();
        return "opened";
    }

    return {
        start() {
            if (disposed) return () => {};
            holders += 1;
            attach();
            let released = false;
            return () => {
                if (released) return;
                released = true;
                holders = Math.max(0, holders - 1);
                if (holders === 0) detach?.();
            };
        },
        signal(reason) {
            if (reason === "manual" && state.phase === "reauth") {
                renewalDeferredAt = null;
                publish({ renewals: 0 });
            }
            requestRecovery(reason);
        },
        noteTransportFailure() {
            if (disposed) return;
            // Only a failure out of a live state starts a run. While we are
            // already recovering, renewing, offline (the retry timer owns the
            // cadence) or waiting on the operator, more reports add nothing.
            if (state.phase !== "live") return;
            const now = deps.now();
            if (now - lastTransportProbeAt < TRANSPORT_FAILURE_THROTTLE_MS) return;
            lastTransportProbeAt = now;
            requestRecovery("transport-failure");
        },
        noteTransportUp() {
            if (disposed) return;
            if (state.phase === "live") return;
            requestRecovery("transport-up");
        },
        onRecovered(cb) {
            recoveredListeners.add(cb);
            return () => {
                recoveredListeners.delete(cb);
            };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getState() {
            return state;
        },
        reauthenticate,
        signInHere() {
            if (disposed || state.phase !== "reauth") return false;
            // Compatibility entry point for existing consumers: retry the
            // separate sign-in window. Never destroy unsent editor state.
            return reauthenticate() === "opened";
        },
        dispose() {
            disposed = true;
            renewalAbort.abort();
            if (coalesceTimer) clearTimeout(coalesceTimer);
            coalesceTimer = null;
            clearRetry();
            stopWatchingSignIn();
            signInWindow?.close();
            signInWindow = null;
            detach?.();
            listeners.clear();
            recoveredListeners.clear();
            holders = 0;
        },
    };
}

let singleton: ConnectionLifecycle | null = null;

/** The app-wide coordinator (created lazily; safe to call during SSR). */
export function getConnectionLifecycle(): ConnectionLifecycle {
    if (!singleton) singleton = createConnectionLifecycle();
    return singleton;
}

/** Test seam: swap the shared instance (e.g. for a provider test). */
export function __setConnectionLifecycleForTests(instance: ConnectionLifecycle | null): void {
    singleton = instance;
}
