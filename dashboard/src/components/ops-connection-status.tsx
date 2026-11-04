/**
 * OpsConnectionStatus: the Ops console's one honest line about its data.
 *
 * The console used to show a red error box only when its own fetch failed,
 * and otherwise implied "live" no matter how old the telemetry was or whether
 * the connection had gone. Now the line always states which of these holds:
 *
 *   live       telemetry answered; "data as of HH:MM:SS"
 *   stale      the API probes healthy but dispatch telemetry did not answer
 *              (Praxis down behind a healthy Nexus), a reconnect is in
 *              progress, or the shell is renewing the session; the rows on
 *              screen are kept and dated
 *   offline    the Nexus API is unreachable; retrying with backoff, dated rows
 *   reauth     the session expired and only the operator can bring it back;
 *              live data is paused until then (the page never reloads itself)
 *
 * `describeOpsConnection` is pure so the copy is unit-testable; the component
 * is the thin shell around it.
 */
"use client";

import type { LivePhase } from "@/components/live-board-state";
import type { RenewalBridgeKind, SignInState } from "@/lib/connection-lifecycle";

export type OpsConnectionTone = "live" | "stale" | "offline" | "reauth";

export type OpsConnectionAction = "retry" | "reauth" | "sign-in-here";

export interface OpsConnectionInput {
    phase: LivePhase;
    /** Epoch ms when `phase` began. */
    phaseSince: number;
    /** Epoch ms of the last dispatch-state answer that was applied, or null before the first. */
    loadedAt: number | null;
    /** The console's own fetch error, if its last attempt failed. */
    err: string | null;
    /** The operator already went through sign-in once and the API still refuses. */
    reauthAttempted: boolean;
    /** Where the explicit sign-in action stands. */
    signIn: SignInState;
    /** Which native shell can renew the session, if any. */
    renewalKind: RenewalBridgeKind | null;
}

export interface OpsConnectionDescription {
    tone: OpsConnectionTone;
    headline: string;
    detail: string;
    /** The actions the line offers, in order; empty when nothing is actionable. */
    actions: OpsConnectionAction[];
}

export function fmtClock(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function describeOpsConnection(input: OpsConnectionInput): OpsConnectionDescription {
    const { phase, phaseSince, loadedAt, err, reauthAttempted, signIn, renewalKind } = input;
    const dataAsOf = loadedAt ? `showing data as of ${fmtClock(loadedAt)}` : "no runs loaded yet";
    switch (phase) {
        case "reauth": {
            if (signIn === "window-open") {
                return {
                    tone: "reauth",
                    headline: "Session expired",
                    detail: `live data paused · finish signing in in the window that opened; this page keeps what you typed · ${dataAsOf}`,
                    actions: ["reauth"],
                };
            }
            if (signIn === "blocked") {
                return {
                    tone: "reauth",
                    headline: "Session expired",
                    detail: `live data paused · ${renewalKind === "travel-shell" ? "update The Nexus to sign in without closing this page" : "allow pop-ups for this site and try again"}; this page keeps all unsent edits · ${dataAsOf}`,
                    actions: ["sign-in-here"],
                };
            }
            return {
                tone: "reauth",
                headline: "Session expired",
                detail: reauthAttempted
                    ? `live data paused · the sign-in did not restore the session; try again · ${dataAsOf}`
                    : `live data paused · sign in to resume; this page keeps what you typed · ${dataAsOf}`,
                actions: ["reauth"],
            };
        }
        case "offline":
            return {
                tone: "offline",
                headline: `Nexus unreachable since ${fmtClock(phaseSince)}`,
                detail: `${dataAsOf} · retrying automatically`,
                actions: ["retry"],
            };
        case "renewing":
            return {
                tone: "stale",
                headline: "Renewing your session…",
                detail: `${dataAsOf} · the shell was asked to renew; checking again shortly`,
                actions: [],
            };
        case "recovering":
            return {
                tone: "stale",
                headline: "Reconnecting to the Nexus…",
                detail: dataAsOf,
                actions: [],
            };
        default:
            if (err) {
                return {
                    tone: "stale",
                    headline: "Dispatch telemetry unavailable",
                    detail: `${err} · ${dataAsOf} · retrying automatically`,
                    actions: ["retry"],
                };
            }
            return {
                tone: "live",
                headline: "Live",
                detail: loadedAt ? `data as of ${fmtClock(loadedAt)}` : "loading…",
                actions: [],
            };
    }
}

const TONE_CLASS: Record<OpsConnectionTone, string> = {
    live: "border-emerald-500/30 bg-emerald-500/5 text-emerald-200",
    stale: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    offline: "border-red-500/50 bg-red-500/10 text-red-200",
    reauth: "border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-100",
};

const DOT_CLASS: Record<OpsConnectionTone, string> = {
    live: "bg-emerald-400",
    stale: "bg-amber-400 animate-pulse",
    offline: "bg-red-500",
    reauth: "bg-fuchsia-400",
};

const ACTION_LABEL: Record<OpsConnectionAction, string> = {
    retry: "Retry now",
    reauth: "Sign in again",
    "sign-in-here": "Try sign-in window again",
};

export interface OpsConnectionStatusProps extends OpsConnectionInput {
    onRetry: () => void;
    onReauth: () => void;
    onSignInHere: () => void;
}

export function OpsConnectionStatus(props: OpsConnectionStatusProps) {
    const d = describeOpsConnection(props);
    const handlers: Record<OpsConnectionAction, () => void> = {
        retry: props.onRetry,
        reauth: props.onReauth,
        "sign-in-here": props.onSignInHere,
    };
    return (
        <div
            role="status"
            data-ops-connection={props.phase}
            data-ops-tone={d.tone}
            data-ops-data-state={props.loadedAt ? (d.tone === "live" ? "fresh" : "stale") : "none"}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-xs ${TONE_CLASS[d.tone]}`}
        >
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[d.tone]}`} aria-hidden />
            <span className="font-semibold">{d.headline}</span>
            <span className="min-w-0 flex-1 truncate opacity-80" title={d.detail}>
                {d.detail}
            </span>
            {d.actions.map((action) => (
                <button
                    key={action}
                    type="button"
                    data-ops-action={action}
                    onClick={handlers[action]}
                    className="rounded border border-current/40 px-2 py-0.5 text-[11px] hover:bg-white/10"
                >
                    {ACTION_LABEL[action]}
                </button>
            ))}
        </div>
    );
}
