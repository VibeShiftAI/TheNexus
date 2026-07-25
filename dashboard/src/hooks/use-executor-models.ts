"use client";

/**
 * useExecutorModelOptions — the per-executor model dropdown data used by every
 * dispatch surface (morning-plan HITL card, task-screen dispatch panel).
 *
 * Claude/codex options come from the discovered model roster; antigravity
 * options are the `agy models` display names (the only values the agy CLI
 * actually pins on). The operator-set defaults label the "(default)" option.
 */

import { useEffect, useState } from "react";
import {
  apiModelIdOf,
  filterClaudeModels,
  filterCodexModels,
  getAntigravityModels,
  getModelControlState,
} from "@/lib/model-control";

export type ExecutorName = "antigravity" | "codex" | "claude-code";
export const EXECUTOR_OPTIONS: ExecutorName[] = ["antigravity", "codex", "claude-code"];

/**
 * The managed default worker. Every dispatch surface starts here and only
 * exposes the full executor/model picker on explicit opt-in (progressive
 * disclosure) — an opinionated default beats a paradox-of-choice roster.
 */
export const DEFAULT_EXECUTOR: ExecutorName = "claude-code";

export interface ExecutorModelOption {
  id: string;
  label: string;
}

export interface ExecutorModelChoices {
  options: ExecutorModelOption[];
  /** The operator-set default model id ("" = the CLI's own default). */
  fallback: string;
  /** Which subscription the run bills to — shown in dropdown titles. */
  note: string;
}

export function useExecutorModelOptions(): {
  optionsFor: (executor: ExecutorName) => ExecutorModelChoices;
} {
  const [claudeModels, setClaudeModels] = useState<ExecutorModelOption[]>([]);
  const [claudeDefault, setClaudeDefault] = useState<string>("claude-opus-5");
  const [codexModels, setCodexModels] = useState<ExecutorModelOption[]>([]);
  const [codexDefault, setCodexDefault] = useState<string>("");
  const [antigravityModels, setAntigravityModels] = useState<ExecutorModelOption[]>([]);
  const [antigravityDefault, setAntigravityDefault] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    getModelControlState(null)
      .then((state) => {
        if (cancelled) return;
        const toOption = (m: Parameters<typeof apiModelIdOf>[0]) => ({
          id: apiModelIdOf(m),
          label: m.display_name || m.name || m.id,
        });
        setClaudeModels(filterClaudeModels(state.models).map(toOption));
        setCodexModels(filterCodexModels(state.models).map(toOption));
        if (state.claudeDefault) setClaudeDefault(state.claudeDefault);
        if (state.codexDefault) setCodexDefault(state.codexDefault);
        if (state.antigravityDefault) setAntigravityDefault(state.antigravityDefault);
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

  const optionsFor = (executor: ExecutorName): ExecutorModelChoices =>
    executor === "claude-code"
      ? { options: claudeModels, fallback: claudeDefault, note: "Claude" }
      : executor === "codex"
        ? { options: codexModels, fallback: codexDefault, note: "ChatGPT" }
        : { options: antigravityModels, fallback: antigravityDefault, note: "Google" };

  return { optionsFor };
}
