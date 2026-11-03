// Read-only live browser capture. Run from this repository; no fixtures or API writes.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const output = join(dirname(fileURLToPath(import.meta.url)), 'evidence');
const profile = mkdtempSync(join(tmpdir(), 'nexus-2552-browser-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
async function until(fn, label) {
  for (let n = 0; n < 120; n++) { if (await fn()) return; await sleep(250); }
  throw new Error(`Timeout: ${label}`);
}
try {
  await until(() => existsSync(join(profile, 'DevToolsActivePort')), 'Chrome startup');
  const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => { ws.onopen = resolve; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, m => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
    return m.result.result.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const capture = async (name, selector) => {
    if (selector) await evaluate(`(()=>{document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start'});window.scrollBy(0,-110)})()`);
    await sleep(500);
    const data = await evaluate(`({url:location.href,title:document.title,text:document.body.innerText,links:[...document.querySelectorAll('a[href]')].map(a=>({text:a.innerText,href:a.getAttribute('href')})),badges:[...document.querySelectorAll('[title]')].filter(e=>/token|model|estimat|telemetry|verif/i.test(e.title)).map(e=>({text:e.innerText,title:e.title,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}))})`);
    data.checked_at = new Date().toISOString();
    writeFileSync(join(output, `${name}-browser.json`), JSON.stringify(data, null, 2) + '\n', 'utf8');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
    console.log(`CAPTURE ${name}: ${data.url}; ${data.text.length} text characters`);
  };
  const navigate = async (url, ready) => {
    await send('Page.navigate', { url });
    await until(() => evaluate(`Boolean(location.href===${JSON.stringify(url)} && document.readyState==='complete' && (${ready}))`), url);
    await sleep(2000);
  };
  await navigate('http://localhost:3000/', 'document.body.innerText.length>300');
  await capture('dashboard');
  try { await until(() => evaluate("!document.querySelector('#panel-activity')?.innerText.includes('Loading activity')"), 'activity loaded'); }
  catch (error) { console.log(`GAP ${error.message}`); }
  await evaluate("[...document.querySelectorAll('#panel-activity button')].find(e=>e.innerText.startsWith('Commits'))?.click()");
  await sleep(500);
  await capture('attribution', '#panel-activity');
  await navigate('http://localhost:3000/activity', "document.body.innerText.includes('Measured routing economics')");
  await until(() => evaluate("document.querySelector('#routing-economics')?.innerText.includes('Cloud')"), 'economics data');
  await capture('routing-economics', '#routing-economics');
  for (const state of ['verified', 'unverified']) {
    const id = JSON.parse(readFileSync(join(output, `${state}-dossier.json`), 'utf8')).body.taskId;
    await navigate('http://localhost:3000/task-board?lane=complete', "document.querySelector('input[placeholder^=\"Search tasks\"]')");
    await evaluate(`(()=>{const e=document.querySelector('input[placeholder^="Search tasks"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(id)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    const cardSelector = `a[href="/task/${id}"][aria-label]`;
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(cardSelector)}))`), `${state} evidence card`);
    await capture(`${state}-card`, cardSelector);
    const cardClick = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(cardSelector)});const result={from:location.href,href:e.getAttribute('href'),label:e.getAttribute('aria-label'),text:e.innerText};e.click();return result})()`);
    await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"Completion evidence\"]'))"), 'dossier after one click');
    await sleep(1000);
    writeFileSync(join(output, `${state}-card-click.json`), JSON.stringify({checked_at:new Date().toISOString(),...cardClick,to:await evaluate('location.href')},null,2)+'\n','utf8');
    await capture(`${state}-completion`, '[aria-label="Completion evidence"]');
    const click = await evaluate(`(()=>{const e=document.querySelector('#evidence-verify button'); if(!e)return null;const before=e.getAttribute('aria-expanded');e.click();return {text:e.innerText,before}})()`);
    await sleep(500);
    await capture(`${state}-verify-expanded`, '#evidence-verify');
    const after = await evaluate("document.querySelector('#evidence-verify button')?.getAttribute('aria-expanded')");
    writeFileSync(join(output, `${state}-click.json`), JSON.stringify({ checked_at: new Date().toISOString(), click, after }, null, 2) + '\n', 'utf8');
  }
} finally {
  ws?.close();
  if (chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
  }
  rmSync(profile, { recursive: true, force: true });
}
