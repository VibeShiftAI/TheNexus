import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { CliLanePanel } from '../bridge/cli-lane-panel.tsx';
import { deriveCliLane } from '../../lib/cli-lane.ts';

test('capacity gate keeps technical prose behind a keyboard-accessible drilldown', async () => {
  const reason = 'serial: swap pathological: 14495MB > 7373MB ceiling; occupancy 0/1';
  const view = deriveCliLane({ executors: { cliQueue: [], cliConcurrency: {
    limit: 1, active: 0, free: 1, queued: 0, burst: false, reason,
  } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(CliLanePanel, { view })));
    const button = container.querySelector('button[aria-label^="Inspect executor capacity"]');
    assert.ok(button);
    assert.match(button.textContent, /Swap limit reached/);
    assert.equal(container.textContent.includes('14495MB'), false);
    button.focus();
    await act(async () => button.click());
    const dialog = document.querySelector('[role="dialog"]');
    assert.equal(dialog.getAttribute('aria-label'), 'Executor capacity');
    const report = dialog.querySelector('details');
    assert.equal(report.open, false);
    await act(async () => report.querySelector('summary').click());
    assert.equal(report.open, true);
    assert.ok(report.textContent.includes(reason));
    assert.ok(dialog.querySelector('a[href="/ops"]'));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, button);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
