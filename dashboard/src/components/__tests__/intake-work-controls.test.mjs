import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useProjectRecord } from '../../hooks/use-project-record.ts';

const require = createRequire(import.meta.url);
async function mount(folder) {
  const source = fs.readFileSync(new URL('../../app/project/[id]/page.tsx', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022' }).code;
  const project = { id: 'p', name: 'Define project', phase: 'intake', path: folder, type: 'project', needs: [], intake: { revision: 1 } };
  const nothing = () => null; const stub = { __esModule: true, default: nothing, FolderOpen: nothing, activityBand: nothing, timeAgo: nothing, readChatDraft: nothing, writeChatDraft: nothing };
  for (const match of source.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)) stub[match[1]] = nothing;
  stub.TaskManager = () => createElement('p', { 'data-control': 'tasks' }, 'Task controls');
  stub.ProjectMaintenance = () => createElement('p', { 'data-control': 'workspace' }, 'Workspace controls');
  stub.ProjectCheckpointsPanel = () => createElement('p', { 'data-control': 'checkpoints' }, 'Checkpoint controls');
  stub.ProjectEndpointPanel = () => createElement('p', { 'data-control': 'endpoint' }, 'Goal controls');
  stub.ProjectNeedsPanel = () => createElement('p', { 'data-control': 'needs' }, 'Knowledge controls');
  const nexus = { getProject: async () => project, getProjectBrief: async () => null, getProjectCommits: async () => ({ commits: [], hasGit: false }), getTasks: async () => [], getProjectReadme: async () => ({ exists: false }), getDashboardStats: async () => null };
  const load = name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === '@/lib/nexus') return nexus;
    if (name === '@/hooks/use-project-record') return { useProjectRecord };
    if (name === 'next/navigation') return { useParams: () => ({ id: 'p' }), useRouter: () => ({ push: nothing }), useSearchParams: () => ({ get: () => null }) };
    if (name === '@/components/live-board-state') return { useLiveRefetch: nothing };
    return stub;
  };
  const module = { exports: {} }; new Function('require', 'module', 'exports', code)(load, module, module.exports);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => { root.render(createElement(module.exports.default)); await new Promise(resolve => setImmediate(resolve)); });
  return { container, close() { act(() => root.unmount()); container.remove(); } };
}
test('Intake retains task controls and attached workspace operations', async () => {
  const ui = await mount('/work/project');
  try { assert.ok(ui.container.querySelector('[data-control="tasks"]')); assert.ok(ui.container.querySelector('[data-control="workspace"]')); }
  finally { ui.close(); }
});
test('record-only Intake permits task filing without inventing a workspace', async () => {
  const ui = await mount('');
  try { assert.ok(ui.container.querySelector('[data-control="tasks"]')); assert.equal(ui.container.querySelector('[data-control="workspace"]'), null); }
  finally { ui.close(); }
});
test('Intake keeps checkpoint, goal, and knowledge editors available', async () => {
  const ui = await mount('');
  try {
    for (const control of ['checkpoints', 'endpoint', 'needs']) assert.ok(ui.container.querySelector(`[data-control="${control}"]`), `${control} editor should remain mounted`);
  } finally { ui.close(); }
});
