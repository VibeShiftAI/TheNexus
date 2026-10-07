"use client";

import { useEffect, useState } from "react";
import { DocumentApiError, recordOutgoingDecision, type DocumentOutgoing, type DocumentResponse } from "@/lib/document-review";

const STATUS: Record<DocumentOutgoing["status"], string> = {
    draft: "Awaiting your send decision",
    approved: "Approved for one delivery. Praxis will report the delivery result here.",
    delivering: "Delivery claimed. A second send is blocked while the result is pending.",
    sent: "Sent. This message cannot be sent again.",
    uncertain: "Delivery outcome uncertain. Automatic retry is blocked.",
    cancelled: "Cancelled permanently. This message will not be sent.",
};

export function OutgoingCard({ data, viewingCurrent, onRefresh, pollMs = 3000 }: {
    data: DocumentResponse;
    viewingCurrent: boolean;
    onRefresh: () => Promise<void> | void;
    pollMs?: number;
}) {
    const [result, setResult] = useState<DocumentOutgoing | null>(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    useEffect(() => { setResult(null); }, [data.document.id, data.outgoing]);
    const outgoing = result ?? data.outgoing;
    useEffect(() => {
        if (outgoing?.status !== "approved" && outgoing?.status !== "delivering") return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            await Promise.resolve(onRefresh()).catch(() => {});
            if (!stopped) timer = setTimeout(poll, pollMs);
        };
        timer = setTimeout(poll, pollMs);
        return () => { stopped = true; clearTimeout(timer); };
    }, [outgoing?.status, onRefresh, pollMs]);
    if (!outgoing) return null;
    const editable = outgoing.status === "draft" || outgoing.status === "approved";
    const blocked = !viewingCurrent
        ? "Switch to the current document before approving this message."
        : data.file_state !== "ok"
            ? "The document is unavailable. Sending is held until its current revision is confirmed and prepared again."
            : outgoing.invalidated_at || outgoing.revision_id !== data.revision?.id
                ? "The document changed. Praxis must prepare a new message version for you to review."
                : !outgoing.envelope.cc.length
                    ? "The operator copy address is missing. Sending is held until it is configured and included in the message you review."
                    : null;

    async function decide(decision: "approve_send" | "cancel") {
        if (!outgoing || busy) return;
        setBusy(true);
        setNotice(null);
        try {
            const next = await recordOutgoingDecision(data.document.id, {
                decision, revision_id: outgoing.revision_id, envelope_hash: outgoing.envelope_hash,
            });
            setResult(next.outgoing);
            setNotice(decision === "cancel" ? "Send cancelled permanently." : "Your approval for this exact message is recorded.");
            // The successful decision remains visible even if refreshing the reader fails.
            await Promise.resolve(onRefresh()).catch(() => {});
        } catch (error) {
            const message = error instanceof Error ? error.message : "The decision could not be confirmed";
            if (error instanceof DocumentApiError && error.status === 409) {
                setNotice(`${message}. Reloaded the current message; review it before deciding again.`);
                await Promise.resolve(onRefresh()).catch(() => {});
            } else if (error instanceof DocumentApiError) {
                setNotice(`${message}. No send decision was recorded.`);
            } else {
                setNotice(`${message}. The outcome is unclear; refresh to check the recorded status before deciding again.`);
            }
        } finally { setBusy(false); }
    }

    return (
        <section className="mb-4 rounded-lg border border-cyan-700/70 bg-slate-900/60 p-4 text-sm" data-outgoing-card={outgoing.status} aria-label="Outgoing message review">
            <h2 className="font-semibold text-cyan-100">Outgoing message</h2>
            <p className="mt-1 text-xs text-slate-300" role="status">{STATUS[outgoing.status]}</p>
            <p className="mt-2 text-xs text-slate-400">Approve and send authorizes one delivery of the exact message below. Comments, Finish review and Approve document provide editorial feedback only.</p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 break-words text-xs">
                <dt className="text-slate-400">To</dt><dd>{outgoing.envelope.to}</dd>
                <dt className="text-slate-400">CC</dt><dd>{outgoing.envelope.cc.join(", ") || "None"}</dd>
                <dt className="text-slate-400">Subject</dt><dd>{outgoing.envelope.subject}</dd>
            </dl>
            <pre className="mt-3 whitespace-pre-wrap break-words rounded-md bg-slate-950 p-3 font-sans text-sm text-slate-200" data-outgoing-body="">{outgoing.envelope.text}</pre>
            <p className="mt-2 text-xs text-slate-400">Attachments: none</p>
            <details className="mt-2 text-xs text-slate-400">
                <summary className="cursor-pointer">Message sources</summary>
                <p className="mt-1 break-all">Member: {outgoing.provenance.member_id} · Project: {outgoing.provenance.project_id} · Task: {outgoing.provenance.task_id}</p>
                <ul className="mt-1 space-y-1 break-all">{outgoing.provenance.source_refs.map((source, index) => <li key={index}>{source}</li>)}</ul>
                {outgoing.provenance.commitment_id && <p>Commitment: {outgoing.provenance.commitment_id}</p>}
            </details>
            {editable && blocked && <p className="mt-3 text-xs text-amber-200" data-outgoing-blocked="">{blocked}</p>}
            {notice && <p className="mt-3 text-xs text-cyan-100" role="alert" data-outgoing-notice="">{notice}</p>}
            {editable && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                    {outgoing.status === "draft" && <button type="button" disabled={busy || Boolean(blocked)} onClick={() => void decide("approve_send")} className="rounded-md border border-cyan-500 bg-cyan-500/15 px-3 py-2 text-cyan-100 disabled:cursor-not-allowed disabled:opacity-40">Approve and send</button>}
                    <button type="button" disabled={busy} onClick={() => void decide("cancel")} className="rounded-md border border-slate-600 px-3 py-2 text-slate-300 disabled:opacity-40">Cancel send</button>
                    <span className="text-xs text-slate-500">Cancellation is permanent for this message.</span>
                </div>
            )}
        </section>
    );
}
