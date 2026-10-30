import test from 'node:test';
import assert from 'node:assert/strict';
import {
    findRegistryModel,
    registryModelLabel,
    registryModels,
    registryPickerOptions,
    thinkingLevelOptions,
} from '../model-control.ts';
import { MODEL_REGISTRY } from '../../../test/fixtures/model-registry.mjs';

test('model control offers the exact registry efforts, including max and ultra', () => {
    assert.deepEqual(thinkingLevelOptions('gpt-6-astra', MODEL_REGISTRY), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.deepEqual(thinkingLevelOptions('gpt-5.5', MODEL_REGISTRY), ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(thinkingLevelOptions('claude-opus-4-6', MODEL_REGISTRY), ['low', 'medium', 'high', 'max']);
    assert.deepEqual(thinkingLevelOptions('claude-sonnet-5-5', MODEL_REGISTRY), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('a model the registry cannot describe gets the conservative tiers, never a guess', () => {
    assert.deepEqual(thinkingLevelOptions('gpt-unknown', MODEL_REGISTRY), ['low', 'medium', 'high']);
    assert.deepEqual(thinkingLevelOptions('claude-opus-9'), ['low', 'medium', 'high']);
    // Haiku 4.5 reports no efforts at all.
    assert.deepEqual(thinkingLevelOptions('claude-haiku-4-5-20251001', MODEL_REGISTRY), ['low', 'medium', 'high']);
    // agy has no effort knob, so its entries never answer for a Claude id.
    assert.deepEqual(thinkingLevelOptions('gemini-4-argon', MODEL_REGISTRY), ['low', 'medium', 'high']);
});

test('registry models list current ones first and never a hidden one', () => {
    assert.deepEqual(
        registryModels(MODEL_REGISTRY, 'codex').map(m => m.id),
        ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'],
    );
    assert.deepEqual(
        registryModels(MODEL_REGISTRY, 'claude-code', { currentOnly: true }).map(m => m.id),
        ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'],
    );
    assert.deepEqual(registryModels(null, 'claude-code'), []);
});

test('ids resolve to registry labels, dated Claude aliases included', () => {
    assert.equal(registryModelLabel(MODEL_REGISTRY, 'gpt-6.1-sol'), 'GPT-6.1 Sol');
    assert.equal(registryModelLabel(MODEL_REGISTRY, 'claude-opus-5-5'), 'Opus 5.5');
    assert.equal(findRegistryModel(MODEL_REGISTRY, 'claude-haiku-4-5')?.id, 'claude-haiku-4-5-20251001');
    assert.equal(registryModelLabel(MODEL_REGISTRY, 'not-a-model'), null);
    assert.equal(registryModelLabel(null, 'gpt-6.1-sol'), null);
});

test('picker options carry what each executor stores, with readable labels', () => {
    const claude = registryPickerOptions(MODEL_REGISTRY, 'claude-code');
    assert.deepEqual(claude.slice(0, 3), [
        { value: 'claude-opus-5-5', label: 'Claude Opus 5.5', older: false },
        { value: 'claude-fable-5-1', label: 'Claude Fable 5.1', older: false },
        { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', older: false },
    ]);
    assert.ok(claude.slice(3).every(option => option.older), 'older models follow the current ones');

    const codex = registryPickerOptions(MODEL_REGISTRY, 'codex');
    assert.equal(codex.find(option => option.value === 'gpt-5.5')?.label, 'GPT-5.5 (deprecated → gpt-5.6-sol)');
    assert.ok(!codex.some(option => option.value === 'gpt-reserve'), 'hidden models are never offered');

    // agy pins display names, one per effort.
    assert.deepEqual(
        registryPickerOptions(MODEL_REGISTRY, 'antigravity').map(option => option.value),
        [
            'Gemini 4 Argon (Medium)', 'Gemini 4 Argon (High)', 'Gemini 4 Argon (Low)',
            'Claude Opus 5.5 (Low)', 'Claude Opus 5.5 (Medium)', 'Claude Opus 5.5 (High)',
        ],
    );
});
