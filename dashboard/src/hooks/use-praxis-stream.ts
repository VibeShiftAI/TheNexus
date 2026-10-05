/**
 * usePraxisStream — subscribe to Praxis's outbound event stream via the
 * Nexus relay at /api/praxis/stream. Surfaces:
 *   - live PresenceState (the "what's Praxis doing right now" single snapshot)
 *   - last N events (default 50) for activity-feed / ticker style UIs
 *   - connection status
 *
 * The store itself (one shared EventSource, snapshot bootstrap, reopen with
 * backoff after the browser gives a source up, recovery through the shared
 * connection lifecycle) lives in `lib/praxis-stream-store.ts`; this hook binds
 * the app-wide instance to React. The public surface is unchanged.
 */
"use client";

import { useSyncExternalStore } from "react";
import {
    createPraxisStreamStore,
    type PraxisStreamState,
    type PraxisStreamStore,
} from "@/lib/praxis-stream-store";

export type { PraxisStreamState };

let store: PraxisStreamStore | null = null;

/** The app-wide store (created lazily; opening happens on first subscriber). */
export function getPraxisStreamStore(): PraxisStreamStore {
    if (!store) store = createPraxisStreamStore();
    return store;
}

/** Test seam: swap the shared store (e.g. for a provider test with a fake EventSource). */
export function __setPraxisStreamStoreForTests(instance: PraxisStreamStore | null): void {
    store = instance;
}

export function usePraxisStream(): PraxisStreamState {
    const s = getPraxisStreamStore();
    return useSyncExternalStore(s.subscribe, s.getSnapshot, s.getServerSnapshot);
}
