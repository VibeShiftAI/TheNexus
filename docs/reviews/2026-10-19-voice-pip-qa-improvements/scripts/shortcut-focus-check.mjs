// Live :3000 check for task 1599d9c7: Alt+Shift+V on a collapsed dock (setup closed, held key, setup left open).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${mkdtempSync('/tmp/voice-pip/prof-')}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  let target; for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch('http://127.0.0.1:9334/json')).json()).find(t => t.type === 'page'); } catch {} }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(); ws.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Page.enable'); await send('Page.navigate', { url: 'http://localhost:3000/task-board' });
  for (let i = 0; i < 60 && !(await evaluate(`!!document.querySelector('[aria-label="Collapse voice controls"]')`)); i++) await sleep(500);
  await sleep(3000);
  const state = () => evaluate(`(() => { const b = document.querySelector('#global-voice-bar'); const d = document.querySelector('[role="dialog"][aria-label="Talk to Praxis setup"]'); const a = document.activeElement; return { collapsed: b?.dataset.collapsed, barVisibility: getComputedStyle(b).visibility, dialog: !!d, dialogVisibility: d ? getComputedStyle(d).visibility : null, focusInDialog: !!d && d.contains(a), active: a ? (a.getAttribute('aria-label') || a.getAttribute('role') || a.tagName) : null, stored: localStorage.getItem('nexus.voice.dock.collapsed'), transition: getComputedStyle(b).transitionProperty }; })()`);
  const key = (repeat = false) => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', altKey: true, shiftKey: true, repeat: ${repeat}, bubbles: true }))`);
  const pip = label => evaluate(`document.querySelector('[aria-label="${label}"]').click()`);
  console.log('start                   ', JSON.stringify(await state()));
  await pip('Collapse voice controls'); await sleep(400);
  console.log('A collapsed, setup shut ', JSON.stringify(await state()));
  await key(true); await sleep(400);
  console.log('B held key (repeat)     ', JSON.stringify(await state()));
  await key(); await sleep(400);
  console.log('C shortcut              ', JSON.stringify(await state()));
  await pip('Collapse voice controls'); await sleep(400);
  console.log('D collapsed, setup open ', JSON.stringify(await state()));
  await key(); await sleep(400);
  console.log('E shortcut              ', JSON.stringify(await state()));
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(300);
  console.log('F Escape                ', JSON.stringify(await state()));
  ws.close();
} finally { chrome.kill(); }
