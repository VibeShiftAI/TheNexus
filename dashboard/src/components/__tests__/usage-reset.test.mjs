import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { UsageRoutingPanel } from '../usage-routing-panel.tsx';
import { untilLabel } from '../../lib/model-status.ts';

test('weekly meter, session end, cooldown and model release show the Eastern calendar reset', async (t) => {
    const now = Date.parse('2026-11-24T14:00:00Z');
    const reset = Date.parse('2026-11-28T06:18:13Z');
    const saturday = /Sat(?:urday)?,? Nov(?:ember)? 28,? 2026.*?01:18 EST/;
    t.mock.method(Date, 'now', () => now);
    const family = {
        today: { events: 0, inputTokens: 0, outputTokens: 0, byModel: {} },
        window: null, rateLimits: [], limit: { coolingDown: false },
    };
    const codex = { ...family, rateLimits: [{ usedPercent: 82, windowMinutes: 10080, resetsAt: reset }],
        limit: { coolingDown: true, resetAt: reset } };
    const claude = { ...family, window: { inputTokens: 1, outputTokens: 0, endsAt: reset } };
    t.mock.method(globalThis, 'fetch', async () => Response.json({
        generatedAt: now, families: { claude, codex }, recentDecisions: [],
    }));
    const node = document.createElement('div');
    const root = createRoot(node);
    try {
        await act(async () => root.render(React.createElement(UsageRoutingPanel)));
        for (const label of ['weekly quota', 'limit hit', '5h window:']) {
            const row = [...node.querySelectorAll('div, span')].find(el =>
                el.textContent.includes(label) && ![...el.children].some(child => child.textContent.includes(label)));
            assert.ok(row, label);
            assert.match((label === 'limit hit' ? row : row.parentElement).textContent, saturday);
        }
        assert.match(untilLabel(new Date(reset).toISOString(), now), saturday);
    } finally {
        await act(async () => root.unmount());
    }
});
