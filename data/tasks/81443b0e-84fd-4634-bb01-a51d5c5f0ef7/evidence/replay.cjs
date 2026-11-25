/**
 * Run from the repository root with dashboard dependencies and Chrome installed.
 * Set NODE_PATH to a directory containing playwright-core (checked with 1.65.1),
 * then run `node data/tasks/81443b0e-84fd-4634-bb01-a51d5c5f0ef7/evidence/replay.cjs`.
 * CHECK_CHROME optionally selects a different Chrome or Chromium binary.
 *
 * active.json and between.json record the same Nov 24 overnight ingestion run
 * during work and at the following gap. Each joins read-only Praxis GETs
 * /local-llm/queue?active=1 and /api/dispatch/state to a simultaneous read
 * of data/local-llm/queue.json. All three reads agreed on counts and running
 * job IDs. dispatch retains sampled rows and the reported models and lane.
 * queueRead and runHistory preserve full active and per-run counts. board
 * retains this task and its project from the Nexus task and project GETs.
 *
 * projection is the result of running Praxis src/local-llm/work-snapshot.ts
 * localLlmWorkSnapshot against the recorded time, overnight policy and isolated
 * copies of the durable jobs and ingestion/runs/<run_id>/manifest.json. Every
 * manifest hash and assigned job ID matched the 396 ingest_item rows. This
 * supplies the display names, source title, progress and queue eligibility.
 * After the producer gained started, nextLocalRunId and directCallsInFlight,
 * its final implementation replayed the same 398 job IDs at each capture time.
 * All 396 sources had at most one attempt. Persisted start/completion times,
 * observed running IDs and source counts fixed their states at each instant.
 * Every field from the original projection matched, including the updated
 * times. The added fields use the actual claim order and recorded lane policy.
 * Both dispatch samples reported zero in-flight local calls. The recorded
 * local worker lane and single resident chat model describe the assigned
 * lane and loaded model. The captured producer had no named caller tracking
 * or native instance list. The replay expects explicit serving uncertainty.
 *
 * Chrome renders the real DispatchStation, ExecutorDetailModal, StatusStrip
 * and CurrentFocusPanel with the dashboard stylesheet. It reads only the
 * recorded payloads and inert companion responses. The test stubs support
 * Next navigation, chat context and sockets. All browser HTTP responses are
 * fulfilled in memory; the Current Focus reconnecting notice is expected.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');

const dashboard = path.resolve(__dirname, '../../../../dashboard');
const fromDashboard = createRequire(path.join(dashboard, 'package.json'));
const esbuild = fromDashboard('esbuild');
const postcss = fromDashboard('postcss');
const tailwind = fromDashboard('@tailwindcss/postcss');
const origin = 'http://replay.invalid';

async function assets() {
  // The station inherits the same three grid widths as on the home page.
  const entry = `
    import { createRoot } from 'react-dom/client';
    import { HitlInboxProvider } from '@/hooks/use-hitl-inbox';
    import { BridgeActivityProvider } from '@/components/bridge/activity-provider';
    import { DispatchStation } from '@/components/bridge/dispatch-station';
    import { StatusStrip } from '@/components/bridge/status-strip';
    createRoot(document.querySelector('main')).render(
      <HitlInboxProvider><BridgeActivityProvider>
        <div className="mx-auto w-full max-w-[2400px] p-3 sm:p-6">
          <StatusStrip />
          <div className="mb-6 grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-4">
              <div className="order-3 grid min-w-0 gap-4 md:grid-cols-2 xl:order-none">
                <div id="station-dispatch"><DispatchStation /></div>
              </div>
            </div>
          </div>
        </div>
      </BridgeActivityProvider></HitlInboxProvider>
    );`;
  const stub = name => path.join(dashboard, 'test/stubs', name + '.mjs');
  const js = await esbuild.build({
    absWorkingDir: dashboard,
    stdin: { contents: entry, loader: 'tsx', resolveDir: dashboard },
    bundle: true, write: false, jsx: 'automatic', tsconfig: path.join(dashboard, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    alias: { 'next/link': stub('next-link'), 'next/navigation': stub('next-navigation'),
      'socket.io-client': stub('socket-io-client'), '@/components/cortex-provider': stub('cortex-provider') },
  });
  const cssFile = path.join(dashboard, 'src/app/globals.css');
  const css = await postcss([tailwind({ base: path.join(dashboard, 'src') })])
    .process(fs.readFileSync(cssFile, 'utf8'), { from: cssFile });
  return { script: js.outputFiles[0].text, style: css.css };
}

const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="hud-backdrop antialiased" style="font-family:system-ui,sans-serif"><main></main><script src="/app.js"></script></body></html>';

async function replay(browser, files, label) {
  const input = JSON.parse(fs.readFileSync(path.join(__dirname, label + '.json'), 'utf8'));
  const state = structuredClone(input.dispatch);
  Object.assign(state.localLlm, input.projection);
  state.executors.usageWaits = { available: true, items: [] };
  const work = state.localLlm.runs.find(run => run.type === 'ingest_item');
  const { finished, total, running, queued, name } = work;
  const standalone = state.localLlm.runs.find(run => run.type === 'conversation_evolve_sweep');
  assert.equal(standalone.runId, null);
  assert.equal(standalone.running, 0);
  assert.equal(standalone.queued, 1);
  const expected = `${finished} of ${total} finished`;
  const source = input.manifest.runningItems[0]?.title;
  assert.equal(finished, input.runHistory.statuses.succeeded);
  assert.equal(total, input.manifest.deduped_count);
  assert.equal(running, input.queueRead.typeAndStatus.ingest_item.running || 0);
  assert.equal(queued, input.queueRead.typeAndStatus.ingest_item.queued + input.queueRead.typeAndStatus.ingestion_finalize_run.queued);
  assert.equal(Boolean(running), label === 'active');
  assert.equal(work.allowedNow, true);
  assert.equal(work.started, true);
  assert.equal(standalone.started, false);
  assert.equal(state.localLlm.nextLocalRunId, work.id);
  assert.equal(state.localLlm.directCallsInFlight, input.dispatch.localLane.inFlightLocalCalls);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1,
    timezoneId: 'America/New_York', locale: 'en-US', serviceWorkers: 'block',
  });
  const errors = [];
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date(input.observedAt));
    const requests = [];
    await context.route('**/*', route => {
      const { pathname, origin: host } = new URL(route.request().url());
      requests.push([route.request().method(), pathname]);
      if (route.request().method() !== 'GET' || host !== origin) return route.abort();
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: files.script });
      if (pathname === '/app.css') return route.fulfill({ contentType: 'text/css', body: files.style });
      if (/^\/brand\/[a-z-]+\.svg$/.test(pathname)) return route.fulfill({ contentType: 'image/svg+xml', path: path.join(dashboard, 'public', pathname) });
      if (pathname === '/api/praxis/dispatch-state') return route.fulfill({ json: state });
      // Empty companion feeds keep unrelated workspace content out of the captures.
      if (pathname === '/api/board-state') return route.fulfill({ json: input.board });
      if (pathname === '/api/praxis/hitl/pending') return route.fulfill({ json: { requests: [] } });
      if (pathname === '/api/praxis/council/sessions') return route.fulfill({ json: { sessions: [] } });
      if (pathname === '/api/ai/chat/activity') return route.fulfill({ json: { at: input.observedAt, turns: [] } });
      return route.fulfill({ status: 404, json: {} });
    });
    await context.routeWebSocket(/.*/, socket => socket.close());
    await page.goto(origin);
    const indicator = page.getByRole('button', { name: /Inspect Local LLM/ });
    await indicator.getByText(expected, { exact: false }).waitFor();
    assert.match(await indicator.innerText(), /Knowledge ingestion/i);
    assert.equal(await indicator.getAttribute('data-active'), 'true');
    if (!running) assert.match(await indicator.innerText(), /between items/i);
    assert.equal(await indicator.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    const station = page.locator('#station-dispatch');
    await station.screenshot({ path: path.join(__dirname, label + '-bridge.png'), animations: 'disabled' });
    await indicator.click();
    const detail = page.getByRole('dialog', { name: 'Local LLM', exact: true });
    await detail.getByText(expected, { exact: false }).first().waitFor();
    const detailText = await detail.innerText();
    assert.ok(detailText.includes(name) && detailText.includes(`${queued} queued`));
    if (running) {
      assert.ok(detailText.includes(source));
      assert.match(detailText, /local worker.*google\/gemma-4-31b-qat resident.*serving model unconfirmed/i);
      const seconds = Math.floor((Date.parse(input.observedAt) - Date.parse(work.items[0].startedAt)) / 1000);
      assert.ok(seconds >= 0 && seconds < 3600);
      const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      assert.ok(detailText.includes(elapsed + ' elapsed'));
    } else assert.match(detailText, /between items/i);
    await detail.screenshot({ path: path.join(__dirname, label + '-detail.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Current Focus:/ }).click();
    const focus = page.getByRole('dialog', { name: 'Current Focus' });
    const rows = focus.locator('[data-focus-task]').filter({ hasText: name });
    await rows.first().waitFor();
    const standaloneRow = focus.locator('[data-focus-task]').filter({ hasText: standalone.name });
    assert.equal(await standaloneRow.count(), 1);
    assert.match(await standaloneRow.innerText(), /waiting for worker/i);
    assert.equal(await rows.count(), 1);
    const focusText = await rows.innerText();
    assert.ok(focusText.includes(expected) && focusText.includes(`${queued} queued`));
    if (running) assert.ok(focusText.includes(source) && focusText.includes('google/gemma-4-31b-qat'));
    else {
      assert.match(focusText, /between items/i);
      assert.doesNotMatch(focusText, /elapsed|google\/gemma/i);
    }
    await focus.screenshot({ path: path.join(__dirname, label + '-focus.png'), animations: 'disabled' });
    assert.deepEqual(errors, []);
    assert.ok(requests.some(([, url]) => url === '/api/praxis/dispatch-state'));
    assert.ok(requests.every(([method]) => method === 'GET'));
    console.log(`${label}: ${expected}; ${running} running, ${queued} queued; bridge, detail and one Current Focus run row passed.`);
  } catch (error) {
    if (errors.length) console.error('Browser exceptions:', errors);
    throw error;
  } finally {
    await context.close();
  }
}

async function main() {
  const files = await assets();
  const browser = await chromium.launch({
    executablePath: process.env.CHECK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--disable-background-networking', '--disable-gpu'],
  });
  try {
    console.log('Chromium ' + browser.version());
    for (const label of ['active', 'between']) await replay(browser, files, label);
  } finally {
    await browser.close();
    esbuild.stop();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
