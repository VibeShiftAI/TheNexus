/**
 * useBoardState — one shared board-state poller for the whole deck.
 *
 * The :4000 API rate-limits aggressively, so N panels must not mean N poll
 * loops: a module-level store runs a single 60s fetch while anyone is
 * subscribed, concurrent refresh() calls (e.g. two stations' stream-refetch
 * debounces firing together) coalesce into one request, and every subscriber
 * shares the same snapshot.
 */
"use client";

import { useEffect, useState } from "react";
import { getBoardState } from "@/lib/nexus";
import type { BoardProject } from "@/lib/task-board";

const POLL_MS = 60_000;

let projects: BoardProject[] | null = null;
const subscribers = new Set<(p: BoardProject[]) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await getBoardState();
      projects = data || [];
      for (const fn of subscribers) fn(projects);
    } catch {
      /* keep the last snapshot */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function subscribe(fn: (p: BoardProject[]) => void): () => void {
  subscribers.add(fn);
  if (projects) fn(projects);
  if (!timer) {
    refresh();
    timer = setInterval(refresh, POLL_MS);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useBoardState() {
  const [state, setState] = useState<BoardProject[] | null>(projects);
  useEffect(() => subscribe(setState), []);
  return { projects: state, loading: state === null, refresh };
}
