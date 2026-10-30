// A model registry in the shape GET /api/model-control/available-models serves
// (Praxis src/models/registry.ts writes it). Shared by the picker tests.
const EXTENDED = ["low", "medium", "high", "xhigh", "max"];

export const MODEL_REGISTRY = {
    schemaVersion: 1,
    generatedAt: "2026-10-30T12:00:00.000Z",
    executors: {
        "claude-code": {
            executor: "claude-code",
            source: "fixture",
            models: [
                { id: "claude-opus-5-5", label: "Opus 5.5", efforts: EXTENDED, listed: true, current: true, defaultEffort: "medium" },
                { id: "claude-fable-5-1", label: "Fable 5.1", efforts: EXTENDED, listed: true, current: true, defaultEffort: "high" },
                { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: EXTENDED, listed: true, current: true },
                { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [], listed: true, current: false },
                { id: "claude-opus-5", label: "Opus 5", efforts: EXTENDED, listed: true, current: false },
                { id: "claude-opus-4-6", label: "Opus 4.6", efforts: ["low", "medium", "high", "max"], listed: true, current: false },
            ],
        },
        codex: {
            executor: "codex",
            source: "fixture",
            models: [
                { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: [...EXTENDED, "ultra"], listed: true, current: true, priority: 1 },
                { id: "gpt-6-astra", label: "GPT-6 Astra", efforts: [...EXTENDED, "ultra"], listed: true, current: true, priority: 2 },
                { id: "gpt-reserve", label: "GPT-Reserve", efforts: EXTENDED, listed: false, current: false, priority: 4 },
                { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: [...EXTENDED, "ultra"], listed: true, current: true, priority: 6 },
                { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", efforts: [...EXTENDED, "ultra"], listed: true, current: true, priority: 8 },
                { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"], listed: true, current: false, upgradeTo: "gpt-5.6-sol" },
            ],
        },
        antigravity: {
            executor: "antigravity",
            source: "fixture",
            models: [
                {
                    id: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["medium", "high", "low"], listed: true, current: true,
                    displayByEffort: { medium: "Gemini 4 Argon (Medium)", high: "Gemini 4 Argon (High)", low: "Gemini 4 Argon (Low)" },
                },
                {
                    id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "medium", "high"], listed: true, current: true,
                    displayByEffort: { low: "Claude Opus 5.5 (Low)", medium: "Claude Opus 5.5 (Medium)", high: "Claude Opus 5.5 (High)" },
                },
            ],
        },
    },
};
