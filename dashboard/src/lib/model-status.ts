/**
 * Model status board client — per-model reachability, why anything is held,
 * and the release control for each hold.
 *
 * Backed by Praxis's /api/models/status via the praxis relay. The release call
 * is loopback-only on the Praxis side; the relay runs on the same box, so the
 * browser posts to the relay and never talks to Praxis directly.
 */

export type ModelAvailability = "ready" | "executor-suspended" | "credits-out" | "cooling";

export interface ModelStatusRow {
    model: string;
    family: "claude" | "codex";
    executor: "claude-code" | "codex";
    /** Ladder tiers this model serves; [] when the router never picks it. */
    tiers: number[];
    state: ModelAvailability;
    reason: string | null;
    releasesAt: string | null;
    lastHitAt: string | null;
    /** POST as `target` to release. Null when there is nothing to release. */
    releaseTarget: string | null;
    releaseIsFamilyWide: boolean;
    isScorer: boolean;
    todayEvents: number;
    todayTokens: number;
}

export interface FamilyStatusRow {
    family: "claude" | "codex";
    executor: "claude-code" | "codex";
    available: boolean;
    reason: string | null;
    suspendedUntil: string | null;
    allModelsCooling: boolean;
    usedPercent: number | null;
    windowMinutes: number | null;
    quotaResetsAt: string | null;
    releaseTarget: string;
}

export interface ModelStatusBoard {
    generatedAt: string;
    models: ModelStatusRow[];
    families: FamilyStatusRow[];
    scorer: { model: string; mode: "cli" | "heuristic"; reachable: boolean };
    anySuspended: boolean;
}

export interface QuotaRestoreResult {
    target: string;
    family: "claude" | "codex" | null;
    executor: string | null;
    models: string[];
    executorReleased: boolean;
    chatCooldownsCleared: number;
    laneCooldownsCleared: number;
    summary: string;
}

export async function getModelStatusBoard(): Promise<ModelStatusBoard> {
    const res = await fetch("/api/praxis/models/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`Model status unavailable (${res.status})`);
    return res.json();
}

/**
 * Lift every hold a usage limit put on `target` — a family ("claude", "codex")
 * or a single model id. Praxis clears the router cooldown, the executor
 * circuit, and both lane cooldowns in one call (quota-restore.ts).
 */
export async function releaseModelHold(target: string): Promise<QuotaRestoreResult> {
    const res = await fetch("/api/praxis/usage/clear-limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Release failed (${res.status})`);
    }
    return res.json();
}

/** Ladder rungs rebuilt from the board, tier 5 (most capable) first. */
export interface LadderRung {
    tier: number;
    claude: ModelStatusRow | null;
    codex: ModelStatusRow | null;
    /** At least one side can take work at this tier. */
    dispatchable: boolean;
}

export function ladderFromBoard(board: ModelStatusBoard): LadderRung[] {
    const tiers = new Set<number>();
    for (const row of board.models) for (const t of row.tiers) tiers.add(t);
    return [...tiers]
        .sort((a, b) => b - a)
        .map((tier) => {
            const claude = board.models.find((r) => r.family === "claude" && r.tiers.includes(tier)) ?? null;
            const codex = board.models.find((r) => r.family === "codex" && r.tiers.includes(tier)) ?? null;
            return {
                tier,
                claude,
                codex,
                dispatchable: claude?.state === "ready" || codex?.state === "ready",
            };
        });
}

export const STATE_LABEL: Record<ModelAvailability, string> = {
    ready: "Ready",
    cooling: "Rate limited",
    "credits-out": "Credits out",
    "executor-suspended": "Executor suspended",
};

/** Tailwind classes per state — one source of truth for the panel's palette. */
export const STATE_STYLE: Record<ModelAvailability, { chip: string; dot: string; hex: string }> = {
    ready: {
        chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
        dot: "bg-emerald-400",
        hex: "#34d399",
    },
    cooling: {
        chip: "border-amber-500/30 bg-amber-500/10 text-amber-200",
        dot: "bg-amber-400",
        hex: "#fbbf24",
    },
    "credits-out": {
        chip: "border-red-500/30 bg-red-500/10 text-red-200",
        dot: "bg-red-400",
        hex: "#f87171",
    },
    "executor-suspended": {
        chip: "border-red-500/30 bg-red-500/10 text-red-200",
        dot: "bg-red-400",
        hex: "#f87171",
    },
};

/** "in 1h 30m" for a future ISO time; null when there is no clock. */
export function untilLabel(iso: string | null, now = Date.now()): string | null {
    if (!iso) return null;
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return null;
    const delta = at - now;
    if (delta <= 0) return "any moment";
    const mins = Math.round(delta / 60_000);
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hours < 24) return rem ? `in ${hours}h ${rem}m` : `in ${hours}h`;
    const days = Math.floor(hours / 24);
    return `in ${days}d ${hours % 24}h`;
}

export function shortModel(model: string): string {
    return model.replace(/^claude-/, "").replace(/^gpt-/, "");
}
