// Mutation check for attribution criterion 3 (and the dashboard side of 2).
// Usage: node mutate.mjs <worktree> <out.json>
// Each mutation removes one source marker (or turns "unavailable" into 0),
// runs the attribution tests, and restores the file byte for byte.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [root, out] = process.argv.slice(2);
const SERVER_CMD = ['npx', ['jest', 'server/__tests__/attribution-source-markers.test.js'], root];
const DASH_CMD = ['node', ['--import', './test/register.mjs', '--test',
  'src/components/__tests__/attribution-source-labels.test.mjs',
  'src/components/__tests__/usage-missing-attribution.test.mjs'], path.join(root, 'dashboard')];
const S = 'server', D = 'dashboard';
const M = [
  [S, 'Now strip sum marker', 'server/routes/dispatches.js', 'tokensSource: aggregateTokenSource({', '_dropped: aggregateTokenSource({'],
  [S, 'task dispatch row marker', 'server/routes/dispatches.js', 'row.tokens_source = tokenSource(', 'row._dropped = tokenSource('],
  [S, 'activity feed commit marker', 'server/routes/projects.js', 'tokens, tokensEstimated, tokensSource, dispatchId', 'tokens, tokensEstimated, dispatchId'],
  [S, 'activity feed: unavailable dressed as 0', 'server/routes/projects.js', "return { model: null, tokens: null, tokensEstimated: false, tokensSource: 'unavailable'", "return { model: null, tokens: 0, tokensEstimated: false, tokensSource: 'unavailable'"],
  [S, 'dispatch-insight run tokens marker', 'server/routes/dispatch-insight.js', 'tokensSource: tokenSource(d.tokens, d.tokens_estimated),', ''],
  [S, 'dispatch-insight run cost marker', 'server/routes/dispatch-insight.js', 'costSource: costSource(estimateRunCostUsd(d.tokens, d.model)),', ''],
  [S, 'dispatch-insight cost object marker', 'server/routes/dispatch-insight.js', '{ usd, estimated: true, source: costSource(usd) }', '{ usd, estimated: true }'],
  [S, 'dispatch-insight run-trace input: missing tokens dressed as 0', 'server/routes/dispatch-insight.js', "tokens: typeof d.tokens === 'number' ? d.tokens : null,", "tokens: typeof d.tokens === 'number' ? d.tokens : 0,"],
  [S, 'dispatch-insight run row: missing tokens dressed as 0', 'server/routes/dispatch-insight.js', "never coerced to 0.\n                tokens: typeof d.tokens === 'number' ? d.tokens : null,", "never coerced to 0.\n                tokens: typeof d.tokens === 'number' ? d.tokens : 0,"],
  [S, 'run-cost roll-up marker', 'server/services/run-cost.js', 'source: costSource(pricedRuns > 0 ? subtotal : null),', ''],
  [S, 'run-trace tokensTotal marker', 'server/services/run-trace.js', 'tokensTotalSource: tokenSource(input.tokens, input.tokensEstimated),', ''],
  [S, 'routing economics token marker', 'server/services/routing-economics.js', 'source: aggregateTokenSource({ counted: tokenRuns', '_s: aggregateTokenSource({ counted: tokenRuns'],
  [S, 'routing economics cost marker', 'server/services/routing-economics.js', "source: !costRuns ? 'unavailable'", "_s: !costRuns ? 'unavailable'"],
  [S, 'routing economics: missing total dressed as 0', 'server/services/routing-economics.js', 'total: tokenRuns ? tokens : null,', 'total: tokenRuns ? tokens : 0,'],
  [S, 'pulse 7d aggregate marker', 'server/routes/project-pulse.js', 'tokens7dSource', 't7dDropped', true],
  [S, 'pulse 24h unknown counted as measured', 'server/routes/project-pulse.js', 'estimated: c.tokensEstimatedRuns24h, unknown: c.tokensUnflaggedRuns24h', 'estimated: c.tokensEstimatedRuns24h'],
  [S, 'pulse ops-log dispatch marker', 'server/routes/project-pulse.js', 'tokensSource: tokenSource(d.tokens, d.tokens_estimated),', '', true],
  [D, 'activity feed est tag', 'dashboard/src/components/activity-feed.tsx', '<span className="font-normal opacity-80">{USAGE_SOURCE_TAG[tokenSource]}</span>', '<span className="font-normal opacity-80">{""}</span>'],
  [D, 'activity feed unavailable as 0', 'dashboard/src/components/activity-feed.tsx', '<Coins size={9} className="shrink-0" />unavailable', '<Coins size={9} className="shrink-0" />0'],
  [D, 'Now strip est tag', 'dashboard/src/components/bridge/now-strip.tsx', '<span className="font-normal opacity-80">{USAGE_SOURCE_TAG[tokensSource]}</span>', '<span className="font-normal opacity-80">{""}</span>'],
  [D, 'Now strip unavailable as 0', 'dashboard/src/components/bridge/now-strip.tsx', '<span>unavailable</span>', '<span>0</span>'],
  [D, 'ops log est tag', 'dashboard/src/components/project-brief/activity-report.tsx', '{source !== "measured" && ` ${USAGE_SOURCE_TAG[source]}`}', '{source !== "measured" && ""}'],
  [D, 'ops log unavailable as 0', 'dashboard/src/components/project-brief/activity-report.tsx', '>tok unavailable<', '>0 tok<'],
  [D, 'mission brief 24h est tag', 'dashboard/src/components/project-brief/mission-brief.tsx', '` ${USAGE_SOURCE_TAG[source24h]}`', '``'],
  [D, 'mission brief 7d unavailable as 0', 'dashboard/src/components/project-brief/mission-brief.tsx', ': source7d === "unavailable" || crew.tokens7d == null ? "unavailable"', ': source7d === "unavailable" || crew.tokens7d == null ? "0"'],
  [D, 'routing economics est tag', 'dashboard/src/components/routing-economics-panel.tsx', '{group.tokens.total.toLocaleString("en-US")} {USAGE_SOURCE_TAG[tokenSource]}', '{group.tokens.total.toLocaleString("en-US")}'],
  [D, 'routing economics unavailable as 0', 'dashboard/src/components/routing-economics-panel.tsx', '<span className="text-slate-400">Unavailable</span>', '<span className="text-slate-400">0</span>'],
  [D, 'task detail est tag', 'dashboard/src/components/task-view/dispatch-console.tsx', '<span className="ml-1 text-cyan-400/70">{USAGE_SOURCE_TAG[tokenSource]}</span>', '<span className="ml-1 text-cyan-400/70">{""}</span>'],
  [D, 'task detail tokens unavailable as 0', 'dashboard/src/components/task-view/dispatch-console.tsx', 'tokens unavailable', '0 tokens', true],
];
function run([cmd, args, cwd]) {
  // Node's default spawnSync output limit applies. If a run outgrows it the
  // child is killed and r.error is set; that is reported as an error below,
  // never counted as a killed mutant.
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  if (r.error) return { status: null, summary: '', failed: [], loadFailure: false, error: `spawn failed: ${r.error.code || r.error.message}` };
  const text = (r.stdout || '') + (r.stderr || '');
  const summary = text.split('\n').filter(l => /^(Tests:|ℹ (pass|fail) )/.test(l)).join(' | ');
  const failed = text.split('\n').filter(l => /^\s*(✕|✖) /.test(l)).map(l => l.trim().replace(/ \(\d+(\.\d+)? ?ms\)$/, '')).filter(l => l !== '✖ failing tests:');
  const uniq = [...new Set(failed)];
  // A whole test FILE failing (not a named test) means the mutant did not
  // load (syntax error): that is not a kill, so it is reported as invalid.
  const loadFailure = uniq.some(l => /\.test\.(mjs|ts|js)$/.test(l));
  return { status: r.status, summary, failed: uniq, loadFailure };
}
const results = [];
results.push({ id: 'control-server', ...run(SERVER_CMD) });
results.push({ id: 'control-dashboard', ...run(DASH_CMD) });
for (const [side, name, rel, find, repl, all] of M) {
  const file = path.join(root, rel);
  const orig = fs.readFileSync(file, 'utf8');
  const count = orig.split(find).length - 1;
  if (count === 0) { results.push({ id: name, side, file: rel, error: 'find string not present' }); continue; }
  fs.writeFileSync(file, all ? orig.split(find).join(repl) : orig.replace(find, repl), 'utf8');
  try { results.push({ id: name, side, file: rel, occurrences: count, replacedAll: !!all, ...run(side === S ? SERVER_CMD : DASH_CMD) }); }
  finally { fs.writeFileSync(file, orig, 'utf8'); }
  if (fs.readFileSync(file, 'utf8') !== orig) throw new Error(`restore failed for ${rel}`);
}
fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n', 'utf8');
for (const r of results) console.log(`${r.status === 0 ? 'PASS' : r.error ? 'ERR ' : r.loadFailure ? 'LOAD' : 'FAIL'}  ${r.id}  ${r.error || r.summary}  ${r.failed ? r.failed.length + ' failing' : ''}`);
