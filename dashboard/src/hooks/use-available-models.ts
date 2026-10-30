"use client";

/**
 * useAvailableModels: the model registry (every model each executor CLI
 * offers, GET /api/model-control/available-models), shared by every model
 * picker. Mounted pickers share one snapshot and one request; a mount after
 * REFRESH_MS reads the registry again, since Praxis rewrites it each morning.
 */

import { useEffect, useSyncExternalStore } from "react";
import { getAvailableModels, type AvailableModels } from "@/lib/model-control";

export interface AvailableModelsState {
  /** The registry; null while loading or when Praxis has not written one yet. */
  registry: AvailableModels | null;
  /** True once a load has settled, so "no registry" reads differently from "loading". */
  loaded: boolean;
}

const REFRESH_MS = 5 * 60_000;
const INITIAL_STATE: AvailableModelsState = { registry: null, loaded: false };

let state: AvailableModelsState = INITIAL_STATE;
let loadedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AvailableModelsState {
  return state;
}

function publish(next: AvailableModelsState) {
  state = next;
  for (const listener of [...listeners]) listener();
}

/** Fetch the registry into the shared snapshot. Concurrent callers share one request. */
export function loadAvailableModels(): Promise<void> {
  if (inFlight) return inFlight;
  if (state.loaded && loadedAt && Date.now() - loadedAt < REFRESH_MS) return Promise.resolve();
  inFlight = getAvailableModels()
    .then((registry) => {
      // A missing registry is not cached: the next mount asks again.
      loadedAt = registry ? Date.now() : 0;
      publish({ registry, loaded: true });
    })
    .catch(() => {
      // Keep the last good registry; the next mount tries again.
      publish({ registry: state.registry, loaded: true });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useAvailableModels(): AvailableModelsState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void loadAvailableModels();
  }, []);
  return snapshot;
}

/** Test seam: forget the cached registry. */
export function resetAvailableModels() {
  state = INITIAL_STATE;
  loadedAt = 0;
  inFlight = null;
  listeners.clear();
}
