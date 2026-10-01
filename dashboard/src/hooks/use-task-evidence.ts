/**
 * useTaskEvidenceSummaries: verified/unverified state for a set of completed
 * tasks, for board badges (server/routes/task-evidence.js batch reader).
 *
 * Re-fetches only when the id set changes. A failed fetch leaves the map
 * empty rather than guessing: a card with no summary shows no evidence badge,
 * and never a green one.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { getTaskEvidenceSummaries, type EvidenceSummary } from "@/lib/task-evidence";

/** Server cap per batch request. */
const BATCH = 200;

export function useTaskEvidenceSummaries(taskIds: string[]): Map<string, EvidenceSummary> {
  const key = useMemo(() => [...new Set(taskIds)].sort().join(","), [taskIds]);
  const [byId, setById] = useState<Map<string, EvidenceSummary>>(() => new Map());

  useEffect(() => {
    if (!key) {
      setById(new Map());
      return;
    }
    const ids = key.split(",");
    let cancelled = false;
    (async () => {
      const next = new Map<string, EvidenceSummary>();
      try {
        for (let i = 0; i < ids.length; i += BATCH) {
          const chunk = await getTaskEvidenceSummaries(ids.slice(i, i + BATCH));
          for (const [id, summary] of Object.entries(chunk)) next.set(id, summary);
        }
        if (!cancelled) setById(next);
      } catch {
        if (!cancelled) setById(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  return byId;
}
