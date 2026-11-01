import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { useProjectRecord } from '../use-project-record.ts';

const project = revision => ({ id: 'p', name: 'Project', path: '', type: 'project', intake: { revision } });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount(read) {
  let value;
  function Harness({ id = 'p' }) { value = useProjectRecord(id, read); return createElement('div', null, value.project?.intake.revision ?? 'empty'); }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
  return { get value() { return value; }, container, render: id => act(async () => root.render(createElement(Harness, { id }))), close() { act(() => root.unmount()); container.remove(); } };
}
test('late older reads cannot replace a newer project or its successful refresh state', async () => {
  const old = deferred(), recent = deferred(); let reads = 0;
  const ui = await mount(() => (++reads === 1 ? old.promise : recent.promise));
  try {
    let a, b; await act(async () => { a = ui.value.refresh(); b = ui.value.refresh(); });
    await act(async () => { recent.resolve(project(2)); await b; });
    await act(async () => { old.resolve(project(1)); await a; });
    assert.equal(ui.value.project.intake.revision, 2);
    assert.equal(ui.value.refreshError, false);
  } finally { ui.close(); }
});
test('a stale request failure cannot replace success with an unavailable warning', async () => {
  const old = deferred(), recent = deferred(); let reads = 0;
  const ui = await mount(() => (++reads === 1 ? old.promise : recent.promise));
  try {
    let a, b; await act(async () => { a = ui.value.refresh(); b = ui.value.refresh(); });
    await act(async () => { recent.resolve(project(2)); await b; });
    await act(async () => { old.reject(new Error('old timeout')); await a; });
    assert.equal(ui.value.refreshError, false);
  } finally { ui.close(); }
});
test('saved edits invalidate pending reads and wrong-project responses never enter the view', async () => {
  const old = deferred(); const ui = await mount(() => old.promise);
  try {
    let pending; await act(async () => { pending = ui.value.refresh(); ui.value.apply(project(3)); });
    await act(async () => { old.resolve(project(1)); await pending; });
    assert.equal(ui.value.project.intake.revision, 3);
    await act(async () => ui.value.apply({ ...project(4), id: 'another-project' }));
    assert.equal(ui.value.project.intake.revision, 3);
  } finally { ui.close(); }
});
test('a refresh retained by the previous page cannot cancel the new project request', async () => {
  const current = deferred(); const calls = [];
  const ui = await mount(id => { calls.push(id); return current.promise; });
  try {
    const oldRefresh = ui.value.refresh;
    await ui.render('new');
    let pending; await act(async () => { pending = ui.value.refresh(); void oldRefresh(); });
    await act(async () => { current.resolve({ ...project(2), id: 'new' }); await pending; });
    assert.deepEqual(calls, ['new']);
    assert.equal(ui.value.project.id, 'new');
  } finally { ui.close(); }
});
