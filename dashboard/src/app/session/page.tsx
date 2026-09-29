"use client";

/**
 * Session check, /session.
 *
 * Answers, from inside whatever client Robert is using, whether the session
 * it already holds is the one Nexus chat recognizes as the operator, and if
 * not, which fixed check refused it and the one setting that fixes it. It is
 * reached from the menu, so it works inside the Windows travel shell, which
 * has no address bar (2026-09-25, task 5fbeff4a). Three same-origin reads,
 * no login prompt, no token shown: Cloudflare's edge identity for this
 * session, the dashboard probe (session shape, no reload needed), and the
 * Nexus API self-check (the verified verdict, present after a reload).
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import {
    describeAudience,
    nextStep,
    summarizeAccessIdentity,
    summarizeOperatorIdentity,
    summarizeProbe,
    type AccessIdentitySummary,
    type OperatorSummary,
    type ProbeSummary,
    type SessionKind,
} from "@/lib/session-check";

interface Result {
    probe: ProbeSummary;
    access: AccessIdentitySummary;
    operator: OperatorSummary;
    step: string;
    at: Date;
}

async function read(path: string): Promise<{ status: number; body: unknown }> {
    try {
        const response = await fetch(path, { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
        let body: unknown = null;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        return { status: response.status, body };
    } catch {
        return { status: 0, body: null };
    }
}

const KIND_LABEL: Record<SessionKind, string> = {
    "service-token": "Service token (the travel shell's startup exchange)",
    user: "Person (identity-provider login)",
    none: "No Access session",
    unknown: "Unrecognized session",
};

function Card({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
    return (
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3" data-session-card={testId}>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
            <div className="mt-2 space-y-1 text-sm text-slate-200">{children}</div>
        </section>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <p className="flex flex-wrap gap-x-2">
            <span className="text-slate-500">{label}</span>
            <span className="break-all">{value}</span>
        </p>
    );
}

export default function SessionPage() {
    const [result, setResult] = useState<Result | null>(null);
    const [checking, setChecking] = useState(false);

    const check = useCallback(async () => {
        setChecking(true);
        const [probe, edge, api] = await Promise.all([
            read("/session/probe"),
            read("/cdn-cgi/access/get-identity"),
            read("/api/ai/chat/operator-identity"),
        ]);
        const probeSummary = summarizeProbe(probe.status, probe.body);
        const access = summarizeAccessIdentity(edge.status, edge.body);
        const operator = summarizeOperatorIdentity(api.status, api.body);
        setResult({ probe: probeSummary, access, operator, step: nextStep(probeSummary, access, operator), at: new Date() });
        setChecking(false);
    }, []);

    useEffect(() => {
        void check();
    }, [check]);

    // The probe is the primary reading; the edge reading fills in when the
    // probe saw no session. When the probe gave no reading at all, only the
    // edge can speak, and with nothing from the edge the kind stays
    // undetermined rather than reading as "no Access session".
    const kind: SessionKind | null = !result
        ? null
        : result.probe.available
            ? (result.probe.kind === "none" && result.access.kind !== "none" ? result.access.kind : result.probe.kind)
            : (result.access.kind !== "none" ? result.access.kind : null);
    const clientId = result ? (result.probe.available ? result.probe.clientId : null) ?? result.access.clientId : null;

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200" data-session-check="" data-session-kind={kind ?? (result ? "undetermined" : "pending")} data-session-operator={result ? result.operator.state : "pending"}>
            <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
                <div className="mx-auto flex max-w-[900px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <Link href="/" className="flex shrink-0 items-center gap-1.5 text-sm text-slate-400 hover:text-white">
                        <ArrowLeft size={16} /> Bridge
                    </Link>
                    <div className="hidden h-5 w-px bg-slate-700 sm:block" />
                    <div className="min-w-0 flex-1">
                        <h1 className="flex items-center gap-2 text-base font-semibold text-white">
                            <ShieldCheck size={16} className="text-emerald-300" /> Session check
                        </h1>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                            Whether the session this app already holds is the one Nexus chat recognizes as you. Nothing here signs you in, and no token is shown or sent anywhere.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void check()}
                        disabled={checking}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-60"
                        aria-label="Check again"
                    >
                        <RefreshCw size={13} className={checking ? "animate-spin" : ""} /> Check again
                    </button>
                </div>
            </header>

            <div className="mx-auto max-w-[900px] space-y-3 px-4 py-5">
                {!result ? (
                    <div className="flex items-center gap-2 text-sm text-slate-400">
                        <Loader2 size={16} className="animate-spin text-emerald-300" /> Checking this session…
                    </div>
                ) : (
                    <>
                        <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                            <h2 className="text-xs font-semibold uppercase tracking-wide text-emerald-300">What to do next</h2>
                            <p className="mt-1" data-session-step="">{result.step}</p>
                        </section>

                        <Card title="This session" testId="session">
                            <Row label="Kind" value={kind ? KIND_LABEL[kind] : "Not determined: the dashboard probe gave no reading"} />
                            {!result.probe.available && <Row label="Dashboard probe" value={result.probe.note} />}
                            {clientId && <Row label="Client ID (not a secret; the value to pin)" value={clientId} />}
                            {result.access.email && <Row label="Verified address" value={result.access.email} />}
                            {result.probe.available && result.probe.assertionPresent && result.probe.audienceShape !== null && (
                                <Row label="Audience claim" value={describeAudience(result.probe.audienceShape, result.probe.audience)} />
                            )}
                            {result.probe.available && result.probe.assertionPresent && result.probe.tokenType !== null && (
                                <Row label="Token profile" value={`type ${result.probe.tokenType}, subject ${result.probe.subject ?? "not reported"}, nbf ${result.probe.nbf ?? "not reported"}, issuer ${result.probe.issuer ?? "not compared"}`} />
                            )}
                            {result.probe.expired === true && <Row label="Note" value="The session token has expired; the app will refresh it on its next load." />}
                        </Card>

                        <Card title="Cloudflare edge (get-identity)" testId="edge">
                            <Row label="Status" value={result.access.status === 0 ? "unreachable" : String(result.access.status)} />
                            <Row label="Reading" value={result.access.note} />
                        </Card>

                        <Card title="Nexus verdict (API self-check)" testId="operator">
                            <Row label="State" value={result.operator.state} />
                            {result.operator.reason && <Row label="Reason" value={result.operator.reason} />}
                            {result.operator.check && <Row label="Check" value={result.operator.check} />}
                            {result.operator.identity && <Row label="Identity" value={result.operator.identity} />}
                            {result.operator.trustedDevices !== null && <Row label="Trusted devices pinned" value={String(result.operator.trustedDevices)} />}
                            {result.operator.configured !== null && <Row label="Operator pins complete" value={result.operator.configured ? "yes" : "no"} />}
                            <Row label="Reading" value={result.operator.note} />
                        </Card>

                        <p className="text-[11px] text-slate-500">Checked {result.at.toLocaleTimeString()}. Reload the Nexus child after any pin change; this page never restarts anything.</p>
                    </>
                )}
            </div>
        </main>
    );
}
