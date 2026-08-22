"use client";

import { useEffect, useState } from "react";
import { getAuthHeader } from "@/lib/auth";

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
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const headers = (await getAuthHeader()) as Record<string, string>;
        const res = await fetch("/api/praxis/voice-status", { credentials: "include", headers });
        if (!res.ok) return;
        const data = (await res.json()) as VoiceStatus;
        if (active && data && typeof data.available === "boolean") setStatus(data);
      } catch {
        /* best-effort — no badge when unknown */
      }
    };
    load();
    const t = setInterval(load, pollMs);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [pollMs]);
  return status;
}
