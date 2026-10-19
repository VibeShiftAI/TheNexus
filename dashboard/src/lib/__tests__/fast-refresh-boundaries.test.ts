/**
 * Ratchet: modules the root layout imports must stay Fast Refresh boundaries.
 *
 * The live cockpit on :3000 is `next dev` serving the working tree. React
 * Fast Refresh hot-swaps a module only when every runtime export is a
 * component; a stray constant or hook export makes a save of that file a full
 * reload of every open page. On 2026-10-19 that reload, triggered by an
 * executor's edit of global-voice-dock.tsx, erased the comment Robert was
 * typing on a document review (task 1390fc34). Modules already outside the
 * rule are listed; nothing new may join them, and the ones fixed must stay fixed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** Layout-imported modules that already export non-components; a follow-up task owns moving those exports. */
const KNOWN_FULL_RELOAD_MODULES = new Set(['bridge/activity-provider', 'cortex-provider', 'live-board-state', 'connection-banner']);

function layoutComponentModules(): string[] {
  const layout = readFileSync(path.join(SRC, 'app/layout.tsx'), 'utf8');
  return [...layout.matchAll(/from\s+"@\/components\/([^"]+)"/g)].map(m => m[1]);
}

/** Runtime exports that are not React components, by a conservative reading of the source. */
export function nonComponentExports(source: string): string[] {
  const offenders: string[] = [];
  for (const line of source.split('\n')) {
    const m = line.match(/^export\s+(.*)$/);
    if (!m) continue;
    const rest = m[1];
    if (/^(type|interface)\s/.test(rest) || /^type\s*\{/.test(rest)) continue; // erased at runtime
    let name: RegExpMatchArray | null;
    if ((name = rest.match(/^(?:default\s+)?function\s+([A-Za-z_$][\w$]*)/))) { if (!/^[A-Z]/.test(name[1])) offenders.push(name[1]); continue; }
    if ((name = rest.match(/^const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/))) {
      const componentLike = /^[A-Z]/.test(name[1]) && /^(\(|function\b|memo\(|forwardRef\(|React\.memo\(|React\.forwardRef\(|dynamic\()/.test(name[2]);
      if (!componentLike) offenders.push(name[1]);
      continue;
    }
    if ((name = rest.match(/^\{([^}]*)\}/))) { offenders.push(...name[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop() ?? '').filter(Boolean)); continue; }
    offenders.push(rest.trim());
  }
  return offenders;
}

test('every module the root layout imports is a Fast Refresh boundary, except the ones already listed', () => {
  const modules = layoutComponentModules();
  assert.ok(modules.includes('global-voice-dock'), 'the layout still mounts the voice dock');
  const offenders: Record<string, string[]> = {};
  for (const name of modules) {
    const found = nonComponentExports(readFileSync(path.join(SRC, 'components', `${name}.tsx`), 'utf8'));
    if (found.length) offenders[name] = found;
  }
  for (const [name, exportsFound] of Object.entries(offenders)) {
    assert.ok(KNOWN_FULL_RELOAD_MODULES.has(name), `${name} exports ${exportsFound.join(', ')}: a save of it now reloads every open page. Move the value to a lib module.`);
  }
  for (const name of ['global-voice-dock', 'display-scale', 'bridge/event-ticker', 'mobile-shell-bridge']) {
    assert.equal(offenders[name], undefined, `${name} must stay component-only`);
  }
});

test('the voice dock storage key is read from the lib module, not exported by the component', () => {
  const dock = readFileSync(path.join(SRC, 'components/global-voice-dock.tsx'), 'utf8');
  assert.doesNotMatch(dock, /export const VOICE_DOCK_COLLAPSED_KEY/);
  assert.match(dock, /from "@\/lib\/voice-dock-preferences"/);
});

test('the export reader distinguishes components from values', () => {
  assert.deepEqual(nonComponentExports('export function Dock() {}\nexport default function Page() {}\nexport const Memo = memo(function X() {});\nexport type A = 1;\nexport interface B {}\nexport type { C };'), []);
  assert.deepEqual(nonComponentExports('export const KEY = "k";\nexport function useThing() {}\nexport { A, b as c };\nexport const Big = 4;'), ['KEY', 'useThing', 'A', 'c', 'Big']);
});
