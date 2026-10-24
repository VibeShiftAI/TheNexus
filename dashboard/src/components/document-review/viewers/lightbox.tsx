"use client";

/**
 * Full-screen view of one image or of a run of them (a design package's
 * screens for the chosen direction and appearance). Pinch or drag to zoom and
 * pan, double-tap to zoom in and back out, swipe or use the arrows to move
 * between images, Escape or the close button to leave. Viewing only: notes
 * are pinned in the inline viewer, whose "Pin a note" mode stays where it was.
 *
 * Rendered through a portal so no ancestor transform (the inline viewer pans
 * its image with one) can trap the fixed overlay.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";

export interface LightboxItem {
    src: string;
    alt: string;
    label?: string | null;
}

export interface LightboxProps {
    items: LightboxItem[];
    index: number;
    onIndexChange?: (index: number) => void;
    onClose: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const DOUBLE_TAP_MS = 320;
const SWIPE_PX = 60;

type Gesture =
    | { kind: "pan"; startX: number; startY: number; originX: number; originY: number; moved: boolean }
    | { kind: "pinch"; startDistance: number; startZoom: number };

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

export function Lightbox({ items, index, onIndexChange, onClose }: LightboxProps) {
    const item = items[index] ?? items[0];
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const pointers = useRef(new Map<number, { x: number; y: number }>());
    const gesture = useRef<Gesture | null>(null);
    const lastTap = useRef(0);

    const reset = useCallback(() => { setZoom(1); setOffset({ x: 0, y: 0 }); }, []);
    useEffect(() => { reset(); }, [index, item?.src, reset]);

    const step = useCallback((delta: 1 | -1) => {
        if (items.length < 2) return;
        onIndexChange?.((index + delta + items.length) % items.length);
    }, [items.length, index, onIndexChange]);

    const zoomBy = useCallback((factor: number) => {
        setZoom((current) => {
            const next = clamp(current * factor, MIN_ZOOM, MAX_ZOOM);
            if (next <= MIN_ZOOM + 0.001) setOffset({ x: 0, y: 0 });
            return next;
        });
    }, []);

    // The page behind stays put, and the keyboard works the view.
    useEffect(() => {
        const body = document.body;
        const previous = body.style.overflow;
        body.style.overflow = "hidden";
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") { event.preventDefault(); onClose(); }
            else if (event.key === "ArrowRight") step(1);
            else if (event.key === "ArrowLeft") step(-1);
            else if (event.key === "+" || event.key === "=") zoomBy(1.25);
            else if (event.key === "-") zoomBy(0.8);
        };
        window.addEventListener("keydown", onKey);
        return () => { body.style.overflow = previous; window.removeEventListener("keydown", onKey); };
    }, [onClose, step, zoomBy]);

    const distance = () => {
        const [a, b] = [...pointers.current.values()];
        return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    };

    const onPointerDown = (event: React.PointerEvent) => {
        if (event.button !== 0 && event.pointerType === "mouse") return;
        if ((event.target as HTMLElement).closest("button")) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        if (pointers.current.size >= 2) {
            gesture.current = { kind: "pinch", startDistance: distance() || 1, startZoom: zoom };
        } else {
            gesture.current = { kind: "pan", startX: event.clientX, startY: event.clientY, originX: offset.x, originY: offset.y, moved: false };
        }
    };

    const onPointerMove = (event: React.PointerEvent) => {
        if (!pointers.current.has(event.pointerId)) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const g = gesture.current;
        if (!g) return;
        if (g.kind === "pinch") {
            if (pointers.current.size < 2) return;
            const next = clamp(g.startZoom * (distance() / g.startDistance), MIN_ZOOM, MAX_ZOOM);
            setZoom(next);
            if (next <= MIN_ZOOM + 0.001) setOffset({ x: 0, y: 0 });
        } else {
            const dx = event.clientX - g.startX;
            const dy = event.clientY - g.startY;
            if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
            if (zoom > MIN_ZOOM + 0.001) setOffset({ x: g.originX + dx, y: g.originY + dy });
        }
    };

    const onPointerUp = (event: React.PointerEvent) => {
        const had = pointers.current.delete(event.pointerId);
        const g = gesture.current;
        if (!had || !g) return;
        if (pointers.current.size > 0) {
            // One finger lifted after a pinch: the remaining one pans from where it is.
            const remaining = [...pointers.current.values()][0];
            gesture.current = { kind: "pan", startX: remaining.x, startY: remaining.y, originX: offset.x, originY: offset.y, moved: true };
            return;
        }
        gesture.current = null;
        if (g.kind !== "pan") return;
        const dx = event.clientX - g.startX;
        const dy = event.clientY - g.startY;
        if (!g.moved) {
            const now = Date.now();
            if (now - lastTap.current < DOUBLE_TAP_MS) {
                lastTap.current = 0;
                if (zoom > MIN_ZOOM + 0.001) reset(); else setZoom(2.5);
            } else {
                lastTap.current = now;
            }
            return;
        }
        if (zoom <= MIN_ZOOM + 0.001 && Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
    };

    const onPointerCancel = (event: React.PointerEvent) => {
        pointers.current.delete(event.pointerId);
        if (pointers.current.size === 0) gesture.current = null;
    };

    const onWheel = (event: React.WheelEvent) => {
        event.preventDefault();
        zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
    };

    if (!item || typeof document === "undefined") return null;

    return createPortal(
        <div role="dialog" aria-modal="true" aria-label={item.label ?? item.alt} className="fixed inset-0 z-[120] flex flex-col bg-black/95 text-slate-200" data-lightbox="" data-lightbox-index={index}>
            <div className="flex items-center gap-2 px-3 py-2 text-xs">
                <span className="min-w-0 truncate font-semibold text-slate-100" data-lightbox-title="">{item.label ?? item.alt}</span>
                {items.length > 1 && <span className="shrink-0 font-mono text-slate-400" data-lightbox-counter="">{index + 1} / {items.length}</span>}
                <span className="ml-auto flex shrink-0 items-center gap-0.5">
                    <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out" className="rounded p-1.5 hover:bg-slate-800"><Minus size={14} /></button>
                    <button type="button" onClick={reset} aria-label="Fit to screen" className="rounded px-1.5 py-1 font-mono hover:bg-slate-800">{Math.round(zoom * 100)}%</button>
                    <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in" className="rounded p-1.5 hover:bg-slate-800"><Plus size={14} /></button>
                    <button type="button" onClick={onClose} aria-label="Close full screen" className="ml-1 rounded p-1.5 hover:bg-slate-800" data-lightbox-close=""><X size={16} /></button>
                </span>
            </div>
            <div className="relative min-h-0 flex-1">
                <div
                    className={`absolute inset-0 flex items-center justify-center overflow-hidden ${zoom > MIN_ZOOM + 0.001 ? "cursor-grab" : "cursor-zoom-in"}`}
                    style={{ touchAction: "none" }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerCancel}
                    onWheel={onWheel}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={item.src}
                        alt={item.alt}
                        draggable={false}
                        className="max-h-full max-w-full select-none object-contain"
                        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`, transformOrigin: "center center" }}
                        data-lightbox-image=""
                    />
                </div>
                {items.length > 1 && (
                    <>
                        <button type="button" onClick={() => step(-1)} aria-label="Previous" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full border border-slate-700 bg-slate-950/80 p-2 text-slate-200 hover:bg-slate-800" data-lightbox-prev=""><ChevronLeft size={18} /></button>
                        <button type="button" onClick={() => step(1)} aria-label="Next" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-slate-700 bg-slate-950/80 p-2 text-slate-200 hover:bg-slate-800" data-lightbox-next=""><ChevronRight size={18} /></button>
                    </>
                )}
            </div>
            <p className="px-3 py-1.5 text-center text-[11px] text-slate-500">
                Pinch or double-tap to zoom{items.length > 1 ? " · swipe for the next screen" : ""} · Esc to close
            </p>
        </div>,
        document.body,
    );
}
