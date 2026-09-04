// Token usage stats + the Praxis usage monitor / model-routing view.
import { API_URL, authFetch } from './shared';

export interface TokenUsageEntry {
    timestamp: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    projectId: string | null;
    task: string | null;
}

export interface UsageStats {
    totals: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        estimatedCostUSD: number;
    };
    byProvider: Record<string, {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cost: number;
        callCount: number;
    }>;
    byModel: Record<string, {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cost: number;
        callCount: number;
    }>;
    recentUsage: TokenUsageEntry[];
    projectStats?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cost: number;
        callCount: number;
    };
}

// ═══════════════════════════════════════════════════════════════
// USAGE STATS API
// ═══════════════════════════════════════════════════════════════
export async function getUsageStats(options?: {
    projectId?: string;
    provider?: string;
    days?: number;
}): Promise<UsageStats> {
    const params = new URLSearchParams();
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.provider) params.set('provider', options.provider);
    if (options?.days) params.set('days', options.days.toString());

    const baseUrl = API_URL.replace('/projects', '');
    const url = params.toString()
        ? `${baseUrl}/ai/usage?${params.toString()}`
        : `${baseUrl}/ai/usage`;

    const res = await authFetch(url);
    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to get usage stats (${res.status}): ${errorText.slice(0, 100)}. Make sure to restart the backend server.`);
    }
    return res.json();
}

/**
 * Reset all usage statistics (requires confirmation)
 */
export async function resetUsageStats(): Promise<{ success: boolean; message: string }> {
    const baseUrl = API_URL.replace('/projects', '');
    const res = await authFetch(`${baseUrl}/ai/usage/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET_ALL_USAGE_STATS' })
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to reset usage stats');
    }
    return res.json();
}


// ── Usage monitor / model routing (Praxis via /api/usage-monitor proxy) ────

export interface UsageWindow {
    startedAt: number;
    endsAt: number;
    events: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

export interface UsageRateLimit {
    ts: number;
    windowMinutes: number;
    usedPercent: number;
    resetsAt: number | null;
    planType?: string;
}

export interface UsageFamilyState {
    today: {
        events: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        byModel: Record<string, { events: number; inputTokens: number; outputTokens: number }>;
        estCostUsd: number;
    };
    window: UsageWindow | null;
    rateLimits: UsageRateLimit[];
    limit: { coolingDown: boolean; lastHitAt: number | null; resetAt: number | null };
}

export interface RoutingDecision {
    ts: string;
    task_id: string | null;
    task_title: string | null;
    complexity: number | null;
    confidence: number | null;
    scorer: string | null;
    executor: string | null;
    model: string | null;
    thinking_level: string | null;
    applied: number;
    rationale: string | null;
}

export interface UsageMonitorState {
    generatedAt: number;
    families: { claude: UsageFamilyState; codex: UsageFamilyState };
    recentDecisions: RoutingDecision[];
}

export async function getUsageMonitorState(): Promise<UsageMonitorState> {
    const baseUrl = API_URL.replace(/\/projects$/, '');
    const res = await authFetch(`${baseUrl}/usage-monitor/state`);
    if (!res.ok) throw new Error("Failed to load usage monitor state");
    return res.json();
}
