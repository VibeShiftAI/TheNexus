/**
 * AutonomyIndicator — the status-strip chip answering "is the fleet allowed to
 * start work right now?".
 *
 * Three real states plus unknown (see lib/autonomy.ts): running, an EXPLICIT
 * pause with who asked for it and when, and no-live-schedule. They are
 * deliberately distinct — an explicit stop also withholds corrections for work
 * Robert started by hand, no-schedule does not — and the full reason rides the
 * hover title and the accessible label.
 */
"use client";

import { PauseCircle, PlayCircle, CalendarOff, HelpCircle } from "lucide-react";
import { useAutonomy } from "@/hooks/use-autonomy";
import { deriveAutonomyView, formatSince, type AutonomyMode } from "@/lib/autonomy";

const ICONS: Record<AutonomyMode, typeof PlayCircle> = {
  running: PlayCircle,
  paused: PauseCircle,
  no_schedule: CalendarOff,
  unknown: HelpCircle,
};

/**
 * Chip contents for the strip. Exported separately from the data hook so the
 * strip can lay it out with its own button chrome.
 */
export function useAutonomyChip() {
  const { state, error } = useAutonomy();
  const view = deriveAutonomyView(error && !state ? null : state);
  const held = formatSince(view.since);
  const value =
    view.mode === "paused"
      ? `paused${view.who ? ` · ${view.who}` : ""}${held ? ` · ${held}` : ""}`
      : view.label;
  return { view, value, Icon: ICONS[view.mode] };
}

/** Standalone chip, for surfaces that are not the status strip. */
export function AutonomyIndicator({ className = "" }: { className?: string }) {
  const { view, value, Icon } = useAutonomyChip();
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/50 px-2 py-1 text-[11px] ${view.tone} ${className}`}
      title={view.reason}
      aria-label={`Autonomy: ${view.reason}`}
      tabIndex={0}
      role="status"
    >
      <Icon size={12} className="shrink-0" />
      <span className="font-semibold uppercase tracking-wide">{value}</span>
    </span>
  );
}
