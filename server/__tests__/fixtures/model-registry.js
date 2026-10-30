/** Write a model registry fixture and point the registry reader at it. Returns a cleanup function. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const levels = (...efforts) => efforts;

/** Codex and agy entries in the shape Praxis writes (src/models/registry.ts). */
const FIXTURE_EXECUTORS = {
    'claude-code': { executor: 'claude-code', source: 'fixture', models: [] },
    codex: {
        executor: 'codex',
        source: 'fixture',
        models: [
            { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), listed: true, current: true, defaultEffort: 'medium', priority: 1 },
            { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), listed: true, current: true, defaultEffort: 'low', priority: 6 },
            { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', efforts: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), listed: true, current: true, defaultEffort: 'medium', priority: 8 },
            { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: levels('low', 'medium', 'high', 'xhigh', 'max'), listed: true, current: true, defaultEffort: 'medium', priority: 9 },
            { id: 'gpt-5.5', label: 'GPT-5.5', efforts: levels('low', 'medium', 'high', 'xhigh'), listed: true, current: false, upgradeTo: 'gpt-5.6-sol', priority: 10 },
            { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', efforts: levels('low', 'medium', 'high', 'xhigh'), listed: true, current: true, priority: 11 },
            { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex-Spark', efforts: levels('low', 'medium', 'high', 'xhigh'), listed: true, current: true, priority: 12 },
            { id: 'gpt-reserve', label: 'GPT-Reserve', efforts: levels('low', 'medium', 'high', 'xhigh', 'max'), listed: false, current: false, priority: 4 },
            { id: 'codex-auto-review', label: 'Codex Auto Review', efforts: levels('low', 'medium', 'high', 'xhigh', 'max'), listed: false, current: false, priority: 43 },
        ],
    },
    antigravity: {
        executor: 'antigravity',
        source: 'fixture',
        models: [
            { id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['medium', 'high', 'low'], listed: true, current: true,
              displayByEffort: { medium: 'Gemini 4 Argon (Medium)', high: 'Gemini 4 Argon (High)', low: 'Gemini 4 Argon (Low)' } },
            { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', efforts: ['medium'], listed: true, current: true,
              displayByEffort: { medium: 'GPT-OSS 120B (Medium)' } },
        ],
    },
};

function useModelRegistryFixture(executors = FIXTURE_EXECUTORS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-model-registry-'));
    const file = path.join(dir, 'model-registry.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-30T12:00:00.000Z', executors }));
    const previous = process.env.PRAXIS_MODEL_REGISTRY_PATH;
    process.env.PRAXIS_MODEL_REGISTRY_PATH = file;
    require('../../services/model-registry').resetModelRegistryCache();
    return () => {
        process.env.PRAXIS_MODEL_REGISTRY_PATH = previous;
        require('../../services/model-registry').resetModelRegistryCache();
        fs.rmSync(dir, { recursive: true, force: true });
    };
}

module.exports = { FIXTURE_EXECUTORS, useModelRegistryFixture };
