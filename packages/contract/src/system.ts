/**
 * nexus-shared — System & Telemetry Types
 *
 * Canonical type definitions for the /api/system/status and
 * /api/praxis/stats endpoints. Both the desktop dashboard
 * (TheNexus) and mobile app (Nexus-Mobile-Android) import
 * these types to stay in sync.
 */

// ─── Port / Process Info ────────────────────────────────────

export interface PortInfo {
  port: number;
  pid: number;
  process: string;
  address: string;
  protocol: string;
  hint: string | null;
  type: 'node' | 'python' | 'java' | 'other';
}

// ─── System Resources ───────────────────────────────────────

export interface SystemInfo {
  cpu: {
    usage: number;
    cores: number;
  };
  memory: {
    total: number;
    used: number;
    free: number;
    usagePercent: number;
  };
}

// ─── Praxis Agent Telemetry ─────────────────────────────────

export interface PraxisTelemetry {
  status: string;
  model: string;
  provider: string;
  mcpToolCount: number;
  neo4jNodes: number;
  pineconeVectors: number;
  port: number;
  dailyCallCount?: number;
  quota?: {
    date: string;
    resetTime: string;
    providers: Record<string, { requestsToday: number }>;
  };
}

// ─── Composite System Status ────────────────────────────────

export interface SystemStatus {
  timestamp: string;
  system: SystemInfo;
  ports: PortInfo[];
  portCount: number;
  error?: string;
  praxis?: PraxisTelemetry | null;
}

// ─── Budget Constants ───────────────────────────────────────

/** Daily API call budget thresholds (must match LLMManager) */
export const API_BUDGET = {
  WARNING: 500,
  AUTONOMOUS_LIMIT: 800,
  HARD_LIMIT: 1200,
} as const;
