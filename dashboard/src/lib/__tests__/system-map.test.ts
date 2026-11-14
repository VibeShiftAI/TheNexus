/**
 * The System Map page's model (lib/system-map.ts): the one request it makes,
 * and the pure shaping behind the six views.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SystemMapError, buildDiagram, buildIndex, buildTimeline, cronHour, cronState, driftChecks, fetchSystemMap, filterRoutes,
  formatGeneratedAt, generatedAgo, isSystemMapTab, matchesNode, nodeConnections, parseSystemMap, processOf, purposeOrigin,
  stalestDocs, strongestLinks, systemMatrix, systemOf, systemSections, warningCount, EXTERNAL_APIS_ID, RANKED_TABLE_OPENS_WITH,
  SYSTEM_MAP_TABS,
} from '../system-map.ts';
// @ts-expect-error plain .mjs fixture shared with the component test
import { fixtureMap } from './system-map-fixture.mjs';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noSession = async () => false;

test('fetchSystemMap makes exactly one GET to /api/system-map and returns the map as served', async () => {
  const calls: { url: string; method: string }[] = [];
  const map = await fetchSystemMap(async (url, init = {}) => { calls.push({ url: String(url), method: init.method ?? 'GET' }); return json(fixtureMap()); }, noSession);
  assert.deepEqual(calls, [{ url: '/api/system-map', method: 'GET' }]);
  assert.equal(map.generatedAt, '2026-11-13T18:21:16.068Z');
  assert.equal(map.factsHash, '9d77d6536e79b27a');
  assert.equal(map.nodes.length, fixtureMap().nodes.length);
});

test('a refused read checks the session once and reads once more; a served read asks nothing about the session', async () => {
  let sessionChecks = 0;
  const session = (ok: boolean) => async () => { sessionChecks++; return ok; };
  let reads = 0;
  await fetchSystemMap(async () => { reads++; return json(fixtureMap()); }, session(true));
  assert.deepEqual([reads, sessionChecks], [1, 0]);

  reads = 0;
  const map = await fetchSystemMap(async () => (++reads === 1 ? json({ code: 'sign_in_required' }, 401) : json(fixtureMap())), session(true));
  assert.deepEqual([reads, sessionChecks, map.factsHash], [2, 1, '9d77d6536e79b27a']);

  reads = 0; sessionChecks = 0;
  await assert.rejects(fetchSystemMap(async () => { reads++; return json({ code: 'sign_in_required' }, 401); }, session(true)), SystemMapError);
  assert.deepEqual([reads, sessionChecks], [2, 1], 'never more than one retry');
});

test('rows the views cannot place are dropped and optional lists filled in', () => {
  const map = parseSystemMap({
    generatedAt: 'x', factsHash: 'y',
    nodes: [{ id: 'a' }, { name: 'no id' }, null],
    edges: [{ from: 'a', to: 'b' }, { from: 'a' }],
    checks: [{ severity: 'warn', id: 'c', title: 'C' }],
  });
  assert.deepEqual(map.nodes, [{ id: 'a', name: 'a', attrs: {} }]);
  assert.deepEqual(map.edges, [{ from: 'a', to: 'b', kind: 'uses', count: 1, evidence: [] }]);
  assert.deepEqual(map.checks[0].items, []);
  assert.deepEqual(map.catalogs, {});
});

test('fetchSystemMap names sign-in, missing and unavailable apart, and never returns a non-map', async () => {
  const failure = async (request: Parameters<typeof fetchSystemMap>[0]) => {
    try { await fetchSystemMap(request, noSession); } catch (err) { assert.ok(err instanceof SystemMapError); return err.kind; }
    assert.fail('expected a failure');
  };
  assert.equal(await failure(async () => json({ code: 'sign_in_required' }, 401)), 'sign-in');
  assert.equal(await failure(async () => json({ code: 'operator_required' }, 403)), 'sign-in');
  assert.equal(await failure(async () => { throw new TypeError('redirected to the Access sign-in'); }), 'sign-in');
  assert.equal(await failure(async () => json({ code: 'system_map_missing' }, 404)), 'missing');
  assert.equal(await failure(async () => new Response('Cannot GET /api/system-map', { status: 404 })), 'unavailable');
  assert.equal(await failure(async () => json({ error: 'not valid', code: 'system_map_invalid' }, 500)), 'unavailable');
  assert.equal(await failure(async () => json({ hello: 'world' })), 'unavailable');
  assert.equal(await failure(async () => new Response('<html>', { status: 200 })), 'unavailable');
  assert.throws(() => parseSystemMap({ generatedAt: 'x', factsHash: 'y', nodes: [] }), SystemMapError);
});

test('systems, processes and connections in both directions', () => {
  const index = buildIndex(fixtureMap());
  assert.equal(systemOf('praxis/reports'), 'praxis');
  assert.equal(systemOf('sat/Nexus-Mobile-Android'), 'siblings');
  assert.equal(systemOf('ext/openrouter'), 'external');
  assert.equal(systemOf('vault/store'), 'shared');
  assert.equal(processOf(index, 'praxis/reports'), 'praxis/daemon');
  assert.equal(processOf(index, 'nexus/api'), 'nexus/api');

  const reports = nodeConnections(index, index.byId.get('praxis/reports')!);
  assert.deepEqual(reports.outs.map((e) => e.to).sort(), ['ext/openrouter', 'nexus/routes/tasks', 'praxis/quiet']);
  assert.deepEqual(reports.ins.map((e) => e.from), ['nexus/routes/tasks']);
  assert.ok(reports.outs.every((e) => e.evidence.length > 0), 'every connection carries its source locations');

  // A process also lists what its components reach outside it, but not their internal imports.
  const daemon = nodeConnections(index, index.byId.get('praxis/daemon')!);
  assert.deepEqual(daemon.outs.map((e) => `${e.from}>${e.to}`).sort(), ['praxis/daemon>nexus/api', 'praxis/reports>ext/openrouter', 'praxis/reports>nexus/routes/tasks']);
  assert.deepEqual(daemon.ins.map((e) => `${e.from}>${e.to}`), ['nexus/routes/tasks>praxis/reports']);
});

test('purpose origin names the notes file, the code comment, or how to add one', () => {
  const index = buildIndex(fixtureMap());
  assert.equal(purposeOrigin(index.byId.get('praxis/reports')!), 'Purpose from Praxis/system-map-notes.json');
  assert.equal(purposeOrigin(index.byId.get('nexus/routes/tasks')!), 'Purpose lifted from a code comment in TheNexus/server/routes/tasks.js');
  assert.match(purposeOrigin(index.byId.get('praxis/quiet')!), /system-map-notes\.json under the id praxis\/quiet/);
});

test('the service diagram places every process and rolls call sites up between them', () => {
  const diagram = buildDiagram(buildIndex(fixtureMap()));
  const ids = diagram.nodes.map((n) => n.id);
  for (const id of ['praxis/daemon', 'nexus/api', 'nexus/dashboard', 'cortex/gateway', 'sat/Nexus-Mobile-Android', 'ext/bin:claude', EXTERNAL_APIS_ID]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('ext/openrouter'), 'unnamed outside APIs share one box');
  assert.equal(diagram.nodes.find((n) => n.id === 'cortex/gateway')?.sub, ':8100 · not running');
  assert.equal(diagram.nodes.find((n) => n.id === EXTERNAL_APIS_ID)?.selectable, false);
  const edge = (from: string, to: string) => diagram.edges.find((e) => e.from === from && e.to === to);
  assert.equal(edge('praxis/daemon', 'nexus/api')?.count, 8, 'http 7 from a component plus the supervise link');
  assert.deepEqual(edge('praxis/daemon', 'nexus/api')?.kinds, [['http', 7], ['supervises', 1]]);
  assert.equal(edge('praxis/daemon', EXTERNAL_APIS_ID)?.count, 3);
  assert.equal(edge('praxis/daemon', 'praxis/daemon'), undefined, 'imports inside a process draw no line');
  // Linked both ways: two lines that do not lie on top of each other.
  assert.equal(edge('nexus/api', 'praxis/daemon')?.count, 2);
  assert.notEqual(edge('nexus/api', 'praxis/daemon')?.d.split(' ')[0].split(',')[1], edge('praxis/daemon', 'nexus/api')?.d.split(' ').at(-1)?.split(',')[1]);
  assert.equal(diagram.undrawn, 0);
  for (const n of diagram.nodes) assert.ok(n.x >= 0 && n.x + diagram.boxWidth <= diagram.width && n.y + diagram.boxHeight <= diagram.height, `${n.id} is inside the drawing`);
});

test('components: sections, filters and the text filter', () => {
  const index = buildIndex(fixtureMap());
  const sections = systemSections(index);
  assert.deepEqual(sections.map((s) => s.system.key), ['praxis', 'nexus', 'cortex', 'shared', 'siblings', 'external']);
  const praxis = sections[0];
  assert.deepEqual(praxis.blocks.map((b) => b.process?.id), ['praxis/daemon']);
  assert.deepEqual(praxis.blocks[0].components.map((n) => n.id), ['praxis/reports', 'praxis/quiet'], 'largest first');
  assert.equal(praxis.maxLines, 1200);
  assert.deepEqual(sections[4].flat?.map((n) => n.id), ['sat/Nexus-Mobile-Android']);
  const quiet = index.byId.get('praxis/quiet')!, tasks = index.byId.get('nexus/routes/tasks')!, reports = index.byId.get('praxis/reports')!;
  assert.equal(matchesNode(quiet, '', 'dormant'), true);
  assert.equal(matchesNode(reports, '', 'dormant'), false);
  assert.equal(matchesNode(quiet, '', 'undescribed'), true);
  assert.equal(matchesNode(tasks, '', 'routes'), true);
  assert.equal(matchesNode(reports, '', 'jobs'), true);
  assert.equal(matchesNode(tasks, 'lifecycle', 'all'), true);
  assert.equal(matchesNode(tasks, 'nothing-like-this', 'all'), false);
});

test('connections between systems: the matrix and the strongest links', () => {
  const map = fixtureMap();
  const matrix = systemMatrix(map);
  assert.equal(matrix.get('praxis|nexus')?.count, 8);
  assert.equal(matrix.get('nexus|praxis')?.count, 2);
  assert.equal(matrix.get('siblings|nexus')?.count, 4);
  assert.equal(matrix.get('praxis|praxis'), undefined);
  const index = buildIndex(map);
  assert.deepEqual(strongestLinks(index, '').map((e) => e.count), [7, 4, 3, 2, 1]);
  assert.deepEqual(strongestLinks(index, 'openrouter').map((e) => e.to), ['ext/openrouter']);

  // The model cuts nothing: a table may open with fewer rows, but every link is handed to it.
  const many = buildIndex(fixtureMap({
    edges: Array.from({ length: 400 }, (_, i) => ({ from: 'praxis/reports', to: 'nexus/routes/tasks', kind: 'http', count: i + 1, evidence: [`Praxis/src/reports/x.ts:${i + 1}`] })),
  }));
  const all = strongestLinks(many, '');
  assert.ok(all.length > RANKED_TABLE_OPENS_WITH.links);
  assert.deepEqual([all.length, all[0].count, all[399].count], [400, 400, 1]);
});

test('schedule: once-a-day jobs get a place on the timeline, repeating ones do not', () => {
  assert.equal(cronHour('30 18 * * 0'), 18.5);
  assert.equal(cronHour('*/10 * * * *'), null);
  assert.equal(cronHour(undefined), null);
  const crons = fixtureMap().catalogs.crons;
  const timeline = buildTimeline(crons);
  assert.deepEqual(timeline.categories, ['daily', 'system']);
  assert.deepEqual(timeline.dots.map((d) => d.cron.key).sort(), ['attention-economics', 'morning-routine']);
  for (const d of timeline.dots) assert.ok(d.x >= timeline.left && d.x <= timeline.width - timeline.right);
  assert.deepEqual(cronState(crons[2]), { tone: 'warn', label: 'in code, not registered' });
  assert.deepEqual(cronState(crons[0]), { tone: 'ok', label: 'active' });
});

test('routes, drift and stale docs', () => {
  const map = fixtureMap();
  const index = buildIndex(map);
  const routes = map.catalogs.routes;
  assert.equal(filterRoutes(index, routes, { service: 'all', orphansOnly: false, query: '' }).length, 3);
  assert.deepEqual(filterRoutes(index, routes, { service: 'nexus', orphansOnly: true, query: '' }).map((r) => r.path), ['/api/tasks/:taskId']);
  assert.deepEqual(filterRoutes(index, routes, { service: 'all', orphansOnly: false, query: 'reports' }).map((r) => r.path), ['/api/reports']);
  assert.equal(warningCount(map.checks), 1);
  assert.deepEqual(driftChecks(map.checks, '').map((c) => c.severity), ['warn', 'info', 'ok'], 'warnings first');
  assert.deepEqual(driftChecks(map.checks, 'trading').map((c) => c.id), ['jobs-paused']);
  assert.deepEqual(stalestDocs(map.catalogs.docs).map((d) => d.file), ['Praxis/docs/client-workflow.md'], 'only living docs that are actually behind');

  const behind = Array.from({ length: 90 }, (_, i) => ({ file: `Praxis/docs/d${i}.md`, kind: 'living', refs: 5, missingRefs: i + 1, refsChangedSince: 0 }));
  const stale = stalestDocs(behind);
  assert.ok(stale.length > RANKED_TABLE_OPENS_WITH.docs);
  assert.deepEqual([stale.length, stale[0].file, stale[89].file], [90, 'Praxis/docs/d89.md', 'Praxis/docs/d0.md'], 'every doc that is behind, stalest first');
});

test('stamp, age and tab names', () => {
  assert.equal(formatGeneratedAt('2026-11-13T18:21:16.068Z'), '2026-11-13 18:21 UTC');
  const at = Date.parse('2026-11-13T18:21:16.068Z');
  assert.equal(generatedAgo('2026-11-13T18:21:16.068Z', at + 20_000), 'just now');
  assert.equal(generatedAgo('2026-11-13T18:21:16.068Z', at + 5 * 60_000), '5 minutes ago');
  assert.equal(generatedAgo('2026-11-13T18:21:16.068Z', at + 3 * 3_600_000), '3 hours ago');
  assert.equal(generatedAgo('2026-11-13T18:21:16.068Z', at + 4 * 86_400_000), '4 days ago');
  assert.equal(generatedAgo('not a date', at), '');
  assert.deepEqual(SYSTEM_MAP_TABS.map(([key]) => key), ['map', 'connections', 'schedule', 'routes', 'drift', 'boundary']);
  assert.equal(isSystemMapTab('drift'), true);
  assert.equal(isSystemMapTab('settings'), false);
});
