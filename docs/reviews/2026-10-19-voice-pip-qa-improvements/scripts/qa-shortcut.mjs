import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${mkdtempSync('/tmp/voice-pip/prof-')}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  let target; for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find(t => t.type === 'page'); } catch {} }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(); ws.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const shot = async name => writeFileSync(`/tmp/voice-pip/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  await send('Page.enable'); await send('Page.navigate', { url: 'http://localhost:3000/task-board' });
  for (let i = 0; i < 60 && !(await evaluate(`!!document.querySelector('[aria-label="Collapse voice controls"]')`)); i++) await sleep(500);
  await sleep(3000);
  const state = () => evaluate(`(() => { const b = document.querySelector('#global-voice-bar'); const r = document.querySelector('[aria-label="Global voice controls"]').getBoundingClientRect(); const v = document.querySelector('[aria-label="Start voice command"]'); const c = document.querySelector('[aria-label="Start conversation"]'); return { url: location.pathname, collapsed: b?.dataset.collapsed, visibility: b && getComputedStyle(b).visibility, opacity: b && getComputedStyle(b).opacity, dock: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, voiceVisible: !!v && v.getBoundingClientRect().width > 0 && getComputedStyle(b).visibility === 'visible', conversationVisible: !!c && c.getBoundingClientRect().width > 0 && getComputedStyle(b).visibility === 'visible', pip: document.querySelector('[aria-controls="global-voice-bar"]')?.getAttribute('aria-label'), viewport: innerWidth + 'x' + innerHeight }; })()`);
  console.log('expanded ', JSON.stringify(await state())); await shot('1-expanded');
  await evaluate(`document.querySelector('[aria-label="Collapse voice controls"]').click()`); await sleep(600);
  console.log('collapsed', JSON.stringify(await state()), 'stored=', await evaluate(`localStorage.getItem('nexus.voice.dock.collapsed')`)); await shot('2-collapsed');
  await send('Page.reload'); await sleep(4000);
  console.log('reloaded ', JSON.stringify(await state()));
  await evaluate(`document.querySelector('[aria-label="Expand voice controls"]').click()`); await sleep(600);
  console.log('expanded2', JSON.stringify(await state())); await shot('3-re-expanded');
  await evaluate(`document.querySelector('[aria-label="Voice settings"]').click()`); await sleep(400);
  console.log('settings dialog opens:', await evaluate(`!!document.querySelector('[role="dialog"][aria-label="Talk to Praxis setup"]')`));
  await evaluate(`localStorage.removeItem('nexus.voice.dock.collapsed')`);
  await evaluate(`document.querySelector('[aria-label="Collapse voice controls"]').click()`); await sleep(300);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', altKey: true, shiftKey: true, bubbles: true }))`); await sleep(300);
  console.log('after collapsed shortcut', JSON.stringify(await state()), 'dialog visibility', await evaluate(`getComputedStyle(document.querySelector('[role="dialog"][aria-label="Talk to Praxis setup"]')).visibility`));
  ws.close();
} finally { chrome.kill(); }
