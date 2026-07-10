/**
 * HUD kit — shared sci-fi chrome for the bridge: HudPanel (station shell with
 * corner brackets + scanlines), HudModal (drill-down popup any station opens
 * on click), and the accent palette that keeps stations color-coded.
 */
"use client";

import { Component, useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

export type HudAccent = "cyan" | "purple" | "amber" | "teal" | "pink" | "emerald" | "red";

const ACCENTS: Record<
  HudAccent,
  { text: string; bracket: string; hairline: string; modalBorder: string; modalGlow: string }
> = {
  cyan: {
    text: "text-cyan-400",
    bracket: "border-cyan-400/50",
    hairline: "via-cyan-400/40",
    modalBorder: "border-cyan-500/40",
    modalGlow: "shadow-[0_0_50px_rgba(34,211,238,0.18)]",
  },
  purple: {
    text: "text-purple-400",
    bracket: "border-purple-400/50",
    hairline: "via-purple-400/40",
    modalBorder: "border-purple-500/40",
    modalGlow: "shadow-[0_0_50px_rgba(192,132,252,0.18)]",
  },
  amber: {
    text: "text-amber-400",
    bracket: "border-amber-400/50",
    hairline: "via-amber-400/40",
    modalBorder: "border-amber-500/40",
    modalGlow: "shadow-[0_0_50px_rgba(251,191,36,0.16)]",
  },
  teal: {
    text: "text-teal-400",
    bracket: "border-teal-400/50",
    hairline: "via-teal-400/40",
    modalBorder: "border-teal-500/40",
    modalGlow: "shadow-[0_0_50px_rgba(45,212,191,0.18)]",
  },
  pink: {
    text: "text-pink-400",
    bracket: "border-pink-400/50",
    hairline: "via-pink-400/40",
    modalBorder: "border-pink-500/40",
    modalGlow: "shadow-[0_0_50px_rgba(244,114,182,0.18)]",
  },
  emerald: {
    text: "text-emerald-400",
    bracket: "border-emerald-400/50",
    hairline: "via-emerald-400/40",
    modalBorder: "border-emerald-500/40",
    modalGlow: "shadow-[0_0_50px_rgba(52,211,153,0.18)]",
  },
  red: {
    text: "text-red-400",
    bracket: "border-red-400/50",
    hairline: "via-red-400/40",
    modalBorder: "border-red-500/40",
    modalGlow: "shadow-[0_0_50px_rgba(248,113,113,0.18)]",
  },
};

export function accentText(accent: HudAccent) {
  return ACCENTS[accent].text;
}

function CornerBrackets({ accent }: { accent: HudAccent }) {
  const b = ACCENTS[accent].bracket;
  return (
    <>
      <span className={`pointer-events-none absolute left-0 top-0 h-2.5 w-2.5 rounded-tl border-l border-t ${b}`} />
      <span className={`pointer-events-none absolute right-0 top-0 h-2.5 w-2.5 rounded-tr border-r border-t ${b}`} />
      <span className={`pointer-events-none absolute bottom-0 left-0 h-2.5 w-2.5 rounded-bl border-b border-l ${b}`} />
      <span className={`pointer-events-none absolute bottom-0 right-0 h-2.5 w-2.5 rounded-br border-b border-r ${b}`} />
    </>
  );
}

export function HudPanel({
  icon,
  title,
  accent = "cyan",
  headerRight,
  headerCenter,
  className = "",
  children,
}: {
  icon: ReactNode;
  title: string;
  accent?: HudAccent;
  headerRight?: ReactNode;
  headerCenter?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const a = ACCENTS[accent];
  return (
    <div className={`hud-scanlines relative rounded-lg border border-slate-800 bg-slate-900/40 p-4 ${className}`}>
      {/* top hairline glow */}
      <span
        className={`pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent to-transparent ${a.hairline}`}
      />
      <CornerBrackets accent={accent} />
      <div className="mb-3 flex items-center gap-3">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <span className={a.text}>{icon}</span>
          <h3 className="truncate text-sm font-bold tracking-tight text-white">{title}</h3>
        </div>
        {headerCenter ? <div className="min-w-0 flex-1">{headerCenter}</div> : <div className="flex-1" />}
        {headerRight ? <div className="flex shrink-0 items-center gap-2">{headerRight}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function HudModal({
  title,
  icon,
  accent = "cyan",
  onClose,
  subtitle,
  wide = false,
  children,
}: {
  title: string;
  icon?: ReactNode;
  accent?: HudAccent;
  onClose: () => void;
  subtitle?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const a = ACCENTS[accent];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`hud-scanlines relative flex max-h-[84vh] w-full flex-col rounded-lg border bg-slate-950/95 ${a.modalBorder} ${a.modalGlow} ${
          wide ? "max-w-3xl" : "max-w-lg"
        } motion-safe:animate-[hud-pop_0.18s_ease-out]`}
      >
        <CornerBrackets accent={accent} />
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800/80 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {icon ? <span className={a.text}>{icon}</span> : null}
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold uppercase tracking-wider text-white">{title}</h2>
              {subtitle ? <p className="truncate text-[11px] text-slate-500">{subtitle}</p> : null}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-slate-800 bg-slate-900/60 p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

/**
 * HudErrorBoundary — keeps one crashing subsystem (e.g. the embedded
 * terminal mid-refactor by a crew executor) from taking the whole deck
 * dark. Shows a station-fault card instead.
 */
export class HudErrorBoundary extends Component<{ label?: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full min-h-24 flex-col items-center justify-center gap-1 rounded-lg border border-red-500/30 bg-red-950/20 p-4 text-center">
          <span className="text-[10px] font-bold uppercase tracking-widest text-red-300 motion-safe:animate-pulse">
            {this.props.label ?? "station"} fault
          </span>
          <span className="text-[11px] text-slate-500">
            Subsystem crashed — reload the deck once repairs land.
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Small labeled readout used inside drill-down modals. */
export function HudStat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/50 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${tone ?? "text-slate-200"}`}>{value}</div>
    </div>
  );
}
