// Counting wrapper for @/lib/normalizeMarkdown. normalizeMarkdown runs once
// per MarkdownMessage render, immediately before the ReactMarkdown/Prism
// pipeline, so this counter measures exactly how many message bodies were
// (re)parsed in a given window — the metric the render-isolation suite
// asserts on. Delegates to the real implementation.
import { normalizeMarkdown as realNormalizeMarkdown } from "../../src/lib/normalizeMarkdown.ts";

export const parseCounter = { count: 0 };

export function normalizeMarkdown(content) {
    parseCounter.count += 1;
    return realNormalizeMarkdown(content);
}
