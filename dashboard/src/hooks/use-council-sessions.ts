"use client";

import { getCouncilSessions, isLiveSession } from "@/lib/council";
import { createSharedPoll } from "./shared-poll";

async function loadSessions() {
    // Ops displays the latest twelve sessions. The orb takes its five from this read.
    const data = await getCouncilSessions(12);
    return { ...data, fetchedAt: Date.now() };
}

const sessions = createSharedPoll(loadSessions);
export const refreshCouncilSessions = sessions.refresh;

const IDLE_MS = 30_000;
function opsCadence(snapshot: Awaited<ReturnType<typeof loadSessions>> | null) {
    return snapshot?.sessions.some(isLiveSession) ? 5_000 : IDLE_MS;
}

export function useCouncilSessions({ followLive = false } = {}) {
    return sessions.useSnapshot(followLive ? opsCadence : IDLE_MS);
}
