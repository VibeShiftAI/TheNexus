"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

const button = "rounded-lg border border-slate-600 px-3 py-2 text-sm text-cyan-100 hover:border-cyan-400 disabled:opacity-40";

/** The credential lives only in the password input until this single exchange. */
export function OperatorSignInForm() {
    const credential = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [operator, setOperator] = useState(false);
    const [notice, setNotice] = useState("Checking this session…");
    useEffect(() => {
        const controller = new AbortController();
        fetch("/api/operator-session", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
            .then(async response => {
                if (!response.ok) throw new Error("Open http://localhost:3000 to sign in locally.");
                const result = await response.json();
                if (controller.signal.aborted) return;
                setOperator(result.operator === true);
                setNotice(result.operator ? `Signed in as Robert until ${new Date(result.expiresAt).toLocaleTimeString()}.` : "This session is not signed in as the operator.");
            }).catch(error => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Session check unavailable."); });
        return () => controller.abort();
    }, []);

    async function signIn(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || !credential.current?.value) return;
        setBusy(true);
        // Clear before awaiting network I/O; never copy to state, URL, storage,
        // telemetry, a server-rendered prop or a document/chat message.
        const headers = { Authorization: `Bearer ${credential.current.value}` };
        credential.current.value = "";
        try {
            const response = await fetch("/api/operator-session", { method: "POST", headers, credentials: "same-origin", cache: "no-store" });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Operator sign-in refused.");
            setOperator(true);
            setNotice(`Signed in as Robert until ${new Date(result.expiresAt).toLocaleTimeString()}. Return to your review and retry the decision. If mail requested a refresh, refresh its current status first.`);
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "Sign-in could not be confirmed. Check the session before retrying.");
        } finally { headers.Authorization = ""; setBusy(false); }
    }
    async function signOut() {
        setBusy(true);
        try {
            const response = await fetch("/api/operator-session", { method: "DELETE", credentials: "same-origin", cache: "no-store" });
            if (!response.ok) throw new Error("Sign-out could not be confirmed. Try again.");
            setOperator(false); setNotice("Signed out. This local session can no longer record operator decisions.");
        } catch (error) { setNotice(error instanceof Error ? error.message : "Sign-out could not be confirmed."); }
        finally { setBusy(false); }
    }
    return <div className="space-y-4 text-sm text-slate-200">
        <p>Sign in separately in your Mac app and browser. Operator access lasts one hour and includes mail, document decisions and operator chat actions.</p>
        <p role="status" className="rounded border border-slate-700 p-3">{notice}</p>
        {operator ? <button type="button" className={button} disabled={busy} onClick={() => void signOut()}>Sign out</button> :
            <form onSubmit={signIn} className="space-y-3">
                <label className="block">Operator credential
                    <input ref={credential} type="password" autoComplete="off" required disabled={busy} spellCheck={false}
                        className="mt-1 block w-full rounded border border-slate-600 bg-slate-950 p-3" />
                </label>
                <p className="text-xs text-slate-400">Use Robert’s operator credential, never an executor or runtime key. It is used only to establish this session.</p>
                <button type="submit" className={button} disabled={busy}>{busy ? "Signing in…" : "Sign in as Robert"}</button>
            </form>}
    </div>;
}

/** Inline dialog preserves the unsaved document note and mail body underneath. */
export function LocalOperatorSignIn() {
    const [local, setLocal] = useState(false);
    const [open, setOpen] = useState(false);
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => { setLocal(window.location.origin === "http://localhost:3000"); }, []);
    useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
    if (!local) return null;
    return <div>
        <button type="button" className={button} onClick={() => setOpen(true)}>Operator sign-in</button>
        {open && <dialog ref={dialog} onClose={() => setOpen(false)} className="m-auto w-[min(32rem,90vw)] rounded-xl border border-slate-600 bg-slate-900 p-6 text-slate-100 backdrop:bg-black/70" aria-labelledby="local-operator-title">
            <div className="mb-4 flex items-center justify-between gap-4">
                <h2 id="local-operator-title" className="text-lg font-semibold">Local operator session</h2>
                <button type="button" className={button} onClick={() => dialog.current?.close()}>Close</button>
            </div>
            <OperatorSignInForm />
        </dialog>}
    </div>;
}
