/**
 * ConnectionBanner: the deck-wide readout of the shared connection lifecycle
 * (`lib/connection-lifecycle`), mounted once in the root layout.
 *
 * Hidden while `live`, and for the first few seconds of `recovering` and
 * `renewing` (a probe answers within that on a healthy network, and a shell
 * renews within that too, so a wake from the foreground should not flash a
 * banner). Otherwise one small pill says what is true:
 *
 *   recovering   "Reconnecting to the Nexus…"
 *   renewing     "Renewing your Nexus session…" (the shell was asked; bounded)
 *   offline      unreachable since HH:MM, retrying automatically, "Retry now"
 *   reauth       the session expired and only the operator can bring it back.
 *                One explicit "Sign in again" (never automatic) opens the flow
 *                in a separate window, so this page and everything typed in it
 *                stay as they are. Blocked windows can be retried; legacy
 *                travel shells need an update to share the app profile.
 */
"use client";

import { useEffect, useState } from "react";
import { useLiveBoardState } from "@/components/live-board-state";

/** `recovering` / `renewing` shorter than this is not worth a banner. */
export const RECOVERING_GRACE_MS = 4_000;

/** Preservation promise for the retry action. */
export const SIGN_IN_HERE_COST = "this page and all unsent edits stay open";

function fmtClock(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ConnectionBanner() {
    const {
        phase,
        phaseSince,
        lastLiveAt,
        renewalKind,
        signIn,
        reauthenticate,
        signInHere,
        requestRecovery,
    } = useLiveBoardState();
    const [, setTick] = useState(0);

    // Re-render each second while not live so the grace window and the
    // "since" copy stay current; nothing runs while live.
    useEffect(() => {
        if (phase === "live") return;
        const t = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, [phase]);

    if (phase === "live") return null;
    const now = Date.now();
    if ((phase === "recovering" || phase === "renewing") && now - phaseSince < RECOVERING_GRACE_MS) return null;

    const asOf = lastLiveAt || phaseSince;
    const base =
        "pointer-events-auto flex max-w-[min(92vw,44rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded-full border px-4 py-1.5 text-xs shadow-lg backdrop-blur";

    if (phase === "reauth") {
        // The bridge opens a native auth window in supported travel shells;
        // older builds fail closed with an update hint and keep the editor.
        const travelShell = renewalKind === "travel-shell";
        const windowBlocked = signIn === "blocked";
        const offerSignInHere = windowBlocked;
        const offerWindow = !windowBlocked;
        const button = "rounded-full border border-fuchsia-300/50 px-2.5 py-0.5 font-semibold hover:bg-fuchsia-500/20";
        return (
            <div className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex justify-center">
                <div
                    role="alert"
                    data-connection-banner="reauth"
                    data-connection-banner-signin={signIn}
                    className={`${base} border-fuchsia-500/50 bg-fuchsia-950/90 text-fuchsia-100`}
                >
                    <span className="font-semibold">Your Nexus session has expired.</span>
                    <span className="opacity-80">
                        {signIn === "window-open"
                            ? "Finish signing in in the window that opened; this page and anything you typed stay as they are."
                            : windowBlocked
                              ? (travelShell ? "This shell could not open sign-in. Update The Nexus to sign in without closing this page; your edits remain here." : "The sign-in window was blocked. Allow pop-ups for this site and try again; your edits remain here.")
                              : travelShell
                                ? "Automatic renewal did not restore the session. Sign in in a separate app window; your edits remain here."
                                : "Live data is paused; anything you typed is kept."}
                    </span>
                    {offerWindow && (
                        <button
                            type="button"
                            onClick={() => {
                                reauthenticate();
                            }}
                            className={button}
                        >
                            Sign in again
                        </button>
                    )}
                    {offerSignInHere && (
                        <button
                            type="button"
                            data-connection-banner-action="sign-in-here"
                            title={`Opens a separate sign-in window: ${SIGN_IN_HERE_COST}.`}
                            onClick={() => {
                                signInHere();
                            }}
                            className={button}
                        >
                            Try sign-in window again
                        </button>
                    )}
                    {offerSignInHere && (
                        <span className="basis-full text-[11px] opacity-80" data-connection-banner-cost="sign-in-here">
                            During sign-in, {SIGN_IN_HERE_COST}.
                        </span>
                    )}

                </div>
            </div>
        );
    }

    if (phase === "offline") {
        return (
            <div className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex justify-center">
                <div
                    role="status"
                    data-connection-banner="offline"
                    className={`${base} border-red-500/50 bg-red-950/90 text-red-100`}
                >
                    <span className="font-semibold">Nexus unreachable</span>
                    <span className="opacity-80">
                        since {fmtClock(phaseSince)} · showing data as of {fmtClock(asOf)} · retrying automatically
                    </span>
                    <button
                        type="button"
                        onClick={() => requestRecovery("manual")}
                        className="rounded-full border border-red-300/50 px-2.5 py-0.5 font-semibold hover:bg-red-500/20"
                    >
                        Retry now
                    </button>
                </div>
            </div>
        );
    }

    if (phase === "renewing") {
        return (
            <div className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex justify-center">
                <div
                    role="status"
                    data-connection-banner="renewing"
                    className={`${base} border-amber-500/40 bg-amber-950/90 text-amber-100`}
                >
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" aria-hidden />
                    <span className="font-semibold">Renewing your Nexus session…</span>
                    <span className="opacity-80">showing data as of {fmtClock(asOf)}</span>
                </div>
            </div>
        );
    }

    return (
        <div className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex justify-center">
            <div
                role="status"
                data-connection-banner="recovering"
                className={`${base} border-amber-500/40 bg-amber-950/90 text-amber-100`}
            >
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" aria-hidden />
                <span className="font-semibold">Reconnecting to the Nexus…</span>
                <span className="opacity-80">showing data as of {fmtClock(asOf)}</span>
            </div>
        </div>
    );
}
