/**
 * /session/renewed: where the sign-in window lands once the Cloudflare Access
 * flow has let it through. By the time this renders, the browser holds a
 * fresh application session cookie for this origin, so the page that opened
 * the window only needs to re-probe. This page tells it so
 * (`announceSessionRenewed`: a BroadcastChannel message and, when reachable,
 * an event on the opener) and then closes itself. Opened directly rather than
 * as a popup, it goes back to the dashboard instead.
 *
 * Nothing here reads, shows or stores a credential; the cookie is the
 * browser's, set by Access on the way in.
 */
"use client";

import { useEffect, useState } from "react";
import { announceSessionRenewed } from "@/lib/session-renewal";
import { sanitizeShellPath } from "@/lib/mobile-shell";

/** Long enough for the channel message to be delivered before the window goes. */
const CLOSE_AFTER_MS = 300;

export default function SessionRenewedPage() {
    const [mode, setMode] = useState<"closing" | "returning">("closing");

    useEffect(() => {
        announceSessionRenewed();
        if (window.opener) {
            const t = setTimeout(() => window.close(), CLOSE_AFTER_MS);
            return () => clearTimeout(t);
        }
        setMode("returning");
        const back = sanitizeShellPath(new URLSearchParams(window.location.search).get("back")) ?? "/";
        const t = setTimeout(() => window.location.replace(back), CLOSE_AFTER_MS);
        return () => clearTimeout(t);
    }, []);

    return (
        <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-200">
            <div
                role="status"
                data-session-renewed={mode}
                className="max-w-sm rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-5 py-4 text-sm"
            >
                <p className="font-semibold text-emerald-200">Session renewed.</p>
                <p className="mt-1 text-slate-400">
                    {mode === "closing"
                        ? "This window closes itself; the Nexus page that opened it is reconnecting. If it stays open, you can close it."
                        : "Returning to the Nexus."}
                </p>
            </div>
        </main>
    );
}
