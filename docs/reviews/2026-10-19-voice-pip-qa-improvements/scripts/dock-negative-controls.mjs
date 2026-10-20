// Negative controls for task 1599d9c7: run voice-dock.test.ts in /tmp copies of the working tree with fixes partly reverted.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
const SRC = '/Volumes/Projects/TheNexus/dashboard';
const bar = 'src/components/bridge/voice-command-bar.tsx', dock = 'src/components/global-voice-dock.tsx';
const swap = (text, from, to) => { if (!text.includes(from)) throw new Error(`missing hunk: ${from.slice(0, 60)}`); return text.replace(from, to); };
const revertRouting = t => swap(swap(t, "e.preventDefault(); window.dispatchEvent(new window.Event(VOICE_SETUP_EVENT));", "e.preventDefault(); openSetup();"), "  }, [cancelAll]);\n  useEffect(() => {\n    const onVisibility", "  }, [cancelAll, openSetup]);\n  useEffect(() => {\n    const onVisibility");
const revertFocus = t => swap(t, "setSetupFocusRequest(request => request + 1);", "settingsRef.current?.focus();");
const revertCss = t => swap(t, '`duration-200 ease-out ${collapsed ? "invisible max-h-0 max-w-0 overflow-hidden opacity-0 transition-[max-width,opacity,visibility]" : "visible max-w-[100vw] opacity-100 transition-[max-width,opacity]"}`', '`transition-[max-width,opacity,visibility] duration-200 ease-out ${collapsed ? "invisible max-h-0 max-w-0 overflow-hidden opacity-0" : "visible max-w-[100vw] opacity-100"}`');
const variants = {
  'no-fix (parent behaviour)': { [bar]: t => revertFocus(revertRouting(t)), [dock]: revertCss },
  'routing only': { [bar]: revertFocus, [dock]: revertCss },
  'routing + css, synchronous focus': { [bar]: revertFocus },
  'routing + focus, visibility transition on expand': { [dock]: revertCss },
  'all fixes': {},
};
for (const [name, patches] of Object.entries(variants)) {
  const dir = `/tmp/voice-pip-neg/${name.replace(/[^a-z]+/g, '-')}`;
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  execSync(`rsync -a --exclude node_modules --exclude '.next*' ${SRC}/ ${dir}/`);
  symlinkSync(`${SRC}/node_modules`, `${dir}/node_modules`);
  for (const [file, patch] of Object.entries(patches)) writeFileSync(`${dir}/${file}`, patch(readFileSync(`${dir}/${file}`, 'utf8')));
  let out; try { out = execSync('node --import ./test/register.mjs --test src/lib/__tests__/voice-dock.test.ts 2>&1', { cwd: dir, encoding: 'utf8' }); } catch (e) { out = e.stdout; }
  const summary = out.split('\n').filter(l => /^ℹ (pass|fail) /.test(l)).join(' ');
  const failure = out.split('\n').find(l => /^\s+(AssertionError|'|[0-9a-z]+ !==)/.test(l) && !/^\s+AssertionError/.test(l)) ?? '';
  const message = (out.match(/AssertionError \[ERR_ASSERTION\]: ([^\n]+)/) ?? [])[1] ?? '';
  console.log(`${name}: ${summary}${message ? ` | first failure: ${message}${failure ? ' ' + failure.trim() : ''}` : ''}`);
}
