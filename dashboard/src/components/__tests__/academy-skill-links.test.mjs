// The Academy links every skill by its slug (the manifest's file name) and
// titles it by its display name. Harvested skills have display names with
// spaces, which the skill page route refuses, so a link by name opened nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Suspense, act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import AcademyPage from '../../app/academy/page.tsx';
import SkillWikiPage from '../../app/academy/skill/[name]/page.tsx';

const row = (name, slug, category) => ({
    id: name, name, slug, category, summary: `${name} summary`, tags: [], provenance: null,
    evidenceProvenance: null, evidenceCount: 0, hasKnowledge: false, confidence: null, source: null,
    created: null, updated: null, state: null, pinned: false, recallCount: null, successCount: null,
    failureCount: null, lastUsedAt: null, hasTelemetry: false,
});

const foldContext = {
    name: 'Fold Context',
    slug: 'fold-context',
    category: 'development',
    relPath: 'skills/development/fold-context.md',
    frontmatter: {},
    manifest: 'Pairs with [[route-by-cost]] after [[plan-day]]. Background: [[note_context_budget]].',
    evidence: [],
    knowledge: null,
    telemetry: null,
    related: { inbound: ['Route By Cost'], outbound: ['Route By Cost', 'plan-day'] },
    knownSkills: ['Fold Context', 'Route By Cost', 'plan-day'],
    skillSlugs: {
        'Fold Context': 'fold-context', 'fold-context': 'fold-context',
        'Route By Cost': 'route-by-cost', 'route-by-cost': 'route-by-cost',
        'plan-day': 'plan-day',
    },
};

async function mount(t, responses, element) {
    const requested = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
        requested.push(url);
        assert.ok(url in responses, `unexpected request ${url}`);
        return Response.json(responses[url]);
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    t.after(() => act(() => root.unmount()));
    await act(async () => root.render(createElement(Suspense, { fallback: null }, element)));
    const links = (text) => [...container.querySelectorAll('a')].filter((a) => a.textContent.trim() === text);
    const hrefs = (text) => links(text).map((a) => a.getAttribute('href'));
    return { container, hrefs, requested };
}

test('every Academy row links by slug and is titled by its display name', async (t) => {
    const ui = await mount(t, {
        '/api/skill-wiki/skills': {
            total: 2,
            byCategory: { development: 1, operations: 1 },
            skills: [row('Fold Context', 'fold-context', 'development'), row('plan-day', 'plan-day', 'operations')],
        },
    }, createElement(AcademyPage));

    assert.deepEqual(ui.hrefs('Fold Context'), ['/academy/skill/fold-context']);
    // A skill named for its file keeps the address it always had.
    assert.deepEqual(ui.hrefs('plan-day'), ['/academy/skill/plan-day']);

    const expand = ui.container.querySelector('button[aria-label="Expand Fold Context"]');
    await act(async () => expand.click());
    assert.deepEqual(ui.hrefs('Open wiki page →'), ['/academy/skill/fold-context']);
});

test('a display-named skill page opens by slug and links its neighbours by slug', async (t) => {
    const ui = await mount(
        t,
        { '/api/skill-wiki/skills/fold-context': foldContext },
        createElement(SkillWikiPage, { params: Promise.resolve({ name: 'fold-context' }) }),
    );

    assert.deepEqual(ui.requested, ['/api/skill-wiki/skills/fold-context']);
    assert.equal(ui.container.querySelector('h1').textContent, 'Fold Context');
    assert.equal(ui.container.querySelector('[aria-current="page"]').textContent, 'Fold Context');

    // Related chips show the display name and go to the slug: once under
    // "References", once under "Referenced by".
    assert.deepEqual(ui.hrefs('Route By Cost'), ['/academy/skill/route-by-cost', '/academy/skill/route-by-cost']);
    // The chip and the [[plan-day]] mention in the procedure.
    assert.deepEqual(ui.hrefs('plan-day'), ['/academy/skill/plan-day', '/academy/skill/plan-day']);
    // A [[wiki-link]] written with the file name, as the vault writes them.
    assert.deepEqual(ui.hrefs('route-by-cost'), ['/academy/skill/route-by-cost']);
    // A vault note has no page here, so it is not a link.
    assert.deepEqual(ui.hrefs('note_context_budget'), []);
    assert.match(ui.container.textContent, /note_context_budget/);
    // Knowledge pages are filed by slug.
    assert.match(ui.container.textContent, /skills\/_knowledge\/fold-context\.md/);
});
