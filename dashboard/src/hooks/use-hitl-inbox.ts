"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { HITLRequest, HITLResolution } from "@praxis/contract";
import { usePraxisStream } from "./use-praxis-stream";

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
 * Turn a refused resolve into something readable. The server explains itself
 * in the body (`detail`) — most importantly for "accept as-is", which this
 * surface cannot perform at all: that capability token is delivered only in
 * the card's push notification, so accepting is a phone action by design.
 * A bare "Resolve failed with 403" left Robert with nothing to act on
 * (2026-08-30, four refused taps across two days).
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
  const { recentEvents } = usePraxisStream();
  const [requests, setRequests] = useState<HITLRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pendingRequests = useMemo(
    () => requests.filter((request) => !request.resolution),
    [requests],
  );

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch("/api/praxis/hitl/pending", { cache: "no-store" });
      if (!response.ok) throw new Error(`HITL inbox returned ${response.status}`);
      const data = await response.json();
      setRequests(Array.isArray(data.requests) ? data.requests : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load HITL inbox");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (recentEvents.length === 0) return;
    const event = recentEvents[0];
    if (event.type === "hitl.created" && "request" in event) {
      const request = event.request as HITLRequest;
      setRequests((current) => [request, ...current.filter((item) => item.id !== request.id)]);
    }
    if (event.type === "hitl.resolved" && "requestId" in event) {
      const requestId = event.requestId as string;
      const resolution = event.resolution as HITLResolution | undefined;
      setRequests((current) =>
        current.map((item) =>
          item.id === requestId ? { ...item, resolution: resolution ?? item.resolution } : item,
        ),
      );
    }
  }, [recentEvents]);

  const resolveRequest = useCallback(async (requestId: string, input: ResolveInput) => {
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
  }, []);

  return {
    error,
    loading,
    pendingRequests,
    refresh,
    resolvingId,
    resolveRequest,
  };
}
