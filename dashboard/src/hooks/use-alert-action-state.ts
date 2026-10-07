"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveRefetch } from '@/components/live-board-state';
import { authFetch } from '@/lib/nexus/shared';
import { EMPTY_ALERT_EVIDENCE, loadAlertEvidence, type AlertEvent } from '@/lib/alert-action';

export function useAlertActionState(events: readonly AlertEvent[]) {
  const [evidence, setEvidence] = useState(EMPTY_ALERT_EVIDENCE);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    // Do not keep presenting last round's pending decisions as current while
    // authoritative reads are unavailable or in flight.
    setEvidence(EMPTY_ALERT_EVIDENCE);
    void loadAlertEvidence(events, authFetch, next.signal).then(value => {
      if (!next.signal.aborted) setEvidence(value);
    });
  }, [events]);
  useLiveRefetch(['hitl', 'board'], refresh, { immediate: false });
  useEffect(() => { refresh(); return () => controller.current?.abort(); }, [refresh]);
  return { evidence, refresh };
}
