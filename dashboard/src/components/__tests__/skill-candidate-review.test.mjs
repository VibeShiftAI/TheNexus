import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { SkillCandidatesHitlCard } from '../schedule-hitl-card.tsx';

const candidate = { id: 'amend-1', name: 'Adjust rollout', category: 'operations', summary: 'Staged proposal' };
const eligible = {
    kind: 'skill-amendment', targetSkill: 'operations/rollout', state: 'eligible', summary: 'Narrow the rollout.',
    diff: '@@ -1 +1 @@\n-old\n+new', reviewId: 'review-one', scored: 2, total: 2,
    targetWins: 1, targetLosses: 0, regressions: [],
};

async function renderCard(t, getReview, { item = candidate, post = () => Response.json({ ok: true }) } = {}) {
    const requests = [];
    const decisions = [];
    const done = [];
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
        if (url === '/api/skill-candidates/' + encodeURIComponent(item.id) + '/review') {
            requests.push(options);
            return getReview();
        }
        assert.equal(url, '/api/skill-candidates/' + encodeURIComponent(item.id) + '/decide');
        assert.equal(options.method, 'POST');
        const body = JSON.parse(options.body);
        decisions.push(body);
        return post(body);
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    t.after(() => act(() => root.unmount()));
    const request = { id: 'morning', metadata: { kind: 'skill-candidates', date: '2026-11-03', skillCandidates: [item] } };
    function show(next) {
        return act(async () => root.render(createElement(SkillCandidatesHitlCard, { request: next, resolving: false, onResolve: async (...args) => done.push(args) })));
    }
    await show(request);
    const button = name => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === name);
    async function click(label) {
        const control = button(label);
        assert.ok(control, 'expected button ' + label);
        await act(async () => control.click());
    }
    const confirm = async () => {
        const checkbox = container.querySelector('input[type="checkbox"]');
        assert.ok(checkbox, 'reviewer explicitly confirms the displayed diff');
        await act(async () => checkbox.click());
    };
    return { container, button, click, confirm, decisions, done, requests, show, request };
}

test('an untyped legacy card can only approve a verified new skill and preserves Done', async t => {
    let resolve;
    const get = new Promise(r => { resolve = r; });
    const ui = await renderCard(t, () => get);
    assert.ok(!ui.button('Approve'));
    await act(async () => resolve(Response.json({ kind: 'new' })));
    await ui.click('Approve');
    assert.deepEqual(ui.decisions, [{ decision: 'approve' }]);
    assert.match(ui.container.textContent, /1\/1 decided/);
    await ui.click('Done');
    assert.deepEqual(ui.done, [['morning', { choice: 'done' }]]);
});

test('failed review lookup displays upstream detail and never falls back to install', async t => {
    const ui = await renderCard(t, () => Response.json({ error: 'Review storage unavailable.' }, { status: 503 }));
    assert.match(ui.container.textContent, /Review storage unavailable/);
    assert.ok(!ui.button('Approve'));
    assert.ok(!ui.button('Apply amendment'));
});

test('manual-change candidates retain Archive without offering install or apply', async t => {
    const ui = await renderCard(t, () => Response.json({ kind: 'skill-split' }));
    assert.ok(!ui.button('Approve'));
    assert.ok(!ui.button('Apply amendment'));
    assert.match(ui.container.textContent, /skill-split/);
    await ui.click('Archive');
    assert.deepEqual(ui.decisions, [{ decision: 'archive' }]);
    assert.ok(ui.button('Archived'));
});

for (const [state, label] of [['awaiting', /awaiting evaluation/i], ['regressed', /regression/i], ['no-improvement', /no improvement/i], ['stale', /re-evaluate/i]]) {
    test('amendment status ' + state + ' replaces generic approval', async t => {
        const ui = await renderCard(t, () => Response.json({ ...eligible, state, reviewId: null, regressions: state === 'regressed' ? ['control-7'] : [] }));
        assert.ok(!ui.button('Approve'));
        assert.ok(!ui.button('Apply amendment'));
        assert.match(ui.container.textContent, label);
        assert.match(ui.container.textContent, /operations\/rollout/);
        if (state === 'regressed') assert.match(ui.container.textContent, /control-7/);
    });
}

test('reviewing the newly opened diff binds Apply to its exact review id', async t => {
    let current = eligible;
    const ui = await renderCard(t, () => Response.json(current));
    assert.ok(!ui.button('Approve'));
    assert.match(ui.container.textContent, /2\/2 scored/i);
    assert.match(ui.container.textContent, /1 target win/i);
    assert.match(ui.container.textContent, /0 target losses/i);
    assert.match(ui.container.textContent, /Narrow the rollout/);
    assert.ok(!ui.button('Apply amendment'));
    current = { ...eligible, diff: '-previous\n+current', reviewId: 'review-two' };
    await ui.click('Review diff');
    assert.equal(ui.container.querySelector('pre')?.textContent, current.diff);
    assert.ok(!ui.button('Apply amendment'));
    await ui.confirm();
    await ui.click('Apply amendment');
    assert.deepEqual(ui.decisions, [{ decision: 'apply-amendment', reviewId: 'review-two' }]);
    assert.match(ui.container.textContent, /Amendment applied/);
    assert.match(ui.container.textContent, /1\/1 decided/);
});

test('closing and reopening discards consent and fetches changed evidence', async t => {
    let current = eligible;
    const ui = await renderCard(t, () => Response.json(current));
    await ui.click('Review diff');
    await ui.confirm();
    await ui.click('Hide diff');
    assert.ok(!ui.button('Apply amendment'));
    current = { ...eligible, state: 'regressed', reviewId: null, regressions: ['control-2'] };
    await ui.click('Review diff');
    assert.match(ui.container.textContent, /control-2/);
    assert.ok(!ui.button('Apply amendment'));
});

test('a stale apply response invalidates consent and reports the server conflict', async t => {
    const ui = await renderCard(t, () => Response.json(eligible), { post: () => Response.json({ error: 'Target changed on disk.' }, { status: 409 }) });
    await ui.click('Review diff');
    await ui.confirm();
    await ui.click('Apply amendment');
    assert.ok(!ui.button('Apply amendment'));
    assert.match(ui.container.textContent, /Target changed on disk/);
    assert.match(ui.container.textContent, /re-evaluate/i);
    assert.match(ui.container.textContent, /0\/1 decided/);
});

test('a nominally eligible but incomplete pair cannot be applied', async t => {
    const ui = await renderCard(t, () => Response.json({ ...eligible, scored: 1 }));
    await ui.click('Review diff');
    assert.equal(ui.container.querySelector('input[type="checkbox"]'), null);
    assert.ok(!ui.button('Apply amendment'));
});

test('a late earlier lookup cannot turn the current amendment into an installable skill', async t => {
    let resolve;
    const slow = new Promise(r => { resolve = r; });
    let count = 0;
    const ui = await renderCard(t, () => ++count === 1 ? slow : Response.json({ ...eligible, state: 'awaiting' }));
    await ui.click('Reload review');
    await act(async () => resolve(Response.json({ kind: 'new' })));
    assert.match(ui.container.textContent, /awaiting evaluation/i);
    assert.ok(!ui.button('Approve'));
});

test('a card tagged as a modification cannot install even if the lookup returns new', async t => {
    const ui = await renderCard(t, () => Response.json({ kind: 'new' }), { item: { ...candidate, kind: 'skill-retirement' } });
    assert.ok(!ui.button('Approve'));
    assert.match(ui.container.textContent, /kind has changed/i);
});

test('a missing success acknowledgement leaves the amendment undecided', async t => {
    const ui = await renderCard(t, () => Response.json(eligible), { post: () => Response.json({ ok: false, error: 'Write not confirmed.' }) });
    await ui.click('Review diff');
    await ui.confirm();
    await ui.click('Apply amendment');
    assert.match(ui.container.textContent, /0\/1 decided/);
    assert.doesNotMatch(ui.container.textContent, /Amendment applied/);
    assert.match(ui.container.textContent, /Write not confirmed/);
    assert.ok(!ui.button('Apply amendment'));
});

test('a stale lookup response advises re-evaluation and retains the upstream detail', async t => {
    const ui = await renderCard(t, () => Response.json({ error: 'Target was replaced.', state: 'stale' }, { status: 409 }));
    assert.match(ui.container.textContent, /Target was replaced/);
    assert.match(ui.container.textContent, /re-evaluate/i);
    assert.ok(!ui.button('Approve'));
});

test('a newly opened card cannot inherit a terminal decision for a reused candidate id', async t => {
    const ui = await renderCard(t, () => Response.json({ kind: 'new' }));
    await ui.click('Approve');
    await ui.show({ ...ui.request, id: 'next-day' });
    assert.match(ui.container.textContent, /0\/1 decided/);
    assert.equal(ui.button('Approve')?.disabled, false);
});

test('changing a card hint drops a prior install decision while the replacement lookup is pending', async t => {
    let current = Promise.resolve(Response.json({ kind: 'new' }));
    const ui = await renderCard(t, () => current);
    assert.ok(ui.button('Approve'));
    current = new Promise(() => {});
    await ui.show({ ...ui.request, metadata: { ...ui.request.metadata, skillCandidates: [{ ...candidate, kind: 'skill-split' }] } });
    assert.ok(!ui.button('Approve'));
});

test('long wrapper proposals lead with target and outcome and disclose their full summary on demand', async t => {
    const fullSummary = 'First narrow the pilot.\n\n' + 'Keep this detailed explanation. '.repeat(55);
    const wrapper = 'skill-gardener-rollout-checklist-2026-10-15';
    const ui = await renderCard(t, () => Response.json({ ...eligible, summary: fullSummary }), {
        item: { ...candidate, id: wrapper, name: wrapper, summary: fullSummary },
    });
    const row = ui.container.querySelector('li');
    const heading = row.firstElementChild.textContent;
    assert.match(heading, /operations\/rollout/);
    assert.match(heading, /Eligible to apply/);
    assert.ok(!row.textContent.includes(wrapper));
    const toggle = [...row.querySelectorAll('details > summary')].find(el => el.textContent === 'Change summary');
    assert.ok(toggle);
    const details = toggle.parentElement;
    assert.ok(!details.open);
    const collapsedRow = row.cloneNode(true);
    collapsedRow.querySelectorAll('details').forEach(el => el.remove());
    assert.ok(!collapsedRow.textContent.includes('Keep this detailed explanation'));
    assert.match(collapsedRow.textContent, /2\/2 scored/);
    await act(async () => toggle.click());
    assert.ok(details.open);
    assert.ok(details.textContent.includes(fullSummary));
});

test('regression titles identify the affected cases and disclose their individual judge reasons', async t => {
    const regression = { id: 'protected-1', title: 'Routine staged rollout', reason: 'The proposal omitted the verification step.' };
    const ui = await renderCard(t, () => Response.json({
        ...eligible, state: 'regressed', regressions: [regression.id, 'older-case-2'], regressionDetails: [regression],
    }));
    const toggle = [...ui.container.querySelectorAll('details > summary')].find(el => el.textContent === regression.title);
    assert.ok(toggle, 'the operator can open the human-readable case title');
    const details = toggle.parentElement;
    assert.ok(!details.open);
    assert.ok(ui.container.textContent.includes('older-case-2'), 'missing optional detail falls back to its case id');
    await act(async () => toggle.click());
    assert.ok(details.open);
    assert.ok(details.textContent.includes(regression.reason));
    assert.ok(!ui.button('Apply amendment'));
});
