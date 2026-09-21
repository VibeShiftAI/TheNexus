"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBoardState } from './use-board-state';
import { useDispatchState } from './use-dispatch-state';
import { useLiveBoardState } from '@/components/live-board-state';
import { deriveCurrentFocus, type FocusRequest } from '@/lib/current-focus';

/**
 * How often the derivation re-reads the clock. Freshness (a phase report older
 * than FRESH_MS, a feed that stopped refreshing) is a function of elapsed time,
 * not of a new snapshot arriving: during an outage the shared stores keep the
 * last good snapshot by reference, so without this tick the memo would never
 * recompute and a "Testing" row would stay fresh for as long as the feed is
 * down (QA finding, 2026-09-20).
 */
export const FOCUS_TICK_MS = 30_000;

// No new poller or model calls. The status strip passes the HITL snapshot it
// already reads; board, dispatch and progress stores are shared deck-wide.
export function useCurrentFocus(requests: FocusRequest[], inputError: string | null, refreshInput: () => Promise<void>) {
  const board = useBoardState();
  const dispatch = useDispatchState();
  const live = useLiveBoardState();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), FOCUS_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // `tick` is a dependency on purpose: it is what advances `now` between
  // snapshots. The feed status tells the derivation when `dispatch.state` is a
  // frozen last-good snapshot rather than a current read.
  const view = useMemo(
    () => deriveCurrentFocus({ projects: board.projects, state: dispatch.state, requests, events: live.recentEvents, now: Date.now(), feed: { available: !dispatch.error, snapshotAt: dispatch.updatedAt } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board.projects, dispatch.state, dispatch.error, dispatch.updatedAt, requests, live.recentEvents, tick],
  );
  const errors = [
    ...(dispatch.error ? ['Run and queue data could not refresh. Registry and queue data use the last available snapshot; live progress is evaluated separately.'] : []),
    ...(board.error ? ['Project and task data could not refresh. Project attribution may be incomplete.'] : []),
    ...(inputError ? ['Approval data could not refresh. The waiting list may be incomplete.'] : []),
    ...(dispatch.state && !dispatch.state.executors?.usageWaits?.available ? ['Saved continuation waits are unavailable. Some waiting tasks may be missing.'] : []),
  ];
  const refresh = useCallback(async () => { await Promise.allSettled([board.refresh(), dispatch.refresh(), refreshInput()]); }, [board.refresh, dispatch.refresh, refreshInput]);
  return {view, errors, loading:board.loading || (!dispatch.state && !dispatch.error), updatedAt:dispatch.updatedAt, connected:live.connected, refresh};
}
