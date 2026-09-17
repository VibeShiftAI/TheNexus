/** Model provider metadata does not change a selected CLI's authentication. */
export function dispatchModelKeyProvider(executor: string, provider?: string): string | null {
  const subscriptionProviders: Record<string, string> = {
    codex: "openai", "claude-code": "anthropic", antigravity: "google",
  };
  if (subscriptionProviders[executor] && (!provider || provider === subscriptionProviders[executor])) return null;
  return provider || (executor === "openrouter" ? "openrouter" : null);
}
