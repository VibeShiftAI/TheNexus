"use client";

import { useCallback, useState } from "react";
import { getAuthHeader } from "@/lib/auth";
import { useLiveRefetch } from "@/components/live-board-state";

/** Praxis /api/voice/status (proxied at /api/praxis/voice-status). */
export interface VoiceStatus {
  available: boolean;
  status: "green" | "yellow" | "red";
  reason: string;
  quotaExhaustedSince: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

/**
 * Is Praxis able to SPEAK right now? 2026-08-20/21 the ElevenLabs quota ran
 * dry and every spoken moment silently fell back to text for ~36h — nothing
 * on the bridge said so. The voice bar shows a muted badge off this.
 */
export function useVoiceStatus(pollMs = 5 * 60_000) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const load = useCallback(async () => {
    try {
      const headers = (await getAuthHeader()) as Record<string, string>;
      const res = await fetch("/api/praxis/voice-status", { credentials: "include", headers });
      if (!res.ok) return;
      const data = (await res.json()) as VoiceStatus;
      if (data && typeof data.available === "boolean") setStatus(data);
    } catch {
      /* best-effort — no badge when unknown */
    }
  }, []);

  // D-1: the TTS quota running dry is exactly the kind of thing Praxis does
  // not announce — that is why this hook exists. No stream frame, so the poll
  // IS the correctness guarantee; it just runs through the shared mechanism.
  useLiveRefetch([], () => void load(), { fallbackPollMs: pollMs });
  return status;
}
