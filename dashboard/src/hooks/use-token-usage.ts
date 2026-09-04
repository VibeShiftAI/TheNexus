/**
 * useTokenUsage — polls /api/token-usage (server-side 30s cache makes the
 * poll cheap) so the power station and the KPI strip share one live number.
 */
"use client";

import { useCallback, useState } from "react";
import { getTokenUsage, type TokenUsage } from "@/lib/token-usage";
import { useLiveRefetch } from "@/components/live-board-state";

export function useTokenUsage(pollMs = 60_000) {
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsage(await getTokenUsage());
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);

  // D-1: token spend is accumulated by the Nexus counter, not announced by
  // Praxis — no stream frame exists, so this stays a poll through the shared
  // mechanism. This is one of the surfaces the Phase 2 design flagged as
  // "poll is the only source": drop it and the number freezes.
  useLiveRefetch([], () => void load(), { fallbackPollMs: pollMs });

  return { usage, err };
}
