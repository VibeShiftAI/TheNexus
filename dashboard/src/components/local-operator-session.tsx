"use client";
import { useEffect } from "react";
import { ensureLocalOperatorSession } from "@/lib/local-operator-session";

/** Local app/browser identity is established automatically; no second login UI. */
export function LocalOperatorSession() {
    useEffect(() => {
        const renew = () => { if (document.visibilityState === "visible") void ensureLocalOperatorSession(); };
        renew();
        window.addEventListener("focus", renew);
        document.addEventListener("visibilitychange", renew);
        const timer = setInterval(renew, 45 * 60 * 1000);
        return () => {
            clearInterval(timer);
            window.removeEventListener("focus", renew);
            document.removeEventListener("visibilitychange", renew);
        };
    }, []);
    return null;
}
