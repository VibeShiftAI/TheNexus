"use client";

/**
 * Video and audio player built for review: a scrubber with comment markers,
 * frame stepping, playback speed, an in/out range, and "Comment at this
 * moment" which hands the current time (or the marked range) to the review
 * rail. The media is streamed from the same-origin asset route, which honours
 * Range requests, so seeking works on the phone through the tunnel.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronsLeft, ChevronsRight, MessageSquarePlus, Pause, Play, Repeat, Volume2, VolumeX } from "lucide-react";
import { formatSeconds } from "@/lib/document-review";

export interface TimeMarker {
    id: string;
    index: number;
    t_start: number;
    t_end?: number | null;
    label?: string | null;
    resolved?: boolean;
}

export interface VideoViewerProps {
    src: string;
    assetKey: string;
    kind: "video" | "audio";
    mimeType?: string;
    markers?: TimeMarker[];
    selectedMarkerId?: string | null;
    onSelectMarker?: (id: string) => void;
    annotate?: boolean;
    onTimestamp?: (range: { t_start: number; t_end?: number }) => void;
    onLoadState?: (assetKey: string, state: "loaded" | "failed") => void;
    /** Seek requests from outside (a comment tapped in the rail). */
    seekTo?: number | null;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const FRAME = 1 / 30;

export function VideoViewer({ src, assetKey, kind, mimeType, markers = [], selectedMarkerId = null, onSelectMarker, annotate = false, onTimestamp, onLoadState, seekTo }: VideoViewerProps) {
    const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
    const [playing, setPlaying] = useState(false);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [speed, setSpeed] = useState(1);
    const [muted, setMuted] = useState(false);
    const [range, setRange] = useState<{ in?: number; out?: number }>({});
    const [loop, setLoop] = useState(false);
    const [failed, setFailed] = useState(false);

    useEffect(() => { setRange({}); setFailed(false); setTime(0); setPlaying(false); }, [src]);

    // Metadata may already be there (cached media) before the listener is attached.
    useEffect(() => {
        const media = mediaRef.current;
        if (!media || media.readyState < 1) return;
        setDuration(media.duration || 0);
        onLoadState?.(assetKey, "loaded");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, assetKey]);

    useEffect(() => {
        if (seekTo === null || seekTo === undefined || !mediaRef.current) return;
        mediaRef.current.currentTime = seekTo;
        setTime(seekTo);
    }, [seekTo]);

    useEffect(() => {
        const media = mediaRef.current;
        if (!media) return;
        media.playbackRate = speed;
    }, [speed]);

    const toggle = () => {
        const media = mediaRef.current;
        if (!media) return;
        if (media.paused) void media.play().catch(() => setPlaying(false));
        else media.pause();
    };
    const seek = (t: number) => {
        const media = mediaRef.current;
        if (!media) return;
        const clamped = Math.max(0, Math.min(duration || t, t));
        media.currentTime = clamped;
        setTime(clamped);
    };
    const step = (frames: number) => { mediaRef.current?.pause(); seek(time + frames * FRAME); };

    const onTimeUpdate = () => {
        const media = mediaRef.current;
        if (!media) return;
        setTime(media.currentTime);
        if (loop && range.in !== undefined && range.out !== undefined && media.currentTime >= range.out) media.currentTime = range.in;
    };

    const pct = (t: number) => (duration ? `${(t / duration) * 100}%` : "0%");
    const Media = kind === "video" ? "video" : "audio";

    return (
        <div className="rounded-xl border border-slate-800 bg-slate-950/70" data-video-viewer={assetKey}>
            <div className={`relative ${kind === "video" ? "bg-black" : "flex items-center justify-center bg-slate-900/60 py-10"}`}>
                <Media
                    ref={mediaRef as React.RefObject<HTMLVideoElement>}
                    src={src}
                    playsInline
                    preload="metadata"
                    controls={false}
                    muted={muted}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onTimeUpdate={onTimeUpdate}
                    onLoadedMetadata={(e) => { const el = e.currentTarget; setDuration(el.duration || 0); setFailed(false); onLoadState?.(assetKey, "loaded"); }}
                    onError={() => { setFailed(true); onLoadState?.(assetKey, "failed"); }}
                    onClick={toggle}
                    className={kind === "video" ? "mx-auto max-h-[70vh] w-full" : "hidden"}
                    data-media-kind={kind}
                >
                    {mimeType ? <source src={src} type={mimeType} /> : null}
                </Media>
                {kind === "audio" && <Volume2 size={40} className="text-slate-600" />}
                {failed && (
                    <div role="alert" className="absolute inset-0 flex items-center justify-center bg-slate-950/80 p-4 text-center text-xs text-rose-200" data-video-failed="">
                        This {kind} did not load in the browser. The Evidence drawer lists the asset and its hash.
                    </div>
                )}
            </div>
            {/* Timeline with markers */}
            <div className="px-3 pt-3">
                <div className="relative h-7">
                    <input
                        type="range"
                        min={0}
                        max={duration || 0}
                        step={0.01}
                        value={Math.min(time, duration || 0)}
                        onChange={(e) => seek(Number(e.target.value))}
                        aria-label="Seek"
                        className="absolute inset-x-0 top-2 z-10 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-cyan-400"
                        data-video-seek=""
                    />
                    {range.in !== undefined && range.out !== undefined && (
                        <div className="pointer-events-none absolute top-2 h-1.5 rounded-full bg-cyan-400/40" style={{ left: pct(range.in), width: pct(range.out - range.in) }} />
                    )}
                    {markers.map((m) => (
                        <button
                            key={m.id}
                            type="button"
                            data-time-marker={m.id}
                            onClick={() => { seek(m.t_start); onSelectMarker?.(m.id); }}
                            aria-label={`Comment ${m.index} at ${formatSeconds(m.t_start)}`}
                            title={m.label ?? undefined}
                            style={{ left: pct(m.t_start), width: m.t_end && m.t_end > m.t_start ? `max(10px, ${((m.t_end - m.t_start) / (duration || 1)) * 100}%)` : undefined }}
                            className={`absolute top-4 z-20 flex h-4 min-w-[18px] -translate-x-1/2 items-center justify-center rounded-b-md border px-1 text-[9px] font-bold ${selectedMarkerId === m.id ? "border-cyan-200 bg-cyan-500 text-slate-950" : m.resolved ? "border-emerald-200 bg-emerald-500 text-slate-950" : "border-amber-200 bg-amber-400 text-slate-950"}`}
                        >
                            {m.index}
                        </button>
                    ))}
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pt-1 text-[11px] text-slate-300">
                <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"} className="rounded-md border border-slate-700 p-1.5 hover:border-cyan-500/60" data-video-toggle="">
                    {playing ? <Pause size={14} /> : <Play size={14} />}
                </button>
                {kind === "video" && (
                    <>
                        <button type="button" onClick={() => step(-1)} aria-label="Previous frame" className="rounded-md border border-slate-700 p-1.5 hover:border-cyan-500/60"><ChevronsLeft size={14} /></button>
                        <button type="button" onClick={() => step(1)} aria-label="Next frame" className="rounded-md border border-slate-700 p-1.5 hover:border-cyan-500/60"><ChevronsRight size={14} /></button>
                    </>
                )}
                <span className="font-mono tabular-nums" data-video-time="">{formatSeconds(time)} <span className="text-slate-500">/ {formatSeconds(duration)}</span></span>
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed" className="rounded-md border border-slate-700 bg-slate-900 px-1.5 py-1">
                    {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
                </select>
                <button type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? "Unmute" : "Mute"} className="rounded-md border border-slate-700 p-1.5 hover:border-cyan-500/60">{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
                <span className="mx-1 h-4 w-px bg-slate-700" />
                <button type="button" onClick={() => setRange((r) => ({ ...r, in: time, out: r.out !== undefined && r.out < time ? undefined : r.out }))} className={`rounded-md border px-2 py-1 ${range.in !== undefined ? "border-cyan-500/60 text-cyan-200" : "border-slate-700"}`} data-video-mark-in="">
                    In {range.in !== undefined ? formatSeconds(range.in) : ""}
                </button>
                <button type="button" onClick={() => setRange((r) => ({ ...r, out: time, in: r.in !== undefined && r.in > time ? undefined : r.in }))} className={`rounded-md border px-2 py-1 ${range.out !== undefined ? "border-cyan-500/60 text-cyan-200" : "border-slate-700"}`} data-video-mark-out="">
                    Out {range.out !== undefined ? formatSeconds(range.out) : ""}
                </button>
                <button type="button" onClick={() => setLoop((l) => !l)} aria-pressed={loop} disabled={range.in === undefined || range.out === undefined} aria-label="Loop the marked range" className={`rounded-md border p-1.5 disabled:opacity-40 ${loop ? "border-cyan-500/60 text-cyan-200" : "border-slate-700"}`}><Repeat size={14} /></button>
                {annotate && onTimestamp && (
                    <button
                        type="button"
                        onClick={() => onTimestamp(range.in !== undefined && range.out !== undefined ? { t_start: range.in, t_end: range.out } : { t_start: time })}
                        className="ml-auto inline-flex items-center gap-1 rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2.5 py-1.5 font-semibold text-cyan-100 hover:bg-cyan-500/25"
                        data-video-comment=""
                    >
                        <MessageSquarePlus size={13} /> {range.in !== undefined && range.out !== undefined ? `Comment on ${formatSeconds(range.in)}–${formatSeconds(range.out)}` : `Comment at ${formatSeconds(time)}`}
                    </button>
                )}
            </div>
        </div>
    );
}
