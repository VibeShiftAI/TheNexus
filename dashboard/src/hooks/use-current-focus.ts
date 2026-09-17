"use client";

import { useCallback, useMemo } from 'react';
import { useBoardState } from './use-board-state';
import { useDispatchState } from './use-dispatch-state';
import { useLiveBoardState } from '@/components/live-board-state';
import { deriveCurrentFocus, type FocusRequest } from '@/lib/current-focus';

// No new poller or model calls. The status strip passes the HITL snapshot it
// already reads; board, dispatch and progress stores are shared deck-wide.
export function useCurrentFocus(requests: FocusRequest[], inputError: string | null, refreshInput: () => Promise<void>) {
  const board = useBoardState();
  const dispatch = useDispatchState();
  const live = useLiveBoardState();
  const view = useMemo(() => deriveCurrentFocus({ projects: board.projects, state: dispatch.state, requests, events: live.recentEvents }), [board.projects, dispatch.state, requests, live.recentEvents]);
  const errors = [
    ...(dispatch.error ? ['Run and queue data could not refresh. Any displayed activity is the last available snapshot.'] : []),
    ...(board.error ? ['Project and task data could not refresh. Project attribution may be incomplete.'] : []),
    ...(inputError ? ['Approval data could not refresh. The waiting list may be incomplete.'] : []),
    ...(dispatch.state && !dispatch.state.executors?.usageWaits?.available ? ['Saved continuation waits are unavailable. Some waiting tasks may be missing.'] : []),
  ];
  const refresh = useCallback(async () => { await Promise.allSettled([board.refresh(), dispatch.refresh(), refreshInput()]); }, [board.refresh, dispatch.refresh, refreshInput]);
  return {view, errors, loading:board.loading || (!dispatch.state && !dispatch.error), updatedAt:dispatch.updatedAt, connected:live.connected, refresh};
}
