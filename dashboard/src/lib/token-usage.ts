/**
 * Token-usage client — types + fetch for /api/token-usage, the daily token
 * throughput aggregated from CLI session logs (claude-code, codex) and the
 * Praxis cost ledger (local + cloud API). Antigravity has no telemetry.
 */

export interface TokenDay {
  date: string;
  claudeCode: number;
  codex: number;
  local: number;
  cloud: number;
  total: number;
}

export interface TokenUsage {
  today: TokenDay;
  record: { date: string; total: number };
  days: TokenDay[];
  antigravity: null;
  windowDays: number;
  computedAt: string;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

export async function getTokenUsage(): Promise<TokenUsage> {
  const res = await fetch("/api/token-usage", { cache: "no-store" });
  if (!res.ok) throw new Error(`token-usage failed (${res.status})`);
  return res.json();
}
