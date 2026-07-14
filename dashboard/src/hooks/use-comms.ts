/**
 * External-comms feed for the bridge COMMS indicator. Polls the praxis relay
 * (/api/praxis/comms) once a minute; "new" is everything newer than the
 * locally persisted last-seen mark, which markSeen() advances when the
 * operator opens the drill-down.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { getCommsFeed, type CommsFeed } from "@/lib/nexus";

const LAST_SEEN_KEY = "nexus.comms.lastSeen";
const POLL_MS = 60_000;

function getLastSeen(): string | null {
  try {
    return window.localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

export function useComms() {
  const [feed, setFeed] = useState<CommsFeed | null>(null);
  const [available, setAvailable] = useState(true);
  const [lastSeen, setLastSeen] = useState<string | null>(null);

  useEffect(() => {
    setLastSeen(getLastSeen());
    let cancelled = false;
    const load = async () => {
      try {
        const data = await getCommsFeed(getLastSeen() ?? undefined);
        if (!cancelled) {
          setFeed(data);
          setAvailable(true);
        }
      } catch {
        // Praxis down or feature not deployed — chip shows a quiet dash.
        if (!cancelled) setAvailable(false);
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const markSeen = useCallback(() => {
    const now = new Date().toISOString();
    try {
      window.localStorage.setItem(LAST_SEEN_KEY, now);
    } catch {
      /* private mode */
    }
    setLastSeen(now);
    setFeed((f) => (f ? { ...f, counts: { ...f.counts, new: 0 } } : f));
  }, []);

  const newCount = feed?.counts.new ?? 0;
  return { feed, newCount, available, lastSeen, markSeen };
}
