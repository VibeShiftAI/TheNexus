"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Minus, Plus, Type } from "lucide-react";

// ── Inbox font-size controller ──────────────────────────────────────────
// Inbox cards are dense with 10–14px text. Robert reads them every morning,
// so the inbox exposes a −/+ stepper that scales card text and remembers the
// choice per-browser. One scale covers the whole inbox — Morning Plan, skill
// candidates, archive proposals, and free-form questions alike (2026-08-17
// lift; it previously lived on the Morning Plan card only). The scale is
// applied as CSS custom properties on the inbox container (see
// inboxFontScaleStyle); card text classes reference them via
// `var(--hitl-fs-*, <native>)`, so every size stays proportional (an absolute
// length per level — no em-compounding) and any text that doesn't opt in
// keeps its native size.
const FONT_SCALE_KEY = "praxis.inbox.fontScale";
// Where the scale was saved while the stepper lived on the Morning Plan card.
// Read as a fallback so the saved preference survives the move; writes go to
// the new key only.
const LEGACY_FONT_SCALE_KEY = "praxis.morningPlan.fontScale";
const FONT_SCALE_MIN = 1;
const FONT_SCALE_MAX = 1.8;
const FONT_SCALE_STEP = 0.1;
const FONT_SCALE_DEFAULT = 1.3; // ~+3.6px on the 12px base

function clampFontScale(n: number): number {
  if (!Number.isFinite(n)) return FONT_SCALE_DEFAULT;
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, n));
  return Math.round(clamped * 100) / 100;
}

/** Inbox-wide font scale, hydrated from and persisted to localStorage. */
export function useInboxFontScale() {
  const [scale, setScale] = useState(FONT_SCALE_DEFAULT);

  // Hydrate after mount so SSR and the first client render agree (localStorage
  // isn't available during SSR).
  useEffect(() => {
    try {
      const saved =
        window.localStorage.getItem(FONT_SCALE_KEY) ??
        window.localStorage.getItem(LEGACY_FONT_SCALE_KEY);
      if (saved !== null) setScale(clampFontScale(Number(saved)));
    } catch {
      /* storage unavailable — keep the default */
    }
  }, []);

  const adjust = (delta: number) =>
    setScale((prev) => {
      const next = clampFontScale(prev + delta);
      try {
        window.localStorage.setItem(FONT_SCALE_KEY, String(next));
      } catch {
        /* storage unavailable — the in-memory value still applies */
      }
      return next;
    });

  return { scale, adjust };
}

/**
 * CSS custom properties carrying the scale to every card under the inbox
 * container. Each var is an absolute length so nested sizes stay proportional.
 */
export function inboxFontScaleStyle(scale: number): CSSProperties {
  return {
    "--hitl-fs-sm": `calc(${scale} * 0.875rem)`,
    "--hitl-fs-xs": `calc(${scale} * 0.75rem)`,
    "--hitl-fs-11": `calc(${scale} * 0.6875rem)`,
    "--hitl-fs-10": `calc(${scale} * 0.625rem)`,
  } as CSSProperties;
}

/** Compact −/+ stepper that drives useInboxFontScale. */
export function FontScaleControl({
  scale,
  onAdjust,
}: {
  scale: number;
  onAdjust: (delta: number) => void;
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-full border border-slate-700 bg-slate-900/60 px-1 py-0.5"
      title="Text size for the inbox (saved for next time)"
    >
      <Type className="mx-0.5 h-3 w-3 text-slate-400" aria-hidden />
      <button
        type="button"
        aria-label="Smaller inbox text"
        disabled={scale <= FONT_SCALE_MIN}
        onClick={() => onAdjust(-FONT_SCALE_STEP)}
        className="rounded p-0.5 text-slate-300 transition hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Minus className="h-3 w-3" />
      </button>
      <span className="min-w-[2.75rem] text-center text-[0.6875rem] tabular-nums text-slate-300">
        {Math.round(scale * 100)}%
      </span>
      <button
        type="button"
        aria-label="Larger inbox text"
        disabled={scale >= FONT_SCALE_MAX}
        onClick={() => onAdjust(FONT_SCALE_STEP)}
        className="rounded p-0.5 text-slate-300 transition hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}
