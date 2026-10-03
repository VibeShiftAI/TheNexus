import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RoutingEconomicsPanel } from '../routing-economics-panel.tsx';
import economics from '../../../../server/services/routing-economics.js';
const run = { id: 'run-a', task_id: 'task-a', executor: 'codex', model: 'gpt-5.6-sol', tokens: 1e6, tokens_estimated: 1,
    outcome: 'failure', started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:00:10Z' };
async function renderWith(response, check) {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async url => { assert.equal(url, '/api/routing-economics'); return response; };
    const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
    try { await act(async () => root.render(React.createElement(RoutingEconomicsPanel))); await check(node); }
    finally { await act(async () => root.unmount()); node.remove(); globalThis.fetch = oldFetch; }
}
test('fetched comparison renders lane/model estimates, metric sample sizes and exact run links', async () => {
    const data = economics.aggregateRoutingEconomics([run]);
    await renderWith({ ok: true, json: async () => data }, async node => {
        assert.match(node.textContent, /Measured routing economics/);
        assert.match(node.textContent, /Local/); assert.match(node.textContent, /Cloud/);
        assert.match(node.textContent, /\$2\.525 estimate/);
        assert.match(node.textContent, /from 1 of 1 runs/);
        assert.match(node.textContent, /1 estimated/);
        assert.match(node.textContent, /0% completed/);
        assert.match(node.textContent, /1 failed/);
        assert.match(node.textContent, /No data/);
        assert.equal(node.querySelector('a[href="/task/task-a#dispatch-run-a"]').textContent.includes('run-a'), true);
    });
});
test('empty registry model and lanes show no data, never zero dollars or perfect success', async () => {
    const data = economics.aggregateRoutingEconomics([], [{ id: 'gemma', provider: 'local', is_active: 1 }]);
    await renderWith({ ok: true, json: async () => data }, async node => {
        assert.match(node.textContent, /gemma/); assert.match(node.textContent, /No data/);
        assert.doesNotMatch(node.querySelector('table').textContent, /\$0|100%/);
    });
});
test('read failure is visibly unavailable, not empty history, with a retry control', async () => {
    await renderWith({ ok: false }, async node => {
        assert.match(node.querySelector('[role="alert"]').textContent, /unavailable/i);
        assert.ok([...node.querySelectorAll('button')].some(b => /refresh/i.test(b.textContent)));
    });
});

import { TaskDispatchConsole } from '../task-view/dispatch-console.tsx';
test('an old deep-linked run is explicitly fetched and its output opens in the dispatch console', async () => {
    const oldFetch = globalThis.fetch;
    const oldScroll = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.history.replaceState(null, '', '/task/task-a#dispatch-old-run');
    let requested = false;
    globalThis.fetch = async url => {
        const u = String(url);
        if (u.includes('/api/dispatches?')) {
            const target = new URL(u, 'http://localhost').searchParams.get('include_id');
            requested ||= target === 'old-run';
            return new Response(JSON.stringify({ dispatches: target ? [{ ...run, id: 'old-run', output: 'Old run output evidence', kind: 'dispatch' }] : [] }));
        }
        if (u.includes('/api/dispatch-insight/')) return new Response('{}', { status: 503 });
        return new Response('{}');
    };
    const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
    try {
        await act(async () => root.render(React.createElement(TaskDispatchConsole, { taskId: 'task-a', projectId: null })));
        assert.equal(requested, true);
        assert.match(node.textContent, /Old run output evidence/);
    } finally {
        await act(async () => root.unmount()); node.remove(); globalThis.fetch = oldFetch;
        window.HTMLElement.prototype.scrollIntoView = oldScroll;
        window.history.replaceState(null, '', '/');
    }
});
