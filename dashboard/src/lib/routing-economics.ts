export interface EconomicsSummary {
  lane: "local" | "cloud" | "unknown";
  model?: string | null;
  state: "observed" | "no_data";
  runCount: number;
  latency: { medianMs: number | null; worstMs: number | null; runs: number };
  tokens: { total: number | null; runs: number; estimatedRuns: number };
  cost: { usd: number | null; provenance: "estimated" | "local_zero" | "unknown"; runs: number; estimatedRuns: number; meteredRuns: number; unknownRuns: number; unknownByReason: Record<string, number> };
  outcomes: { completed: number; failed: number; needsInput: number; cancelled: number; unfinished: number; runs: number; completionRate: number | null };
  runs?: { id: string; taskId: string; executor: string; outcome: string; startedAt: string; href: string }[];
}
export interface RoutingEconomics {
  generatedAt?: string;
  scope: string;
  costBasis: string;
  outcomeBasis: string;
  lanes: EconomicsSummary[];
  models: EconomicsSummary[];
}
