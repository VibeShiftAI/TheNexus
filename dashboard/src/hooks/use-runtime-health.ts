"use client";

import { useDispatchState } from '@/hooks/use-dispatch-state';

export interface RuntimeHealth {
  status: 'healthy' | 'degraded' | 'unknown';
  causes: { id: string; detail: string; href: string }[];
  unavailable: string[];
  reportCapturedAt?: string | null;
}

const UNKNOWN: RuntimeHealth = { status: 'unknown', causes: [], unavailable: ['Runtime health source'] };

/** All readers share dispatch-state's snapshot, poller, and failure flag. */
export function useRuntimeHealth(): RuntimeHealth {
  const { state, error } = useDispatchState();
  const health = state?.runtimeHealth;
  if (error || !health || !['healthy', 'degraded', 'unknown'].includes(health.status)
    || !Array.isArray(health.causes) || !health.causes.every(c => c && typeof c.detail === 'string' && typeof c.href === 'string')
    || !Array.isArray(health.unavailable)) return UNKNOWN;
  if (health.causes.length) return { ...health, status: 'degraded' };
  if (health.unavailable.length) return { ...health, status: 'unknown' };
  return health;
}

export function runtimeHealthLabel(health: RuntimeHealth): string {
  return health.status === 'degraded' ? 'Runtime degraded' : health.status === 'unknown' ? 'Status unknown' : 'Runtime healthy';
}
