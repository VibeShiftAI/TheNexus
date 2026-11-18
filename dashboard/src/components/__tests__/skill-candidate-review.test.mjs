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
    assert.ok(!ui.button('Add to library'));
    await act(async () => resolve(Response.json({ kind: 'new' })));
    await ui.click('Add to library');
    assert.deepEqual(ui.decisions, [{ decision: 'approve' }]);
    assert.match(ui.container.textContent, /1\/1 decided/);
    await ui.click('Done');
    assert.deepEqual(ui.done, [['morning', { choice: 'done' }]]);
});

test('failed review lookup displays upstream detail and never falls back to install', async t => {
    const ui = await renderCard(t, () => Response.json({ error: 'Review storage unavailable.' }, { status: 503 }));
    assert.match(ui.container.textContent, /Review storage unavailable/);
    assert.ok(!ui.button('Add to library'));
    assert.ok(!ui.button('Apply to live skill'));
});

test('manual-change candidates retain Archive without offering install or apply', async t => {
    const ui = await renderCard(t, () => Response.json({ kind: 'skill-split' }));
    assert.ok(!ui.button('Add to library'));
    assert.ok(!ui.button('Apply to live skill'));
    assert.match(ui.container.textContent, /Proposal: split a skill/);
    assert.match(ui.container.textContent, /cannot carry it out/);
    await ui.click('Reject');
    assert.deepEqual(ui.decisions, [{ decision: 'archive' }]);
    assert.match(ui.container.textContent, /Rejected\. It is off the review list/);
    assert.ok(!ui.button('Reject'), 'a decided row offers no further action');
    assert.match(ui.container.textContent, /1\/1 decided/);
});

const blocked = [
    ['awaiting', /Needs a new test run.*does not accept that result/, {}],
    ['awaiting', /Test still running.*1 of 2 test tasks compared so far/, { scored: 1 }],
    ['awaiting', /Not tested yet.*has not compared it against the live skill/, { scored: 0, total: 0 }],
    ['regressed', /Blocked: it made 1 protected task worse.*cannot be applied in this state/, {}],
    ['no-improvement', /Blocked: no clear improvement.*cannot be applied in this state/, {}],
    ['stale', /Out of date.*tested again before it can be applied/, {}],
];
for (const [state, label, extra] of blocked) {
    test('a change that is ' + state + ' says why it cannot be applied (' + label.source.slice(0, 24) + ')', async t => {
        const ui = await renderCard(t, () => Response.json({ ...eligible, ...extra, state, reviewId: null, regressions: state === 'regressed' ? ['control-7'] : [] }));
        assert.ok(!ui.button('Add to library'));
        assert.ok(!ui.button('Apply to live skill'));
        assert.match(ui.container.textContent, label);
        assert.match(ui.container.textContent, /operations\/rollout/);
        if (state === 'regressed') assert.match(ui.container.textContent, /control-7/);
    });
}

test('reviewing the newly opened diff binds Apply to its exact review id', async t => {
    let current = eligible;
    const ui = await renderCard(t, () => Response.json(current));
    assert.ok(!ui.button('Add to library'));
    assert.match(ui.container.textContent, /Ready to apply/);
    assert.match(ui.container.textContent, /press See what changes, read the change, tick the box, then press Apply to live skill/);
    assert.match(ui.container.textContent, /Test result: 2 of 2 test tasks compared/);
    assert.match(ui.container.textContent, /meant to improve: better on 1, worse on 0/);
    assert.match(ui.container.textContent, /must not make worse: none got worse/);
    assert.match(ui.container.textContent, /Narrow the rollout/);
    assert.ok(!ui.button('Apply to live skill'));
    current = { ...eligible, diff: '-previous\n+current', reviewId: 'review-two' };
    await ui.click('See what changes');
    assert.equal(ui.container.querySelector('pre')?.textContent, current.diff);
    assert.ok(!ui.button('Apply to live skill'));
    await ui.confirm();
    await ui.click('Apply to live skill');
    assert.deepEqual(ui.decisions, [{ decision: 'apply-amendment', reviewId: 'review-two' }]);
    assert.match(ui.container.textContent, /Applied\. The live skill now has this text/);
    assert.ok(!ui.button('Reject change'), 'an applied change offers no further action');
    assert.match(ui.container.textContent, /1\/1 decided/);
});

test('closing and reopening discards consent and fetches changed evidence', async t => {
    let current = eligible;
    const ui = await renderCard(t, () => Response.json(current));
    await ui.click('See what changes');
    await ui.confirm();
    await ui.click('Hide changes');
    assert.ok(!ui.button('Apply to live skill'));
    current = { ...eligible, state: 'regressed', reviewId: null, regressions: ['control-2'] };
    await ui.click('See what changes');
    assert.match(ui.container.textContent, /control-2/);
    assert.ok(!ui.button('Apply to live skill'));
});

test('a stale apply response invalidates consent and reports the server conflict', async t => {
    const ui = await renderCard(t, () => Response.json(eligible), { post: () => Response.json({ error: 'Target changed on disk.' }, { status: 409 }) });
    await ui.click('See what changes');
    await ui.confirm();
    await ui.click('Apply to live skill');
    assert.ok(!ui.button('Apply to live skill'));
    assert.match(ui.container.textContent, /Target changed on disk/);
    assert.match(ui.container.textContent, /Out of date.*tested again/);
    assert.match(ui.container.textContent, /0\/1 decided/);
});

test('a nominally eligible but incomplete pair cannot be applied', async t => {
    const ui = await renderCard(t, () => Response.json({ ...eligible, scored: 1 }));
    await ui.click('See what changes');
    assert.equal(ui.container.querySelector('input[type="checkbox"]'), null);
    assert.ok(!ui.button('Apply to live skill'));
});

test('a late earlier lookup cannot turn the current amendment into an installable skill', async t => {
    let resolve;
    const slow = new Promise(r => { resolve = r; });
    let count = 0;
    const ui = await renderCard(t, () => ++count === 1 ? slow : Response.json({ ...eligible, state: 'awaiting' }));
    await ui.click('Check again');
    await act(async () => resolve(Response.json({ kind: 'new' })));
    assert.match(ui.container.textContent, /Needs a new test run/);
    assert.ok(!ui.button('Add to library'));
});

test('a card tagged as a modification cannot install even if the lookup returns new', async t => {
    const ui = await renderCard(t, () => Response.json({ kind: 'new' }), { item: { ...candidate, kind: 'skill-retirement' } });
    assert.ok(!ui.button('Add to library'));
    assert.match(ui.container.textContent, /no longer what this card describes/);
});

test('a missing success acknowledgement leaves the amendment undecided', async t => {
    const ui = await renderCard(t, () => Response.json(eligible), { post: () => Response.json({ ok: false, error: 'Write not confirmed.' }) });
    await ui.click('See what changes');
    await ui.confirm();
    await ui.click('Apply to live skill');
    assert.match(ui.container.textContent, /0\/1 decided/);
    assert.doesNotMatch(ui.container.textContent, /The live skill now has this text/);
    assert.match(ui.container.textContent, /Write not confirmed/);
    assert.ok(!ui.button('Apply to live skill'));
});

test('a stale lookup response advises re-evaluation and retains the upstream detail', async t => {
    const ui = await renderCard(t, () => Response.json({ error: 'Target was replaced.', state: 'stale' }, { status: 409 }));
    assert.match(ui.container.textContent, /Target was replaced/);
    assert.match(ui.container.textContent, /out of date and has to be tested again/);
    assert.ok(!ui.button('Add to library'));
});

test('a newly opened card cannot inherit a terminal decision for a reused candidate id', async t => {
    const ui = await renderCard(t, () => Response.json({ kind: 'new' }));
    await ui.click('Add to library');
    await ui.show({ ...ui.request, id: 'next-day' });
    assert.match(ui.container.textContent, /0\/1 decided/);
    assert.equal(ui.button('Add to library')?.disabled, false);
});

test('changing a card hint drops a prior install decision while the replacement lookup is pending', async t => {
    let current = Promise.resolve(Response.json({ kind: 'new' }));
    const ui = await renderCard(t, () => current);
    assert.ok(ui.button('Add to library'));
    current = new Promise(() => {});
    await ui.show({ ...ui.request, metadata: { ...ui.request.metadata, skillCandidates: [{ ...candidate, kind: 'skill-split' }] } });
    assert.ok(!ui.button('Add to library'));
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
    assert.match(heading, /Change to an existing skill/);
    assert.match(row.textContent, /Ready to apply/);
    assert.ok(!row.textContent.includes(wrapper));
    assert.match(row.textContent, /What it changes and why: First narrow the pilot\./, 'the first paragraph says what the change is');
    const toggle = [...row.querySelectorAll('details > summary')].find(el => el.textContent === 'Read the full explanation');
    assert.ok(toggle);
    const details = toggle.parentElement;
    assert.ok(!details.open);
    const collapsedRow = row.cloneNode(true);
    collapsedRow.querySelectorAll('details').forEach(el => el.remove());
    assert.ok(!collapsedRow.textContent.includes('Keep this detailed explanation'));
    assert.match(collapsedRow.textContent, /2 of 2 test tasks compared/);
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
    assert.match(details.textContent, /The one it preferred here used the live skill text/, 'the judge\'s A and B are decoded for the reader');
    assert.ok(!ui.button('Apply to live skill'));
});

const harvested = {
    kind: 'new', name: 'Implement Context Bloat Mitigation Harness', category: 'operations',
    summary: 'Offloads large tool outputs to disk.', document: '# Harness\n\n## Procedure\n1. Cap tool output size.',
    origin: 'auto-extracted', evalStatus: 'passed', evalVerdict: 'beat incumbent 6/9, tied 1',
    sourceTitle: 'Harness reading', sourceUrl: 'https://example.org/harness', relatedSkills: ['tiered-memory-protocol'],
};

test('a new skill says what it does, how its trial went, where it came from, and can be read in full', async t => {
    const ui = await renderCard(t, () => Response.json(harvested), { item: { ...candidate, id: 'harness', name: 'harness', kind: 'new', summary: '' } });
    const row = ui.container.querySelector('li');
    assert.match(row.firstElementChild.textContent, /New skill.*Implement Context Bloat Mitigation Harness/);
    assert.match(row.textContent, /What it does: Offloads large tool outputs to disk\./);
    assert.match(row.textContent, /Passed its trial: did better than the closest existing skill on 6 of 9 test tasks, tied on 1, did worse on 2\./);
    assert.equal(row.querySelector('a[href="https://example.org/harness"]')?.textContent, 'Harness reading');
    assert.equal(row.querySelector('a[href="/academy/skill/tiered-memory-protocol"]')?.textContent, 'Tiered memory protocol');
    const full = [...row.querySelectorAll('details > summary')].find(el => el.textContent === 'Read the full skill');
    assert.ok(full, 'the reviewer can open the procedure itself');
    assert.match(full.parentElement.textContent, /Cap tool output size/);
    assert.ok(!full.parentElement.open);
    await ui.click('Add to library');
    assert.deepEqual(ui.decisions, [{ decision: 'approve' }]);
    assert.match(row.textContent, /Added to the skill library/);
    assert.ok(!ui.button('Add to library') && !ui.button('Reject'), 'a decided row offers no further action');
});

test('an untested skill drafted from QA reviews says so instead of showing a trial result', async t => {
    const ui = await renderCard(t, () => Response.json({
        kind: 'new', name: 're-point-task-workspace-before-editing', summary: 'Re-point the task before editing.',
        evalStatus: 'unavailable', qaLesson: { label: 'workspace-mismatch', tasks: 3, rounds: 3, windowDays: 14 },
    }), { item: { ...candidate, kind: 'new', evalStatus: 'unavailable', evalVerdict: 'eval unavailable — no eval was run for this candidate' } });
    const text = ui.container.querySelector('li').textContent;
    assert.match(text, /Re point task workspace before editing/, 'a file slug is shown as a title');
    assert.match(text, /Not tested \(no eval was run for this candidate\)\. Judge it on its text\./);
    assert.match(text, /Drafted from: QA reviews\. 3 tasks were sent back for “workspace mismatch” in the last 14 days\./);
});

test('a Praxis that answers with the kind alone still shows the description the card was issued with', async t => {
    const ui = await renderCard(t, () => Response.json({ kind: 'new' }), {
        item: { ...candidate, kind: 'new', summary: 'Card summary.', evalStatus: 'passed', evalVerdict: 'beat no-skill baseline 3/4, tied 1', sourceUrl: 'javascript:alert(1)', sourceTitle: 'A source' },
    });
    const row = ui.container.querySelector('li');
    assert.match(row.textContent, /What it does: Card summary\./);
    assert.match(row.textContent, /did better than working with no skill on 3 of 4 test tasks, tied on 1\./);
    assert.match(row.textContent, /Drafted from: A source/);
    assert.equal(row.querySelector('a'), null, 'only a web address becomes a link');
});

test('a change whose test used an excluded model says it needs a new test and why, and cannot be applied', async t => {
    const policyIssue = 'Gemma is excluded from evaluations by operator policy (2026-11-03).';
    const ui = await renderCard(t, () => Response.json({
        ...eligible, state: 'awaiting', targetName: 'Rollout Checklist', policyIssue, evaluatedState: 'regressed', regressions: ['control-7'],
    }), { item: { ...candidate, kind: 'skill-amendment' } });
    const row = ui.container.querySelector('li');
    assert.match(row.firstElementChild.textContent, /Change to an existing skill.*Rollout Checklist/);
    assert.equal(row.querySelector('a[href="/academy/skill/operations%2Frollout"]')?.textContent, 'Open the live skill');
    assert.match(row.textContent, /Needs a new test run/);
    assert.match(row.textContent, /used a model that is no longer allowed for testing, so that result does not count \(in that run it made protected tasks worse\)/);
    assert.match(row.textContent, /cannot be applied until it is tested again with an approved model/);
    assert.ok(row.textContent.includes('Praxis says: ' + policyIssue));
    assert.match(row.textContent, /Earlier test \(does not count\): 2 of 2 test tasks compared/);
    await ui.click('See what changes');
    assert.equal(ui.container.querySelector('input[type="checkbox"]'), null);
    assert.ok(!ui.button('Apply to live skill'));
    assert.ok(ui.button('Reject change'));
});

test('the card separates new skills, changes to live skills and other proposals, and explains each group\'s buttons', async t => {
    const items = [
        { ...candidate, id: 'a-new', kind: 'new' },
        { ...candidate, id: 'a-change', kind: 'skill-amendment', targetSkill: 'operations/rollout' },
        { ...candidate, id: 'a-split', kind: 'skill-split', targetSkill: 'big-skill' },
    ];
    const replies = { 'a-new': { kind: 'new' }, 'a-change': eligible, 'a-split': { kind: 'skill-split', targetSkill: 'big-skill', summary: 'Too broad.' } };
    t.mock.method(globalThis, 'fetch', async url => Response.json(replies[/skill-candidates\/([^/]+)\/review$/.exec(url)[1]]));
    const container = document.createElement('div');
    const root = createRoot(container);
    t.after(() => act(() => root.unmount()));
    const request = { id: 'morning', metadata: { kind: 'skill-candidates', date: '2026-11-18', skillCandidates: items } };
    await act(async () => root.render(createElement(SkillCandidatesHitlCard, { request, resolving: false, onResolve: async () => {} })));
    assert.match(container.textContent, /1 new skill · 1 change to an existing skill · 1 other proposal\./);
    const sections = [...container.querySelectorAll('section')];
    assert.deepEqual(sections.map(s => s.querySelector('h3').textContent), ['New skills (1)', 'Changes to existing skills (1)', 'Other proposals (1)']);
    const [fresh, changes, others] = sections;
    assert.match(fresh.textContent, /Add to library puts one in the live skill library/);
    assert.match(changes.textContent, /Apply appears only on a change that passed/);
    assert.match(changes.textContent, /See what changes shows the exact edit and applies nothing/);
    assert.match(others.textContent, /Big skill/);
    assert.match(others.textContent, /Why: Too broad\./);
    assert.deepEqual([...fresh.querySelectorAll('button')].map(b => b.textContent.trim()), ['Add to library', 'Reject']);
    assert.deepEqual([...changes.querySelectorAll('button')].map(b => b.textContent.trim()), ['See what changes', 'Reject change', 'Check again']);
    assert.deepEqual([...others.querySelectorAll('button')].map(b => b.textContent.trim()), ['Reject']);
    assert.match(container.textContent, /Done only clears this card/);
});
