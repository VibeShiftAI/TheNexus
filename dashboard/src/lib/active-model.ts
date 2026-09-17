import { formatClaudeModelName } from "./model-control";

/** Return only a reported model; a bare CLI seat is a provider, not a model. */
export function activeModelName(value?: string): string | undefined {
  let model = value?.trim().replace(/\s*\((?:aggregator|round \d+)\)$/, "");
  if (!model) return undefined;
  if (model.startsWith("cli:")) {
    const slash = model.indexOf("/");
    if (slash < 0) return undefined;
    model = model.slice(slash + 1);
  }
  if (model.startsWith("anthropic/")) model = model.slice(10);
  if (model.startsWith("claude-")) return formatClaudeModelName(model);
  const gpt = model.match(/^gpt-([\d.]+)-([a-z]+)$/);
  if (gpt) return `GPT-${gpt[1]} ${gpt[2][0].toUpperCase()}${gpt[2].slice(1)}`;
  return model;
}
