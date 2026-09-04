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
import { useLiveRefetch } from "@/components/live-board-state";
import {
  apiModelIdOf,
  filterClaudeModels,
  filterCodexModels,
  filterOpenRouterModels,
  getAntigravityModels,
  getCredentialRouting,
  getModelControlState,
  type CredentialExecutorLane,
  type CredentialModelBlock,
  type CredentialProviderLane,
} from "@/lib/model-control";

export type ExecutorName = "antigravity" | "codex" | "claude-code" | "openrouter";
export const EXECUTOR_OPTIONS: ExecutorName[] = [
  "antigravity",
  "codex",
  "claude-code",
  // The FREE lane (2026-08-25). Last in the list deliberately: it is outside
  // the default rotation, so it runs when an operator asks for it by name.
  "openrouter",
];

/**
 * The free roster head — what an unpinned openrouter dispatch runs on.
 *
 * Keep this in step with `OPENROUTER_FREE_ROSTER[0]` in Praxis
 * (src/llm/openrouter-free.ts). It named `stealth/ox-alpha` until OpenRouter
 * withdrew that model on 2026-08-26, at which point this picker was offering
 * an executor/model pair that could not run — the same shape of stale
 * duplication that dropped the `openrouter` override on task a0077b4c.
 */
const OPENROUTER_DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

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
  /** Which credential the run spends — shown in dropdown titles. */
  note: string;
  /**
   * What choosing this executor costs, in words. The three CLIs bill a
   * subscription; the OpenRouter lane bills nothing, and a picker that said
   * "billed to the OpenRouter subscription" would be inventing one.
   */
  spendNote: string;
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
  const [openrouterModels, setOpenRouterModels] = useState<ExecutorModelOption[]>([]);
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
        setOpenRouterModels(filterOpenRouterModels(state.models).map(toOption));
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

  // D-1: credential/quota state per executor lane is polled from Praxis — no
  // stream frame describes a key going stale or a plan topping back up. Kept
  // as a poll through the shared mechanism. `immediate: false` preserves the
  // old behaviour: the gate renders from the lanes the caller already has and
  // the first refresh lands one interval in.
  useLiveRefetch([], refreshCredentials, {
    immediate: false,
    fallbackPollMs: CREDENTIAL_POLL_MS,
  });

  const credentialFor = (executor: ExecutorName): CredentialExecutorLane | null =>
    lanes.find((lane) => lane.name === executor) ?? null;

  const optionsFor = (executor: ExecutorName): ExecutorModelChoices => {
    const { options, fallback, note, spendNote } =
      executor === "claude-code"
        ? {
            options: claudeModels,
            fallback: claudeDefault,
            note: "Claude",
            spendNote: "billed to the Claude subscription",
          }
        : executor === "codex"
          ? {
              options: codexModels,
              fallback: codexDefault,
              note: "ChatGPT",
              spendNote: "billed to the ChatGPT subscription",
            }
          : executor === "openrouter"
            ? {
                options: openrouterModels,
                fallback: OPENROUTER_DEFAULT_MODEL,
                note: "OpenRouter",
                spendNote: "free — no subscription spent",
              }
            : {
                options: antigravityModels,
                fallback: antigravityDefault,
                note: "Google",
                spendNote: "billed to the Google subscription",
              };

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
      spendNote,
      credential,
      fallbackBlocked: fallback
        ? blockFor({ id: fallback, label: fallback })
        : missingKeyBlockFor(keyLane, ""),
      keyLane,
    };
  };

  return { optionsFor, credentialFor, providerKeys, refreshCredentials };
}
