"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HITLRequest, HITLResolution } from "@praxis/contract";
import { useLiveBoardState, useLiveRefetch } from "@/components/live-board-state";
import { isAlertRequestExpired } from "@/lib/alert-action";

type ResolveInput = {
  choice?: string;
  freeText?: string;
  /**
   * Structured resolver-supplied payload. Used by the rich schedule card to
   * attach `{ scheduleOverrides: { executors, skips } }` so Robert's per-row
   * dropdown / skip-with-reason choices ride alongside the approve verb.
   * The Praxis side reads `resolution.payload.scheduleOverrides` and applies
   * them before activating the schedule.
   */
  payload?: Record<string, unknown>;
};

/**
 * Turn a refused resolve into something readable using the server's detail
 * or error message, with the HTTP status as a fallback.
 */
async function describeResolveFailure(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const detail = typeof body?.detail === "string" ? body.detail : undefined;
    if (detail) return detail;
    if (typeof body?.error === "string") return body.error;
  } catch {
    /* non-JSON body — fall through to the status */
  }
  return `Resolve failed with ${response.status}`;
}

export function useHitlInbox() {
  const { recentEvents } = useLiveBoardState();
  const [requests, setRequests] = useState<HITLRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readGeneration = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const resolvedIds = useRef(new Set<string>());
  const invalidateReads = useCallback(() => {
    readGeneration.current += 1;
    readController.current?.abort();
  }, []);
  const rememberResolution = useCallback((id: string) => {
    resolvedIds.current.add(id);
    if (resolvedIds.current.size > 1000) resolvedIds.current.delete(resolvedIds.current.values().next().value!);
  }, []);
  useEffect(() => () => invalidateReads(), [invalidateReads]);

  const pendingRequests = useMemo(
    () => requests.filter((request) => !request.resolution && !isAlertRequestExpired(request)),
    [requests],
  );

  const refresh = useCallback(async () => {
    invalidateReads();
    const generation = readGeneration.current;
    const controller = new AbortController(); readController.current = controller;
    const current = () => generation === readGeneration.current && !controller.signal.aborted;
    setRefreshing(true);
    try {
      setError(null);
      const response = await fetch("/api/praxis/hitl/pending", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      if (!response.ok) throw new Error(`HITL inbox returned ${response.status}`);
      const data = await response.json();
      if (current()) setRequests(Array.isArray(data.requests) ? data.requests.filter((request: HITLRequest) => !resolvedIds.current.has(request.id)) : []);
    } catch (err) {
      if (current()) setError(err instanceof Error ? err.message : "Unable to load HITL inbox");
    } finally {
      if (current()) { setLoading(false); setRefreshing(false); }
    }
  }, [invalidateReads]);

  // The optimistic list below is applied straight from the frame, which is
  // what makes the inbox feel instant; this refetch is the correctness half.
  // The badge is one of the few surfaces where being wrong is worse than being
  // slow — a resolved request still showing as pending sends Robert to an
  // empty card — so the `hitl` domain drives it and the 60s fallback stays.
  useLiveRefetch(["hitl"], () => void refresh(), {});

  useEffect(() => {
    if (recentEvents.length === 0) return;
    const event = recentEvents[0];
    if (event.type === "hitl.created" && "request" in event) {
      const request = event.request as HITLRequest;
      if (resolvedIds.current.has(request.id)) return;
      setRequests((current) => [request, ...current.filter((item) => item.id !== request.id)]);
      void refresh();
    }
    if (event.type === "hitl.resolved" && "requestId" in event) {
      const requestId = event.requestId as string;
      rememberResolution(requestId);
      const resolution = event.resolution as HITLResolution | undefined;
      setRequests((current) =>
        current.map((item) =>
          item.id === requestId ? { ...item, resolution: resolution ?? item.resolution } : item,
        ),
      );
      // A retained frame can be present on first mount. Replace the canceled
      // snapshot immediately so unrelated requests are not hidden until polling.
      void refresh();
    }
  }, [recentEvents, refresh, rememberResolution]);

  const resolveRequest = useCallback(async (requestId: string, input: ResolveInput) => {
    invalidateReads(); setLoading(false); setRefreshing(false);
    setResolvingId(requestId);
    setError(null);
    try {
      const response = await fetch(`/api/praxis/hitl/${encodeURIComponent(requestId)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await describeResolveFailure(response));
      const data = await response.json();
      if (data.request) {
        invalidateReads(); setLoading(false); setRefreshing(false);
        if (data.request.resolution) rememberResolution(requestId);
        setRequests((current) =>
          current.map((item) => (item.id === requestId ? data.request : item)),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to resolve HITL request");
      throw err;
    } finally {
      setResolvingId(null);
    }
  }, [invalidateReads, rememberResolution]);

  return {
    error,
    loading,
    refreshing,
    pendingRequests,
    refresh,
    resolvingId,
    resolveRequest,
  };
}
