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
import { useLiveRefetch } from "@/components/live-board-state";
import { getBoardState } from "@/lib/nexus";
import type { BoardProject } from "@/lib/task-board";

const POLL_MS = 60_000;

type BoardSnapshot = { projects: BoardProject[] | null; error: boolean; updatedAt: string | null };
let snapshot: BoardSnapshot = { projects: null, error: false, updatedAt: null };
const subscribers = new Set<(p: BoardSnapshot) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await getBoardState();
      if (!Array.isArray(data)) throw new Error('Invalid board snapshot');
      snapshot = { projects: data, error: false, updatedAt: new Date().toISOString() };
    } catch {
      snapshot = { ...snapshot, error: true };
    } finally {
      for (const fn of subscribers) fn(snapshot);
      inflight = null;
    }
  })();
  return inflight;
}

function subscribe(fn: (p: BoardSnapshot) => void): () => void {
  subscribers.add(fn);
  fn(snapshot);
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
  const [state, setState] = useState<BoardSnapshot>(snapshot);
  useEffect(() => subscribe(setState), []);
  // P3-30 phase 2: a board frame refreshes the shared store immediately
  // instead of the deck waiting out the interval. The module-level 60s timer
  // above IS the fallback poll, so this subscription adds none of its own —
  // and refresh() coalesces, so N subscribers still make one request.
  useLiveRefetch(["board", "task"], refresh, { immediate: false, fallbackPollMs: 0 });
  return { ...state, loading: state.projects === null && !state.error, refresh };
}
