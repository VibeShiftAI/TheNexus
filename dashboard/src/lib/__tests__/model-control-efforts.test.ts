import test from 'node:test';
import assert from 'node:assert/strict';
import { thinkingLevelOptions } from '../model-control.ts';

test('model control offers the exact live Astra efforts, including max and ultra', () => {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    assert.deepEqual(thinkingLevelOptions('gpt-6-astra', [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts }]), efforts);
});

test('model control respects narrower rosters and uses conservative unknown GPT efforts', () => {
    assert.deepEqual(thinkingLevelOptions('gpt-5.5', [{ id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] }]), ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(thinkingLevelOptions('gpt-unknown'), ['low', 'medium', 'high']);
    assert.deepEqual(thinkingLevelOptions('claude-opus-5'), ['low', 'medium', 'high', 'xhigh', 'max']);
});
