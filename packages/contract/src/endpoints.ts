/**
 * nexus-shared — Canonical service endpoints.
 *
 * Single source of truth for the localhost ports each process in the Praxis
 * ecosystem binds. Before this module these URLs were hardcoded in ~20 places
 * across Praxis and TheNexus; drift between them caused real outages.
 *
 * Consumers should resolve through `resolveEndpoints(env)` (passing their own
 * `process.env`) rather than reading literals, so a deployment can override any
 * endpoint without code changes. Pure data — no `process.env` access here, so
 * the module stays safe to import from browser/RN bundles.
 *
 * NOTE: TheCortex is Python and cannot import this package. Its
 * `cortex.config` defaults must be kept in sync with `DEFAULT_ENDPOINTS.cortex`
 * and `DEFAULT_ENDPOINTS.nexus` by hand.
 */

export const DEFAULT_ENDPOINTS = {
  /** Praxis agent runtime — SSE stream, presence, chat proxy target. */
  praxis: "http://127.0.0.1:54322",
  /** TheNexus Express API / SSE relay. */
  nexus: "http://localhost:4000",
  /** TheCortex FastAPI cognitive gateway. */
  cortex: "http://localhost:8100",
  /** Local LLM (LM Studio, OpenAI-compatible). */
  localLlm: "http://127.0.0.1:1234",
} as const;

export type EndpointName = keyof typeof DEFAULT_ENDPOINTS;

/** Env var that overrides each endpoint, if set. */
export const ENDPOINT_ENV_KEYS: Record<EndpointName, string> = {
  praxis: "PRAXIS_URL",
  nexus: "NEXUS_API_URL",
  cortex: "CORTEX_API_URL",
  localLlm: "LOCAL_LLM_URL",
};

/**
 * Resolve all endpoints, applying env overrides over the defaults. Pass the
 * caller's own env object (e.g. `resolveEndpoints(process.env)` in Node). An
 * empty/blank override is ignored so a stray `NEXUS_API_URL=` doesn't blank it.
 */
export function resolveEndpoints(
  env: Record<string, string | undefined> = {},
): Record<EndpointName, string> {
  const out = { ...DEFAULT_ENDPOINTS } as Record<EndpointName, string>;
  for (const name of Object.keys(DEFAULT_ENDPOINTS) as EndpointName[]) {
    const override = env[ENDPOINT_ENV_KEYS[name]]?.trim();
    if (override) out[name] = override;
  }
  return out;
}
