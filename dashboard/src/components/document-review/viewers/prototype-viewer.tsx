"use client";

/**
 * HTML prototype stage. The prototype runs in a sandboxed frame (the asset
 * route also sends `Content-Security-Policy: sandbox`), at a chosen viewport,
 * so it can be clicked through like the real thing but can never reach the
 * dashboard session. "Place a comment" raises a transparent overlay for one
 * tap and records the normalized point plus the viewport (contract §3.1
 * `point`); pins are drawn over the frame at the same normalized spot.
 */

import { useState } from "react";
import { ExternalLink, MousePointerClick, RefreshCw, Smartphone, Tablet, Monitor } from "lucide-react";

export interface PointPin { id: string; index: number; x: number; y: number; viewport?: string | null; label?: string | null; resolved?: boolean }

const VIEWPORTS = [
    { id: "iphone-15-pro", label: "Phone", icon: Smartphone, width: 393, height: 852 },
    { id: "ipad", label: "Tablet", icon: Tablet, width: 834, height: 1112 },
    { id: "desktop", label: "Desktop", icon: Monitor, width: 1280, height: 800 },
];

export function PrototypeViewer({ src, assetKey, title, pins = [], selectedPinId = null, onSelectPin, annotate = false, onPoint, onLoadState, defaultViewport }: {
    src: string;
    assetKey: string;
    title: string;
    pins?: PointPin[];
    selectedPinId?: string | null;
    onSelectPin?: (id: string) => void;
    annotate?: boolean;
    onPoint?: (point: { x: number; y: number; viewport: string }) => void;
    onLoadState?: (assetKey: string, state: "loaded" | "failed") => void;
    defaultViewport?: string | null;
}) {
    const [viewportId, setViewportId] = useState(VIEWPORTS.find((v) => v.id === defaultViewport)?.id ?? "iphone-15-pro");
    const [placing, setPlacing] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const viewport = VIEWPORTS.find((v) => v.id === viewportId) ?? VIEWPORTS[0];

    const place = (event: React.MouseEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
        setPlacing(false);
        onPoint?.({ x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000, viewport: viewport.id });
    };

    return (
        <div className="rounded-xl border border-slate-800 bg-slate-950/70" data-prototype-viewer={assetKey}>
            <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800 px-3 py-2 text-[11px] text-slate-300">
                {VIEWPORTS.map((v) => (
                    <button key={v.id} type="button" onClick={() => setViewportId(v.id)} aria-pressed={viewportId === v.id} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 ${viewportId === v.id ? "border-cyan-500/60 text-cyan-200" : "border-slate-700 hover:border-slate-500"}`}>
                        <v.icon size={12} /> {v.label}
                    </button>
                ))}
                <span className="font-mono text-slate-500">{viewport.width}×{viewport.height}</span>
                <button type="button" onClick={() => setReloadKey((k) => k + 1)} aria-label="Reload prototype" className="rounded-md border border-slate-700 p-1.5 hover:border-cyan-500/60"><RefreshCw size={12} /></button>
                <a href={src} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 hover:border-cyan-500/60"><ExternalLink size={12} /> Open full</a>
                {annotate && onPoint && (
                    <button type="button" onClick={() => setPlacing((p) => !p)} aria-pressed={placing} className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 font-semibold ${placing ? "border-cyan-300 bg-cyan-500/30 text-cyan-50" : "border-cyan-500/50 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/25"}`} data-prototype-place="">
                        <MousePointerClick size={13} /> {placing ? "Tap the prototype where the comment belongs" : "Place a comment"}
                    </button>
                )}
            </div>
            <div className="overflow-auto p-4">
                <div className="relative mx-auto" style={{ width: viewport.width, maxWidth: "100%", aspectRatio: `${viewport.width} / ${viewport.height}` }} data-prototype-stage="">
                    <iframe
                        key={reloadKey}
                        title={title}
                        src={src}
                        sandbox="allow-scripts allow-forms"
                        referrerPolicy="no-referrer"
                        className="h-full w-full rounded-lg border border-slate-700 bg-white"
                        onLoad={() => onLoadState?.(assetKey, "loaded")}
                        onError={() => onLoadState?.(assetKey, "failed")}
                    />
                    {placing && <div role="button" aria-label="Choose the spot for the comment" onClick={place} className="absolute inset-0 z-20 cursor-crosshair rounded-lg bg-cyan-400/10 ring-2 ring-cyan-300" data-prototype-overlay="" />}
                    {pins.filter((p) => !p.viewport || p.viewport === viewport.id).map((pin) => (
                        <button key={pin.id} type="button" data-point-pin={pin.id} onClick={() => onSelectPin?.(pin.id)} aria-label={`Comment ${pin.index}${pin.label ? `: ${pin.label}` : ""}`}
                            style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
                            className={`absolute z-10 flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border px-1 text-[10px] font-bold shadow ${selectedPinId === pin.id ? "border-cyan-200 bg-cyan-500 text-slate-950" : pin.resolved ? "border-emerald-200 bg-emerald-500 text-slate-950" : "border-amber-200 bg-amber-400 text-slate-950"}`}>
                            {pin.index}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
