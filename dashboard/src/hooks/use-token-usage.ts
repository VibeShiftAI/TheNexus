"use client";

import { getTokenUsage } from "@/lib/token-usage";
import { createSharedPoll } from "./shared-poll";

const tokenUsage = createSharedPoll(getTokenUsage);

export function useTokenUsage(pollMs = 60_000) {
    const { value, error } = tokenUsage.useSnapshot(pollMs);
    return { usage: value, err: error };
}
