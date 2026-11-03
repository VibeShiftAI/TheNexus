#!/usr/bin/env node
/**
 * Foreground isolated verification: real Nexus relay + fake Praxis + built Next
 * + headless Chrome. Owns and closes every child/socket. Never uses the live DB.
 * Build: NEXT_DIST_DIR=.next-runtime-verify NEXT_PUBLIC_API_URL=http://127.0.0.1:4297 npm run build
 * Run from dashboard: node scripts/runtime-health-browser-check.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(dashboard, '../package.json'));
const express = require('express');
const createRouter = require('./server/routes/praxis-stream');
const temp = mkdtempSync(join(tmpdir(), 'nexus-runtime-browser-'));
const date = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const children = [], servers = [];
let router, ws;
let scenario = 'healthy';
process.env.PRAXIS_URL = 'http://127.0.0.1:4298';
process.env.PRAXIS_DATA_DIR = temp;
process.env.PRAXIS_USAGE_RESUME_FILE = join(temp,'waits.json');
mkdirSync(join(temp,'morning-health'));
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
function setScenario(value) {
  scenario = value;
  writeFileSync(process.env.PRAXIS_USAGE_RESUME_FILE, JSON.stringify(value === 'usage' ? [{taskId:'usage-task',executor:'codex',kind:'usage_limit',resumeAtIso:'2026-01-01T00:00:00Z'}] : []), 'utf8');
  writeFileSync(join(temp,'morning-health',`${date}.json`), JSON.stringify({date,report:{capturedAt:new Date().toISOString(),checks:[{name:'day activity',status:value==='day'?'yellow':'green',detail:value==='day'?'0 dispatched, 0 in flight':'Work dispatched'}]}}), 'utf8');
}
function child(command,args,env=process.env) {
  const p=spawn(command,args,{cwd:dashboard,env,stdio:['ignore','pipe','pipe']});
  p.output=''; p.stdout.on('data',d=>p.output+=d); p.stderr.on('data',d=>p.output+=d); children.push(p); return p;
}
async function listen(app,port) { const s = await new Promise((resolve,reject)=>{const s=app.listen(port,'127.0.0.1',()=>resolve(s));s.on('error',reject);}); servers.push(s); }
async function waitFor(fn,label) { for(let i=0;i<100;i++){if(await fn())return;await sleep(200);}throw Error(`Timed out: ${label}`); }
try {
  setScenario('healthy');
  const praxis=express();
  praxis.get('/stream',(_req,res)=>{res.setHeader('Content-Type','text/event-stream');res.flushHeaders();});
  praxis.get('/api/dispatch/state',(_req,res)=>{
    if(scenario==='unreachable')return res.status(503).json({error:'Praxis unavailable'});
    res.json({executors:{runs:[],sessions:[],cliQueue:[],
      posture:scenario==='wedged'?{mode:'degraded',summary:'Fleet capacity reduced',suspended:[{executor:'codex',reason:'wedged executor'}]}:{mode:'nominal',summary:'All workers routable',suspended:[]},
      attemptStalls:{pending:0,violations:scenario==='silent'?[{taskId:'silent-task',causeTitle:'Silent failure',detail:'Approved slot has no attempt'}]:[]}},cron:[],localLlm:{jobs:[]}});
  });
  await listen(praxis,4298);
  const api=express(); router=createRouter(); api.use('/api/praxis',router);
  api.get('/api/system/status',(_req,res)=>res.json({system:{cpu:{usage:2},memory:{usagePercent:5}},ports:[{port:4000,type:'node',process:'node',pid:1}],portCount:1,praxis:{status:'online',dailyCallCount:2,quota:{resetTime:'1 hour',providers:{openai:{requestsToday:2}}}}}));
  api.get('/api/ai/usage',(_req,res)=>res.json({totals:{totalTokens:0},byProvider:{},recentUsage:[]}));
  api.use((_req,res)=>res.status(503).json({error:'Unrelated surface not in fixture'}));
  await listen(api,4297);
  const next=child(join(dashboard,'node_modules/.bin/next'),['start','-p','3297'],{...process.env,NEXT_DIST_DIR:'.next-runtime-verify',NEXT_PUBLIC_API_URL:'http://127.0.0.1:4297'});
  await waitFor(async()=>{if(next.exitCode!==null)throw Error(next.output);try{return (await fetch('http://127.0.0.1:3297/system-monitor')).ok;}catch{return false;}},'Next');
  const chromePath=[process.env.CHECK_CHROME,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&existsSync(p));
  assert.ok(chromePath,'Chrome installed');
  child(chromePath,['--headless=new','--remote-debugging-port=9497',`--user-data-dir=${join(temp,'chrome')}`,'--no-first-run','--disable-gpu','about:blank']);
  await waitFor(async()=>{try{return (await fetch('http://127.0.0.1:9497/json/version')).ok;}catch{return false;}},'Chrome');
  const target=await(await fetch('http://127.0.0.1:9497/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve=>ws.onopen=resolve);
  let id=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}};
  const send=(method,params={})=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.result?.value;
  await send('Page.enable'); await send('Runtime.enable');
  for(const name of ['wedged','usage','silent','day','healthy','unreachable']) {
    setScenario(name);
    await send('Page.navigate',{url:`http://127.0.0.1:3297/system-monitor?case=${name}`});
    await waitFor(()=>evaluate(name==='healthy'?`!document.querySelector('[data-runtime-banner]') && document.body.textContent.includes('Runtime healthy')`:`document.querySelector('[data-runtime-banner]')?.dataset.runtimeBanner === '${name==='unreachable'?'unknown':'degraded'}'`),name);
    await waitFor(()=>evaluate(`document.body.textContent.includes('API Calls Today')`),'monitor telemetry rendered');
    const facts=await evaluate(`(()=>{const b=document.querySelector('[data-runtime-banner]');return {banner:b?.textContent??null,top:b?.getBoundingClientRect().top??null,links:b?[...b.querySelectorAll('a')].map(a=>a.getAttribute('href')):[],green:[...document.querySelectorAll('[class]')].filter(e=>/(?:text|bg|border|from|via|to)-(?:emerald|green)-/.test(e.className?.baseVal??e.className)).map(e=>e.textContent)}})()`);
    if(name!=='healthy') {
      assert.equal(facts.top,0,'banner is at the top of the viewport');
      assert.equal(facts.green.length,0,'no green system-monitor indicators');
      assert.equal(await evaluate(`document.querySelectorAll('[style*="34, 197, 94"], [style*="22c55e"]').length`),0,'no green quota indicators');
      assert.ok(facts.links.length>0,'detail link');
      assert.match(facts.banner, new RegExp({wedged:'wedged executor',usage:'codex usage limit',silent:'Silent failure',day:'0 dispatched',unreachable:'Status unknown'}[name]));
    } else assert.equal(facts.banner,null);
    console.log(`PASS ${name}: ${JSON.stringify(facts)}`);
  }
  console.log('PASS: 6 browser scenarios through the real Nexus dispatch-state relay');
} finally {
  ws?.close(); router?.closeUpstream();
  for(const p of children.reverse()){p.kill();await Promise.race([new Promise(r=>p.once('exit',r)),sleep(2000)]);if(p.exitCode===null)p.kill('SIGKILL');}
  for(const s of servers.reverse()){s.closeAllConnections();await new Promise(r=>s.close(r));}
  rmSync(temp,{recursive:true,force:true});
}
