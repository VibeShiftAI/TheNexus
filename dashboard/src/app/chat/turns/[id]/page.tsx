"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { MarkdownMessage } from "@/components/chat/markdown-message";
import { getAuthHeader } from "@/lib/auth";

type TurnReceipt = {
    state: "in_progress" | "completed" | "rejected" | "uncertain" | "failed";
    started_at?: string;
    reply?: { response?: string; error?: string };
    error?: string;
};

export default function ChatTurnPage() {
    const { id } = useParams<{ id: string }>();
    const [receipt, setReceipt] = useState<TurnReceipt | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refresh, setRefresh] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const read = async () => {
            try {
                const response = await fetch(`/api/ai/chat/turns/${encodeURIComponent(id)}`, {
                    headers: await getAuthHeader(), signal: controller.signal, cache: "no-store",
                });
                if (!response.ok) throw new Error(response.status === 404
                    ? "No saved outcome was found for this turn. Review the conversation and task status before sending the request again."
                    : "The saved outcome is temporarily unavailable. Check again when Praxis reconnects.");
                const result: TurnReceipt = await response.json();
                if (controller.signal.aborted) return;
                setReceipt(result); setError(null);
                if (result.state === "in_progress") timer = setTimeout(() => { void read(); }, 5_000);
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not check this turn.");
            }
        };
        void read();
        return () => { controller.abort(); if (timer) clearTimeout(timer); };
    }, [id, refresh]);
    const title = receipt?.state === "completed" ? "Saved reply"
        : receipt?.state === "in_progress" ? "Praxis is still working"
        : receipt?.state === "rejected" ? "Request rejected before work began"
        : receipt ? "This turn needs a status check" : "Checking your turn";
    return <main className="mx-auto max-w-3xl space-y-6 p-6 text-slate-200">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {error && <p role="alert" className="text-amber-300">{error}</p>}
        {receipt?.state === "in_progress" && <p role="status">Your original request is still in progress. This page checks automatically; you do not need to send it again.</p>}
        {receipt?.state !== "in_progress" && receipt?.reply?.response && <MarkdownMessage content={receipt.reply.response} />}
        {receipt && ["rejected", "uncertain", "failed"].includes(receipt.state) && <div className="space-y-3">
            {receipt.state === "rejected"
                ? <p>Praxis rejected this request before starting the requested work. Review the saved explanation before sending a new request.</p>
                : <p>Praxis could not confirm the final outcome. Some work may have finished. Review the affected task in the <Link className="text-cyan-300 underline" href="/task-board">task board</Link> and the <Link className="text-cyan-300 underline" href="/system-monitor">System Monitor</Link> before requesting more work.</p>}
            {(receipt.error || receipt.reply?.error) && <p className="text-sm text-slate-400">Recorded detail: {receipt.error || receipt.reply?.error}</p>}
        </div>}
        <div className="flex gap-4">
            <button className="rounded border border-slate-600 px-3 py-2" onClick={() => setRefresh(value => value + 1)}>Check again</button>
            <Link className="px-3 py-2 text-cyan-300 underline" href="/">Return to Praxis</Link>
        </div>
        <p className="text-sm text-slate-400">Checking this page only reads the saved status. It does not start another task.</p>
    </main>;
}
