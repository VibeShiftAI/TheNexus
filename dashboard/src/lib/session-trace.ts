/**
 * Passive, redacted session trace for the dashboard proxy (2026-09-25, task
 * 5fbeff4a).
 *
 * Why: Robert's Windows travel shell reaches this dashboard only through the
 * Cloudflare tunnel, and Cloudflare forwards the session's application token
 * (`Cf-Access-Jwt-Assertion`) on every proxied request. The Nexus API child
 * that refuses his chat turns still runs pre-change code and cannot say which
 * claim check fails until it is reloaded, which this executor may not do. The
 * dashboard, served live by `next dev`, can: on each page load it names the
 * session's kind and how its claims relate to the operator pins, in fixed
 * words only, so the real session becomes attributable in praxis.log without
 * a reload and without asking Robert to sign in or open anything.
 *
 * The line carries no claim value, no address, no Client ID, no token and no
 * path: only fixed kinds, `present`/`absent`, `match`/`mismatch`/`unpinned`/
 * `absent`/`n/a`, the form of the audience claim, the fixed profile words
 * (2026-09-26, after the shell's session read `check=audience` with the
 * right pin), and a coarse client family from the user agent. It is written
 * at most once per distinct reading per TRACE_WINDOW_MS. Nothing here
 * verifies a token or confers authority.
 */

import { compareAssertion, type AssertionComparison, type OperatorPins } from "./session-check";

export type ClientFamily = "windows" | "android" | "ios" | "mac" | "other";

export const TRACE_WINDOW_MS = 10 * 60 * 1000;
const STATE_LIMIT = 64;

export interface HeaderReader {
    get(name: string): string | null;
}

export interface TraceState {
    lastLogged: Map<string, number>;
}

export function createTraceState(): TraceState {
    return { lastLogged: new Map() };
}

/** Coarse client family: the travel shell is a WebView2 on Windows, the phone app an Android WebView, the Mac app a WKWebView. */
export function clientFamily(userAgent: string | null | undefined): ClientFamily {
    const ua = typeof userAgent === "string" ? userAgent : "";
    if (/Android/i.test(ua)) return "android";
    if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
    if (/Windows NT/i.test(ua)) return "windows";
    if (/Macintosh/i.test(ua)) return "mac";
    return "other";
}

/** The operator pins as the dashboard process sees them (next.config.ts loads the repo .env). Names only; values are compared, never copied out. */
export function pinsFromEnv(env: Record<string, string | undefined>): OperatorPins {
    return {
        operatorEmail: env.NEXUS_OPERATOR_EMAIL ?? null,
        audience: env.NEXUS_OPERATOR_ACCESS_AUD ?? null,
        issuer: env.NEXUS_OPERATOR_ACCESS_ISSUER ?? null,
    };
}

export function formatTrace(client: ClientFamily, comparison: AssertionComparison): string {
    if (!comparison.assertionPresent) return `[SessionCheck] via=proxy client=${client} assertion=absent kind=none`;
    const expired = comparison.expired === null ? "unknown" : comparison.expired ? "yes" : "no";
    return `[SessionCheck] via=proxy client=${client} assertion=present kind=${comparison.kind}`
        + ` email=${comparison.emailPresent ? "present" : "absent"} expired=${expired}`
        + ` emailPin=${comparison.emailPin} audience=${comparison.audience} audShape=${comparison.audienceShape} issuer=${comparison.issuer}`
        + ` type=${comparison.tokenType} sub=${comparison.subject} nbf=${comparison.nbf}`;
}

/** The fixed trace line for one request. */
export function describeRequestSession(headers: HeaderReader, pins: OperatorPins): string {
    return formatTrace(clientFamily(headers.get("user-agent")), compareAssertion(headers.get("cf-access-jwt-assertion"), pins));
}

/**
 * The line to log for this request, or null when the identical reading was
 * logged less than TRACE_WINDOW_MS ago. The reading itself is the key, so a
 * different session kind or a changed pin comparison always logs at once.
 */
export function traceRequest(headers: HeaderReader, pins: OperatorPins, state: TraceState, now: number = Date.now()): string | null {
    const line = describeRequestSession(headers, pins);
    const last = state.lastLogged.get(line);
    if (last !== undefined && now - last < TRACE_WINDOW_MS) return null;
    state.lastLogged.set(line, now);
    if (state.lastLogged.size > STATE_LIMIT) {
        for (const [key, at] of state.lastLogged) {
            if (now - at >= TRACE_WINDOW_MS) state.lastLogged.delete(key);
        }
    }
    return line;
}
