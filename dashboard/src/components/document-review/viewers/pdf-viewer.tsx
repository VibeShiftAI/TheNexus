"use client";

/**
 * PDF stage: the browser's own renderer in a frame, a page control that the
 * page comments anchor to, and a same-origin "open full" link for phones whose
 * inline renderer shows only the first page. Comments are per page (contract
 * §3.1 `page`); region selection inside a PDF is left to the image export of
 * a page, which the design package covers.
 */

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, MessageSquarePlus } from "lucide-react";

export interface PageMarker { id: string; index: number; page: number; label?: string | null; resolved?: boolean }

export function PdfViewer({ src, assetKey, markers = [], selectedMarkerId = null, onSelectMarker, annotate = false, onPage, onLoadState, requestedPage }: {
    src: string;
    assetKey: string;
    markers?: PageMarker[];
    selectedMarkerId?: string | null;
    onSelectMarker?: (id: string) => void;
    annotate?: boolean;
    onPage?: (page: number) => void;
    onLoadState?: (assetKey: string, state: "loaded" | "failed") => void;
    requestedPage?: number | null;
}) {
    const [page, setPage] = useState(1);
    useEffect(() => { if (requestedPage) setPage(requestedPage); }, [requestedPage]);
    const pages = [...new Set(markers.map((m) => m.page))].sort((a, b) => a - b);
    return (
        <div className="rounded-xl border border-slate-800 bg-slate-950/70" data-pdf-viewer={assetKey}>
            <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800 px-3 py-2 text-[11px] text-slate-300">
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page" className="rounded-md border border-slate-700 p-1.5 hover:border-cyan-500/60"><ChevronLeft size={14} /></button>
                <label className="inline-flex items-center gap-1">Page
                    <input type="number" min={1} value={page} onChange={(e) => setPage(Math.max(1, Number(e.target.value) || 1))} aria-label="Page number" className="w-14 rounded-md border border-slate-700 bg-slate-900 px-1.5 py-1 font-mono" data-pdf-page="" />
                </label>
                <button type="button" onClick={() => setPage((p) => p + 1)} aria-label="Next page" className="rounded-md border border-slate-700 p-1.5 hover:border-cyan-500/60"><ChevronRight size={14} /></button>
                {pages.length > 0 && (
                    <span className="ml-1 flex items-center gap-1">
                        {markers.map((m) => (
                            <button key={m.id} type="button" data-page-marker={m.id} onClick={() => { setPage(m.page); onSelectMarker?.(m.id); }} aria-label={`Comment ${m.index} on page ${m.page}`} title={m.label ?? undefined}
                                className={`flex h-5 min-w-5 items-center justify-center rounded-full border px-1 text-[10px] font-bold ${selectedMarkerId === m.id ? "border-cyan-200 bg-cyan-500 text-slate-950" : m.resolved ? "border-emerald-200 bg-emerald-500 text-slate-950" : "border-amber-200 bg-amber-400 text-slate-950"}`}>
                                {m.index}
                            </button>
                        ))}
                    </span>
                )}
                <a href={src} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 hover:border-cyan-500/60"><ExternalLink size={12} /> Open full</a>
                {annotate && onPage && (
                    <button type="button" onClick={() => onPage(page)} className="inline-flex items-center gap-1 rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2.5 py-1.5 font-semibold text-cyan-100 hover:bg-cyan-500/25" data-pdf-comment="">
                        <MessageSquarePlus size={13} /> Comment on page {page}
                    </button>
                )}
            </div>
            <iframe
                key={page}
                title="PDF"
                src={`${src}#page=${page}&view=FitH`}
                className="h-[72vh] w-full bg-slate-900"
                onLoad={() => onLoadState?.(assetKey, "loaded")}
                onError={() => onLoadState?.(assetKey, "failed")}
            />
        </div>
    );
}
