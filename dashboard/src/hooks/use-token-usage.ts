/**
 * useTokenUsage — polls /api/token-usage (server-side 30s cache makes the
 * poll cheap) so the power station and the KPI strip share one live number.
 */
"use client";

import { useEffect, useState } from "react";
import { getTokenUsage, type TokenUsage } from "@/lib/token-usage";

export function useTokenUsage(pollMs = 60_000) {
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await getTokenUsage();
        if (active) {
          setUsage(data);
          setErr(false);
        }
      } catch {
        if (active) setErr(true);
      }
    };
    load();
    const t = setInterval(load, pollMs);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [pollMs]);

  return { usage, err };
}
