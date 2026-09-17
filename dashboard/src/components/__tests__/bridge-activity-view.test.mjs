import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {BridgeActivityProvider} from '../bridge/activity-provider.tsx';
import {ActivityMonitor} from '../bridge/activity-monitor.tsx';

test('real provider data drives circuits and keyboard-accessible drilldowns through to the full vault document',async()=>{
 const original=globalThis.fetch;
 const at=new Date().toISOString();
 const knowledge={at,sources:{memory:true,vault:true},calls:[{id:1,at,caller:'codex',tool:'memory_search',success:true}],files:[{path:'memories/report.md',at,bytes:50}]};
 globalThis.fetch=async url=>({ok:true,json:async()=>String(url).includes('knowledge-activity')?knowledge:{executors:{runs:[{taskId:'qa--t',title:'Review',executor:'codex',kind:'qa',phase:'testing',status:'active',startedAt:at,updatedAt:at}]}}});
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 try{
  await act(async()=>root.render(createElement(BridgeActivityProvider,null,createElement(ActivityMonitor))));
  await act(async()=>document.dispatchEvent(new window.Event('visibilitychange')));
  const vault=container.querySelector('[aria-label="Inspect Vault writes activity"]');
  assert.match(vault.className,/is-active/);assert.match(container.querySelector('[aria-label="Inspect QA review activity"]').textContent,/1 active/);
  vault.focus();await act(async()=>vault.click());
  let dialog=document.querySelector('[role="dialog"]');assert.ok(dialog);assert.equal(document.activeElement.getAttribute('aria-label'),'Close');
  const report=[...dialog.querySelectorAll('button')].find(b=>b.textContent.includes('report.md'));
  await act(async()=>report.click());
  dialog=document.querySelector('[role="dialog"]');
  const link=dialog.querySelector('a[href="/activity?document=memories%2Freport.md"]');assert.ok(link);assert.match(link.textContent,/Open full vault document/);
  link.focus();act(()=>link.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})));
  assert.equal(document.activeElement.getAttribute('aria-label'),'Close');
  act(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  assert.equal(document.querySelector('[role="dialog"]'),null);assert.equal(document.activeElement,vault);
 }finally{act(()=>root.unmount());container.remove();globalThis.fetch=original;}
});
