"use client";

/**
 * Evidence drawer: everything a reviewer should not have to read in the
 * document itself. The revision's hash, path and size; every asset with its
 * hash and whether it is servable (the server's readiness check) and whether
 * it actually loaded in this browser (the second half of the completion rule,
 * contract §5); registration receipts, edits and the raw/download links.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Loader2, ShieldCheck, X } from "lucide-react";
import { assetUrl, getDocumentHistory, getReadiness, rawDocumentUrl, mediaLabel, type DocumentHistory, type DocumentResponse, type Readiness, type RevisionAsset } from "@/lib/document-review";

export type LoadStates = Record<string, "loaded" | "failed">;

function bytes(n: number | null | undefined): string {
    if (!n && n !== 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function when(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function EvidenceDrawer({ data, assets, loadStates, open, onClose }: {
    data: DocumentResponse;
    assets: RevisionAsset[];
    loadStates: LoadStates;
    open: boolean;
    onClose: () => void;
}) {
    const [readiness, setReadiness] = useState<Readiness | null>(data.readiness ?? null);
    const [history, setHistory] = useState<DocumentHistory | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);

    useEffect(() => { setReadiness(data.readiness ?? null); }, [data.readiness, data.revision?.id]);
    useEffect(() => {
        if (!open) return;
        getDocumentHistory(data.document.id).then(setHistory).catch((err) => setError(err instanceof Error ? err.message : "Could not load history"));
    }, [open, data.document.id, data.revision?.id]);

    const recheck = async () => {
        setChecking(true);
        try { setReadiness(await getReadiness(data.document.id, data.revision?.id)); setError(null); }
        catch (err) { setError(err instanceof Error ? err.message : "Readiness check failed"); }
        finally { setChecking(false); }
    };

    if (!open) return null;
    const visual = assets.filter((a) => a.role !== "primary" || !["markdown", "text", "code", "json", "design"].includes(a.media_type));
    const required = visual.filter((a) => a.role === "screen" || a.role === "before" || a.role === "primary");
    const loadedAll = required.length > 0 && required.every((a) => loadStates[a.asset_key] === "loaded");
    const failedAny = Object.values(loadStates).includes("failed");
    const checkFor = (key: string) => readiness?.checks.find((c) => c.asset_key === key);

    return (
        <div className="fixed inset-0 z-[90]" role="dialog" aria-label="Evidence" data-evidence-drawer="">
            <button type="button" aria-label="Close evidence" onClick={onClose} className="absolute inset-0 bg-black/60" />
            <aside className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-slate-700 bg-slate-950 shadow-2xl">
                <header className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
                    <ShieldCheck size={16} className="text-cyan-300" />
                    <h2 className="text-sm font-semibold text-slate-100">Evidence</h2>
                    <span className="text-[11px] text-slate-500">{mediaLabel(data.media_type)} · {assets.length} asset{assets.length === 1 ? "" : "s"}</span>
                    <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded p-1 text-slate-400 hover:text-white"><X size={16} /></button>
                </header>
                <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4 text-xs text-slate-300">
                    <section>
                        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Revision</h3>
                        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                            <dt className="text-slate-500">Hash</dt><dd className="break-all font-mono text-[11px] text-slate-200" data-evidence-hash="">{data.revision?.content_hash ?? "none"}</dd>
                            <dt className="text-slate-500">Captured</dt><dd>{when(data.revision?.captured_at)}{data.revision?.source === "nexus_edit" ? ` · edited in Nexus by ${data.revision.edited_by ?? "operator"}` : ""}</dd>
                            <dt className="text-slate-500">Path</dt><dd className="break-all font-mono text-[11px]">{data.document.path}</dd>
                            <dt className="text-slate-500">Size</dt><dd>{bytes(data.revision?.byte_length)}{data.revision?.line_count ? ` · ${data.revision.line_count} lines` : ""}</dd>
                            <dt className="text-slate-500">File</dt><dd>{data.file_state === "ok" ? "available on disk" : <span className="text-amber-200">{data.file_error || data.file_state}</span>}</dd>
                        </dl>
                        <div className="mt-2 flex flex-wrap gap-2">
                            <a href={rawDocumentUrl(data.document.id, { revision: data.revision?.id, download: true })} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 hover:border-cyan-500/60"><Download size={12} /> Download this revision</a>
                        </div>
                    </section>

                    {visual.length > 0 && (
                        <section>
                            <div className="mb-1.5 flex items-center gap-2">
                                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Visuals</h3>
                                {readiness && (
                                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${readiness.ready ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-rose-500/40 bg-rose-500/10 text-rose-200"}`} data-evidence-readiness={readiness.ready ? "ready" : "not-ready"}>
                                        {readiness.ready ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />} Server: {readiness.required_ok}/{readiness.required_total} required assets servable
                                    </span>
                                )}
                                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${loadedAll ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : failedAny ? "border-rose-500/40 bg-rose-500/10 text-rose-200" : "border-slate-700 text-slate-400"}`} data-evidence-browser={loadedAll ? "verified" : failedAny ? "failed" : "pending"}>
                                    {loadedAll ? <><CheckCircle2 size={11} /> Visuals verified in this browser</> : failedAny ? <><AlertTriangle size={11} /> Some visuals failed to load here</> : "Browser: not all visuals viewed yet"}
                                </span>
                                <button type="button" onClick={() => void recheck()} disabled={checking} className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 hover:border-cyan-500/60 disabled:opacity-50">{checking ? <Loader2 size={11} className="animate-spin" /> : null} Re-check</button>
                            </div>
                            <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800" data-evidence-assets="">
                                {visual.map((a) => {
                                    const check = checkFor(a.asset_key);
                                    const loaded = loadStates[a.asset_key];
                                    return (
                                        <li key={a.asset_key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 py-1.5" data-evidence-asset={a.asset_key}>
                                            <span className="font-mono text-[11px] text-slate-200">{a.asset_key}</span>
                                            <span className="text-slate-500">{a.label}</span>
                                            <span className="ml-auto text-[10px] text-slate-500">{a.media_type} · {bytes(a.byte_length)}{a.width && a.height ? ` · ${a.width}×${a.height}` : ""}</span>
                                            <span className={`rounded-full border px-1.5 text-[10px] ${check ? (check.ok ? "border-emerald-500/40 text-emerald-200" : "border-rose-500/40 text-rose-200") : "border-slate-700 text-slate-500"}`}>{check ? check.status : "unchecked"}</span>
                                            <span className={`rounded-full border px-1.5 text-[10px] ${loaded === "loaded" ? "border-emerald-500/40 text-emerald-200" : loaded === "failed" ? "border-rose-500/40 text-rose-200" : "border-slate-700 text-slate-500"}`}>{loaded === "loaded" ? "loaded here" : loaded === "failed" ? "failed here" : "not viewed"}</span>
                                            <span className="basis-full break-all font-mono text-[10px] text-slate-600">{a.content_hash}</span>
                                            <a href={assetUrl(data.document.id, a.asset_key, { revision: data.revision?.id, download: true })} className="text-[10px] text-cyan-300 hover:underline">download</a>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    )}

                    <section>
                        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Registrations and edits</h3>
                        {error && <p role="alert" className="text-rose-200">{error}</p>}
                        {!history && !error && <p className="flex items-center gap-1 text-slate-500"><Loader2 size={11} className="animate-spin" /> Loading…</p>}
                        {history && (
                            <ul className="space-y-1.5" data-evidence-history="">
                                {history.registrations.map((r) => (
                                    <li key={r.id} className="rounded-md border border-slate-800 px-2.5 py-1.5">
                                        <span className="text-slate-200">Receipt</span> <span className="font-mono text-[10px]">{r.id.slice(0, 8)}</span> · rev <span className="font-mono text-[10px]">{r.content_hash.slice(0, 8)}</span> · {when(r.registered_at)} · by {r.registered_by ?? "unknown"}{r.task_id ? ` · task ${r.task_id.slice(0, 8)}` : ""}
                                    </li>
                                ))}
                                {(history.edits ?? []).map((e) => (
                                    <li key={e.id} className="rounded-md border border-slate-800 px-2.5 py-1.5" data-evidence-edit="">
                                        <span className="text-slate-200">Edit</span> {when(e.created_at)} · {e.actor_id} ({e.authority.replace(/_/g, " ")}){e.summary ? `: ${e.summary}` : ""}
                                    </li>
                                ))}
                                {history.registrations.length === 0 && (history.edits ?? []).length === 0 && <li className="text-slate-500">No receipts or edits recorded.</li>}
                            </ul>
                        )}
                    </section>
                </div>
            </aside>
        </div>
    );
}
