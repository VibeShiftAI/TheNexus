"use client";

/**
 * Bridge FX — the morning-cinema layer (Robert's 2026-07-17 flair batch).
 *
 * Two window CustomEvents drive it (dispatched by ai-terminal / cortex-provider):
 *
 *  - "praxis:morning-kickoff"  → the bridge POWER-UP sequence: panels light up
 *    in order (core viewer → dispatch → knowledge → taskboard → power →
 *    inbox rail → activity) with a staggered glow sweep.
 *  - "praxis:status-condition" ({ detail: { condition: "GREEN"|"YELLOW"|"RED" } })
 *    → the header tints the report's condition color, pulsing in and then
 *    settling to a subtle glow that clears after a few minutes.
 *
 * Everything here is presentation-only and failure-tolerant: a missing panel
 * id is skipped, and no listener ever throws into React.
 */

import { useEffect, useState } from "react";

export const MORNING_KICKOFF_EVENT = "praxis:morning-kickoff";
export const STATUS_CONDITION_EVENT = "praxis:status-condition";

/** Panel ids on the main bridge page, in power-up order. */
const POWER_UP_SEQUENCE = [
  "station-core",
  "station-dispatch",
  "station-knowledge",
  "station-taskboard",
  "station-power",
  "panel-inbox",
  "panel-activity",
];

const POWER_UP_STAGGER_MS = 240;
const POWER_UP_ANIM_MS = 1400;

export type BridgeCondition = "GREEN" | "YELLOW" | "RED";

const CONDITION_GLOW_MS = 5 * 60_000; // subtle tint lingers, then clears

export function dispatchMorningKickoff(): void {
  try {
    window.dispatchEvent(new CustomEvent(MORNING_KICKOFF_EVENT));
  } catch {
    /* presentation only */
  }
}

export function dispatchStatusCondition(condition: string): void {
  const c = condition?.toUpperCase?.();
  if (c !== "GREEN" && c !== "YELLOW" && c !== "RED") return;
  try {
    window.dispatchEvent(new CustomEvent(STATUS_CONDITION_EVENT, { detail: { condition: c } }));
  } catch {
    /* presentation only */
  }
}

function runPowerUpSequence(): void {
  POWER_UP_SEQUENCE.forEach((id, index) => {
    window.setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove("bridge-powerup"); // restart cleanly on re-trigger
      // Force a reflow so re-adding the class replays the animation.
      void el.offsetWidth;
      el.classList.add("bridge-powerup");
      window.setTimeout(() => el.classList.remove("bridge-powerup"), POWER_UP_ANIM_MS + 100);
    }, index * POWER_UP_STAGGER_MS);
  });
}

/**
 * Mount once on the bridge page: wires the power-up listener. Renders nothing.
 */
export function BridgeFX() {
  useEffect(() => {
    const onKickoff = () => runPowerUpSequence();
    window.addEventListener(MORNING_KICKOFF_EVENT, onKickoff);
    return () => window.removeEventListener(MORNING_KICKOFF_EVENT, onKickoff);
  }, []);
  return null;
}

/**
 * Header condition glow: returns the active condition (or null). The header
 * applies `bridge-condition-<color>` classes off this.
 */
export function useBridgeCondition(): BridgeCondition | null {
  const [condition, setCondition] = useState<BridgeCondition | null>(null);

  useEffect(() => {
    let clearTimer: number | undefined;
    const onCondition = (event: Event) => {
      const detail = (event as CustomEvent<{ condition?: BridgeCondition }>).detail;
      if (!detail?.condition) return;
      setCondition(detail.condition);
      if (clearTimer) window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => setCondition(null), CONDITION_GLOW_MS);
    };
    window.addEventListener(STATUS_CONDITION_EVENT, onCondition);
    return () => {
      window.removeEventListener(STATUS_CONDITION_EVENT, onCondition);
      if (clearTimer) window.clearTimeout(clearTimer);
    };
  }, []);

  return condition;
}

/** Tailwind-free class hook for the header element. */
export function conditionGlowClass(condition: BridgeCondition | null): string {
  if (condition === "GREEN") return "bridge-condition-green";
  if (condition === "YELLOW") return "bridge-condition-yellow";
  if (condition === "RED") return "bridge-condition-red";
  return "";
}
