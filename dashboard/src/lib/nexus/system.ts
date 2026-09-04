// ═══════════════════════════════════════════════════════════════
// SYSTEM MONITORING TYPES (from @praxis/contract)
// ═══════════════════════════════════════════════════════════════

import type {
  PortInfo as _PortInfo,
  SystemInfo as _SystemInfo,
  PraxisTelemetry as _PraxisTelemetry,
  SystemStatus as _SystemStatus,
} from '@praxis/contract';
import { API_URL, authFetch } from './shared';

export type PortInfo = _PortInfo;
export type SystemInfo = _SystemInfo;
export type PraxisTelemetry = _PraxisTelemetry;
export type SystemStatus = _SystemStatus;

/** Daily API call budget thresholds (mirrored from @praxis/contract) */
export const API_BUDGET = {
  WARNING: 500,
  AUTONOMOUS_LIMIT: 800,
  HARD_LIMIT: 1200,
} as const;

// ═══════════════════════════════════════════════════════════════
// SYSTEM MONITORING API
// ═══════════════════════════════════════════════════════════════

/**
 * Get current system status (ports, CPU, memory)
 */
export async function getSystemStatus(): Promise<SystemStatus> {
    const baseUrl = API_URL.replace('/projects', '');
    const res = await authFetch(`${baseUrl}/system/status`);
    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to get system status (${res.status}): ${errorText.slice(0, 100)}. Make sure to restart the backend server.`);
    }
    return res.json();
}

/**
 * Get AI token usage statistics
 */
