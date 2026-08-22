"use client";

/**
 * useExecutorModelOptions — the per-executor model dropdown data used by every
 * dispatch surface (morning-plan HITL card, task-screen dispatch panel).
 *
 * Claude/codex options come from the discovered model roster; antigravity
 * options are the `agy models` display names (the only values the agy CLI
 * actually pins on). The operator-set defaults label the "(default)" option.
 *
 * Key-aware routing rides along: each executor carries the live state of the
 * credential it spends, and each model option carries its own block when the
 * provider put THAT model on a cooldown. A picker that still offers a spent
 * route is how a dead key gets discovered at the 402 instead of before the run.
 */

import { useCallback, useEffect, useState } from "react";
import {
  apiModelIdOf,
  filterClaudeModels,
  filterCodexModels,
  getAntigravityModels,
  getCredentialRouting,
  getModelControlState,
  type CredentialExecutorLane,
  type CredentialModelBlock,
  type CredentialProviderLane,
} from "@/lib/model-control";

export type ExecutorName = "antigravity" | "codex" | "claude-code";
export const EXECUTOR_OPTIONS: ExecutorName[] = ["antigravity", "codex", "claude-code"];

/**
 * The managed default worker. Every dispatch surface starts here and only
 * exposes the full executor/model picker on explicit opt-in (progressive
 * disclosure) — an opinionated default beats a paradox-of-choice roster.
 */
export const DEFAULT_EXECUTOR: ExecutorName = "claude-code";

/** How often the credential state is re-read. Blocks appear/expire on the
 *  minute scale (a usage window resets at a stated time), not the second. */
const CREDENTIAL_POLL_MS = 60_000;

export interface ExecutorModelOption {
  id: string;
  label: string;
  /** Provider identity retained for key-aware dispatch of a pinned model. */
  provider?: string;
  /** Set when the provider has this specific model on a cooldown. */
  blocked?: CredentialModelBlock | null;
}

export interface ExecutorModelChoices {
  options: ExecutorModelOption[];
  /** The operator-set default model id ("" = the CLI's own default). */
  fallback: string;
  /** Which subscription the run bills to — shown in dropdown titles. */
  note: string;
  /** Live credential state for this executor's lane; null while unknown. */
  credential: CredentialExecutorLane | null;
  /** Block on the executor's default model, when the default is itself spent. */
  fallbackBlocked: CredentialModelBlock | null;
  /**
   * The API-key lane this executor depends on, and null for the subscription
   * CLIs — they spend a subscription, not a key, so a missing key is NOT a
   * reason to exclude them (that mistake is the 2026-07-10 regression).
   */
  keyLane: CredentialProviderLane | null;
}

export function useExecutorModelOptions(): {
  optionsFor: (executor: ExecutorName) => ExecutorModelChoices;
  /** Credential lane for one executor, without rebuilding its model list. */
  credentialFor: (executor: ExecutorName) => CredentialExecutorLane | null;
  /** Which provider keys are present, for the surfaces that route per-token. */
  providerKeys: CredentialProviderLane[];
  /** Re-read credential state now (e.g. right after a dispatch attempt). */
  refreshCredentials: () => void;
} {
  const [claudeModels, setClaudeModels] = useState<ExecutorModelOption[]>([]);
  const [claudeDefault, setClaudeDefault] = useState<string>("claude-opus-5");
  const [codexModels, setCodexModels] = useState<ExecutorModelOption[]>([]);
  const [codexDefault, setCodexDefault] = useState<string>("");
  const [antigravityModels, setAntigravityModels] = useState<ExecutorModelOption[]>([]);
  const [antigravityDefault, setAntigravityDefault] = useState<string>("");
  const [lanes, setLanes] = useState<CredentialExecutorLane[]>([]);
  const [providerKeys, setProviderKeys] = useState<CredentialProviderLane[]>([]);

  useEffect(() => {
    let cancelled = false;
    getModelControlState(null)
      .then((state) => {
        if (cancelled) return;
        const toOption = (m: Parameters<typeof apiModelIdOf>[0]) => ({
          id: apiModelIdOf(m),
          label: m.display_name || m.name || m.id,
          provider: m.provider?.toLowerCase(),
        });
        setClaudeModels(filterClaudeModels(state.models).map(toOption));
        // Codex: the real roster (sol / terra / luna …) rides the options
        // payload; the family registry's single "GPT" row is only a fallback.
        const roster = Array.isArray(state.codexModels) ? state.codexModels : [];
        setCodexModels(
          roster.length > 0
            ? roster.map((m) => ({
                id: m.id,
                label: m.deprecated && m.upgradeTo ? `${m.label} (deprecated → ${m.upgradeTo})` : m.label,
                provider: "openai",
              }))
            : filterCodexModels(state.models).map(toOption),
        );
        if (state.claudeDefault) setClaudeDefault(state.claudeDefault);
        if (state.codexDefault) setCodexDefault(state.codexDefault);
        if (state.antigravityDefault) setAntigravityDefault(state.antigravityDefault);
        // Credentials ride the same options payload as the model roster, so
        // provider identity and its key verdict arrive together.
        if (state.credentials?.executors) setLanes(state.credentials.executors);
        if (state.credentials?.providers) setProviderKeys(state.credentials.providers);
      })
      .catch(() => {
        /* dropdown falls back to the default-only option */
      });
    getAntigravityModels()
      .then((names) => {
        if (!cancelled) setAntigravityModels(names.map((name) => ({ id: name, label: name })));
      })
      .catch(() => {
        /* dropdown falls back to the default-only option */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshCredentials = useCallback(() => {
    getCredentialRouting()
      .then((state) => {
        setLanes(state.executors || []);
        setProviderKeys(state.providers || []);
      })
      .catch(() => {
        /* keep the last-known lanes rather than blanking the gate */
      });
  }, []);

  useEffect(() => {
    const timer = setInterval(refreshCredentials, CREDENTIAL_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshCredentials]);

  const credentialFor = (executor: ExecutorName): CredentialExecutorLane | null =>
    lanes.find((lane) => lane.name === executor) ?? null;

  const optionsFor = (executor: ExecutorName): ExecutorModelChoices => {
    const { options, fallback, note } =
      executor === "claude-code"
        ? { options: claudeModels, fallback: claudeDefault, note: "Claude" }
        : executor === "codex"
          ? { options: codexModels, fallback: codexDefault, note: "ChatGPT" }
          : { options: antigravityModels, fallback: antigravityDefault, note: "Google" };

    const credential = credentialFor(executor);
    // This is the executor's own key dependency. It stays null for the three
    // subscription CLIs; an explicitly pinned option can still name its own
    // provider-key route below.
    const keyLane = credential?.requiresApiKey
      ? providerKeys.find((p) => p.provider === credential.provider) ?? null
      : null;
    const missingKeyBlockFor = (
      lane: CredentialProviderLane | null,
      modelId: string,
    ): CredentialModelBlock | null =>
      lane?.status === "missing_key"
        ? {
            model: modelId,
            code: "missing_key",
            reason: `${lane.credential} has no key present — ${lane.reason ?? "key absent"}`,
            until: null,
            observedAt: null,
          }
        : null;
    // An explicitly pinned discovered model names its provider, so it is a
    // provider-key route even though the unpinned CLI default remains a
    // subscription route. This makes missing-key filtering reachable from the
    // actual console without key-gating the three workers themselves.
    const blockFor = (option: ExecutorModelOption) => {
      const optionKeyLane = option.provider
        ? providerKeys.find((p) => p.provider === option.provider) ?? null
        : keyLane;
      return missingKeyBlockFor(optionKeyLane, option.id)
        ?? credential?.blockedModels.find((b) => b.model === option.id)
        ?? null;
    };

    return {
      options: options.map((option) => ({ ...option, blocked: blockFor(option) })),
      fallback,
      note,
      credential,
      fallbackBlocked: fallback
        ? blockFor({ id: fallback, label: fallback })
        : missingKeyBlockFor(keyLane, ""),
      keyLane,
    };
  };

  return { optionsFor, credentialFor, providerKeys, refreshCredentials };
}
