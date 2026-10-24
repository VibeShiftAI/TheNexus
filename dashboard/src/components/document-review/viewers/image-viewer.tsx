"use client";

/**
 * Zoomable image stage with region comments and an optional before/after
 * comparison.
 *
 * Coordinates are normalized to the image (0..1) so a pin stays on the same
 * pixels at every zoom level and on every screen size. Dragging on the image
 * in "Pin a note" mode draws a region and hands it to `onRegion`; a plain
 * tap places nothing (so panning and selecting pins never create comments
 * by accident). Pin mode is on by default with a mouse and off on a touch
 * screen, where a finger on the image would otherwise draw instead of
 * scrolling (2026-10-24): there a tap opens the image full screen, and the
 * toolbar switches pinning on. Pins are numbered in comment order and
 * selecting one tells the review rail which comment to show.
 *
 * Every image here is a same-origin asset route; `onLoadState` reports
 * whether the browser actually decoded it, which the Evidence drawer turns
 * into "Visuals verified in this browser" (contract §5).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Columns2, Expand, Maximize2, Minus, Plus, SplitSquareHorizontal, SquareDashedMousePointer } from "lucide-react";
import type { Region } from "@/lib/document-review";
import { Lightbox } from "./lightbox";

export interface ImagePin {
    id: string;
    index: number;
    region?: Region | null;
    point?: { x: number; y: number } | null;
    label?: string | null;
    resolved?: boolean;
}

export interface ImageViewerProps {
    src: string;
    alt: string;
    assetKey: string;
    width?: number | null;
    height?: number | null;
    beforeSrc?: string | null;
    pins?: ImagePin[];
    selectedPinId?: string | null;
    onSelectPin?: (id: string) => void;
    /** Region drawing is offered only while a draft review is open on this revision. */
    annotate?: boolean;
    onRegion?: (region: Region) => void;
    onLoadState?: (assetKey: string, state: "loaded" | "failed") => void;
    /** Compact chrome for a filmstrip or a compare grid. */
    compact?: boolean;
    /** Opens full screen elsewhere (a design package runs its screens through one lightbox); by default the viewer opens its own. */
    onOpenFullScreen?: () => void;
    className?: string;
}

/** A touch screen: the browser's primary pointer cannot hover or draw precisely. Unknown (no window, no matchMedia) counts as fine. */
function coarsePointer(): boolean {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; }
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

export function ImageViewer({ src, alt, assetKey, width, height, beforeSrc, pins = [], selectedPinId = null, onSelectPin, annotate = false, onRegion, onLoadState, compact = false, onOpenFullScreen, className = "" }: ImageViewerProps) {
    const frameRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const [natural, setNatural] = useState<{ w: number; h: number } | null>(width && height ? { w: width, h: height } : null);
    const [fitScale, setFitScale] = useState(1);
    const [zoom, setZoom] = useState<number | "fit">("fit");
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [drawing, setDrawing] = useState(false);
    const [draft, setDraft] = useState<Region | null>(null);
    const [compare, setCompare] = useState<"off" | "slider" | "side">("off");
    const [split, setSplit] = useState(0.5);
    const [failed, setFailed] = useState(false);
    const [fullScreen, setFullScreen] = useState(false);
    // onStage: the pointer went down on the image itself. Pointer capture retargets the later events to the frame, so it is recorded here.
    const gesture = useRef<{ kind: "pan" | "draw" | "split"; startX: number; startY: number; originX: number; originY: number; moved: boolean; onStage?: boolean } | null>(null);

    const canPin = Boolean(annotate && onRegion);
    // Pin mode follows the review state (a draft opening turns it on with a mouse) and the pointer; the toolbar overrides it.
    const [pinMode, setPinMode] = useState(false);
    useEffect(() => { setPinMode(canPin && !coarsePointer()); }, [canPin]);
    const pinning = canPin && pinMode;
    const openFullScreen = () => { if (onOpenFullScreen) onOpenFullScreen(); else setFullScreen(true); };

    useEffect(() => { setZoom("fit"); setOffset({ x: 0, y: 0 }); setFailed(false); setDraft(null); }, [src]);

    // A cached image can finish before React attaches its load listener: read the element's own state once after mount.
    useEffect(() => {
        const img = imgRef.current;
        if (!img || !img.complete) return;
        if (img.naturalWidth > 0) {
            setNatural((prev) => (prev && prev.w === img.naturalWidth ? prev : { w: img.naturalWidth, h: img.naturalHeight || 1 }));
            onLoadState?.(assetKey, "loaded");
        } else {
            setFailed(true);
            onLoadState?.(assetKey, "failed");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, assetKey]);

    // Fit scale: how much the natural image shrinks to fill the frame width (never upscaled past 1 when fitting).
    useEffect(() => {
        const frame = frameRef.current;
        if (!frame || !natural) return;
        const measure = () => {
            const rect = frame.getBoundingClientRect();
            if (!rect.width) return;
            const maxH = compact ? rect.height || Infinity : Math.max(240, window.innerHeight - 260);
            setFitScale(Math.min(1, rect.width / natural.w, maxH / natural.h));
        };
        measure();
        const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
        observer?.observe(frame);
        window.addEventListener("resize", measure);
        return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
    }, [natural, compact]);

    const scale = zoom === "fit" ? fitScale : zoom;
    const shown = useMemo(() => natural ? { w: Math.round(natural.w * scale), h: Math.round(natural.h * scale) } : null, [natural, scale]);

    const stepZoom = (direction: 1 | -1) => {
        const current = scale;
        const next = direction > 0 ? ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] : [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0];
        setZoom(next);
        if (next <= fitScale + 0.001) setOffset({ x: 0, y: 0 });
    };

    const normalized = useCallback((clientX: number, clientY: number) => {
        const img = imgRef.current;
        if (!img) return null;
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: clamp((clientX - rect.left) / rect.width, 0, 1), y: clamp((clientY - rect.top) / rect.height, 0, 1) };
    }, []);

    const onPointerDown = (event: React.PointerEvent) => {
        if (event.button !== 0) return;
        const target = event.target as HTMLElement;
        if (target.closest("[data-image-pin]") || target.closest("[data-image-toolbar]")) return;
        if (target.closest("[data-split-handle]")) {
            gesture.current = { kind: "split", startX: event.clientX, startY: event.clientY, originX: split, originY: 0, moved: false };
        } else if (pinning && compare === "off") {
            const start = normalized(event.clientX, event.clientY);
            if (!start) return;
            gesture.current = { kind: "draw", startX: start.x, startY: start.y, originX: event.clientX, originY: event.clientY, moved: false };
            setDrawing(true);
        } else {
            gesture.current = { kind: "pan", startX: event.clientX, startY: event.clientY, originX: offset.x, originY: offset.y, moved: false, onStage: Boolean(target.closest("[data-image-stage]")) };
        }
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = (event: React.PointerEvent) => {
        const g = gesture.current;
        if (!g) return;
        if (g.kind === "pan") {
            const dx = event.clientX - g.startX;
            const dy = event.clientY - g.startY;
            if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
            if (scale > fitScale + 0.001) setOffset({ x: g.originX + dx, y: g.originY + dy });
        } else if (g.kind === "draw") {
            const now = normalized(event.clientX, event.clientY);
            if (!now) return;
            if (Math.abs(event.clientX - g.originX) + Math.abs(event.clientY - g.originY) > 4) g.moved = true;
            setDraft({ x: Math.min(g.startX, now.x), y: Math.min(g.startY, now.y), w: Math.abs(now.x - g.startX), h: Math.abs(now.y - g.startY) });
        } else if (g.kind === "split") {
            const img = imgRef.current;
            if (!img) return;
            const rect = img.getBoundingClientRect();
            setSplit(clamp((event.clientX - rect.left) / rect.width, 0.02, 0.98));
        }
    };

    const endGesture = () => {
        const g = gesture.current;
        gesture.current = null;
        setDrawing(false);
        if (g?.kind === "draw") {
            const region = draft;
            setDraft(null);
            if (region && g.moved && region.w >= 0.01 && region.h >= 0.01) onRegion?.({ x: round(region.x), y: round(region.y), w: round(region.w), h: round(region.h) });
        }
        return g;
    };

    const onPointerUp = () => {
        const g = endGesture();
        // A tap on the image outside pin mode opens it full screen; a drag, a pin or the toolbar never does.
        if (g?.kind === "pan" && !g.moved && g.onStage && !pinning && compare === "off" && !compact) openFullScreen();
    };

    const onWheel = (event: React.WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        stepZoom(event.deltaY < 0 ? 1 : -1);
    };

    const pinStyle = (pin: ImagePin): React.CSSProperties => {
        if (pin.region) return { left: `${pin.region.x * 100}%`, top: `${pin.region.y * 100}%`, width: `${pin.region.w * 100}%`, height: `${pin.region.h * 100}%` };
        if (pin.point) return { left: `${pin.point.x * 100}%`, top: `${pin.point.y * 100}%`, width: 0, height: 0 };
        return { display: "none" };
    };

    // In the flow above the image, never over it: on a phone the image is narrow enough that an overlaid bar hid its top.
    const toolbar = !compact && (
        <div data-image-toolbar="" className="mb-1.5 flex flex-wrap items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-950/85 p-1 text-[11px] text-slate-300">
            <button type="button" onClick={() => stepZoom(-1)} aria-label="Zoom out" className="rounded p-1 hover:bg-slate-800"><Minus size={13} /></button>
            <button type="button" onClick={() => { setZoom("fit"); setOffset({ x: 0, y: 0 }); }} className={`rounded px-1.5 py-1 font-mono hover:bg-slate-800 ${zoom === "fit" ? "text-cyan-200" : ""}`} aria-label="Fit to view" title="Fit">
                {Math.round(scale * 100)}%
            </button>
            <button type="button" onClick={() => stepZoom(1)} aria-label="Zoom in" className="rounded p-1 hover:bg-slate-800"><Plus size={13} /></button>
            <button type="button" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }} aria-label="Actual size" title="Actual pixels" className={`rounded p-1 hover:bg-slate-800 ${zoom === 1 ? "text-cyan-200" : ""}`}><Maximize2 size={13} /></button>
            {beforeSrc && (
                <>
                    <span className="mx-0.5 h-4 w-px bg-slate-700" />
                    <button type="button" onClick={() => setCompare((c) => (c === "slider" ? "off" : "slider"))} aria-pressed={compare === "slider"} className={`inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-slate-800 ${compare === "slider" ? "text-cyan-200" : ""}`} title="Before/after slider">
                        <SplitSquareHorizontal size={13} /> Before/after
                    </button>
                    <button type="button" onClick={() => setCompare((c) => (c === "side" ? "off" : "side"))} aria-pressed={compare === "side"} className={`rounded p-1 hover:bg-slate-800 ${compare === "side" ? "text-cyan-200" : ""}`} aria-label="Side by side" title="Side by side">
                        <Columns2 size={13} />
                    </button>
                </>
            )}
            {canPin && (
                <>
                    <span className="mx-0.5 h-4 w-px bg-slate-700" />
                    <button type="button" onClick={() => setPinMode((v) => !v)} aria-pressed={pinning} data-pin-mode={pinning ? "on" : "off"} title={pinning ? "Drag on the image to mark the region your note is about" : "Switch on to mark a region of the image for a note"} className={`inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-slate-800 ${pinning ? "bg-cyan-500/15 text-cyan-200" : ""}`}>
                        <SquareDashedMousePointer size={13} /> {pinning ? "Pinning · drag to mark" : "Pin a note"}
                    </button>
                </>
            )}
            <span className="mx-0.5 h-4 w-px bg-slate-700" />
            <button type="button" onClick={openFullScreen} aria-label="Full screen" title="Full screen" className="rounded p-1 hover:bg-slate-800" data-open-fullscreen=""><Expand size={13} /></button>
        </div>
    );

    const image = (source: string, role: "after" | "before", clip?: string) => (
        <img
            ref={role === "after" ? imgRef : undefined}
            src={source}
            alt={role === "before" ? `${alt} (before)` : alt}
            draggable={false}
            onLoad={(e) => {
                if (role !== "after") return;
                const el = e.currentTarget;
                if (!natural || natural.w !== el.naturalWidth) setNatural({ w: el.naturalWidth || 1, h: el.naturalHeight || 1 });
                setFailed(false);
                onLoadState?.(assetKey, el.naturalWidth > 0 ? "loaded" : "failed");
            }}
            onError={() => { if (role === "after") { setFailed(true); onLoadState?.(assetKey, "failed"); } }}
            style={{ width: shown ? `${shown.w}px` : undefined, height: shown ? `${shown.h}px` : undefined, maxWidth: shown ? undefined : "100%", clipPath: clip, position: role === "before" ? "absolute" : "relative", inset: role === "before" ? 0 : undefined }}
            className="block select-none bg-[conic-gradient(at_25%_25%,#0f172a_25%,#111827_0_50%,#0f172a_0_75%,#111827_0)] bg-[length:24px_24px]"
            data-image-role={role}
        />
    );

    return (
        <div className={`relative ${className}`} data-image-viewer={assetKey}>
            {toolbar}
            <div
                ref={frameRef}
                className={`relative overflow-auto rounded-xl border border-slate-800 bg-slate-950/70 ${compact ? "" : "min-h-[240px]"} ${drawing ? "cursor-crosshair" : scale > fitScale + 0.001 ? "cursor-grab" : pinning ? "cursor-crosshair" : compact ? "" : "cursor-zoom-in"}`}
                style={{ touchAction: pinning ? "none" : "pan-x pan-y" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={endGesture}
                onWheel={onWheel}
            >
                <div className={`flex ${compare === "side" ? "items-start gap-3 p-3" : "justify-center p-3"}`} style={{ transform: compare === "side" ? undefined : `translate(${offset.x}px, ${offset.y}px)` }}>
                    {compare === "side" && beforeSrc && (
                        <figure className="relative shrink-0">
                            {image(beforeSrc, "before")}
                            <figcaption className="absolute left-2 top-2 rounded bg-slate-950/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">Before</figcaption>
                        </figure>
                    )}
                    <div className="relative shrink-0" style={shown ? { width: shown.w, height: shown.h } : undefined} data-image-stage="">
                        {compare === "slider" && beforeSrc && image(beforeSrc, "before", `inset(0 ${100 - split * 100}% 0 0)`)}
                        {image(src, "after", compare === "slider" && beforeSrc ? `inset(0 0 0 ${split * 100}%)` : undefined)}
                        {compare === "slider" && beforeSrc && (
                            <>
                                <div data-split-handle="" className="absolute top-0 z-10 h-full w-0.5 -translate-x-1/2 cursor-col-resize bg-cyan-300 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" style={{ left: `${split * 100}%` }}>
                                    <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-300 bg-slate-950 px-1.5 py-0.5 text-[10px] text-cyan-100">◂ ▸</span>
                                </div>
                                <span className="absolute left-2 top-2 rounded bg-slate-950/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">Before</span>
                                <span className="absolute right-2 top-2 rounded bg-slate-950/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">After</span>
                            </>
                        )}
                        {/* Pins live in the image's own box, in percentages, so they track every zoom level. */}
                        {compare !== "side" && pins.map((pin) => (
                            <button
                                key={pin.id}
                                type="button"
                                data-image-pin={pin.id}
                                aria-label={`Comment ${pin.index}${pin.label ? `: ${pin.label}` : ""}`}
                                onClick={(e) => { e.stopPropagation(); onSelectPin?.(pin.id); }}
                                style={pinStyle(pin)}
                                className={`absolute z-10 ${pin.region ? "rounded-sm border-2" : ""} ${selectedPinId === pin.id ? "border-cyan-300 bg-cyan-400/15 shadow-[0_0_0_2px_rgba(34,211,238,0.35)]" : pin.resolved ? "border-emerald-400/70 bg-emerald-400/10" : "border-amber-300/90 bg-amber-300/10"}`}
                            >
                                <span className={`absolute -left-2.5 -top-2.5 flex h-5 min-w-5 items-center justify-center rounded-full border px-1 text-[10px] font-bold shadow ${selectedPinId === pin.id ? "border-cyan-200 bg-cyan-500 text-slate-950" : pin.resolved ? "border-emerald-200 bg-emerald-500 text-slate-950" : "border-amber-200 bg-amber-400 text-slate-950"}`}>
                                    {pin.index}
                                </span>
                            </button>
                        ))}
                        {draft && (
                            <div className="pointer-events-none absolute z-20 rounded-sm border-2 border-dashed border-cyan-300 bg-cyan-400/10" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }} data-image-draft="" />
                        )}
                    </div>
                </div>
                {failed && (
                    <div role="alert" className="absolute inset-0 flex items-center justify-center bg-slate-950/80 p-4 text-center text-xs text-rose-200" data-image-failed="">
                        This image did not load in the browser. The Evidence drawer lists the asset and its hash.
                    </div>
                )}
            </div>
            {!compact && natural && (
                <p className="mt-1 text-right font-mono text-[10px] text-slate-500">{natural.w}×{natural.h}px</p>
            )}
            {fullScreen && <Lightbox items={[{ src, alt, label: alt }]} index={0} onClose={() => setFullScreen(false)} />}
        </div>
    );
}

function round(value: number) { return Math.round(value * 10000) / 10000; }
