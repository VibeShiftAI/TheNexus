import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { CurrentFocusPanel } from '../bridge/current-focus.tsx';
import { deriveCurrentFocus } from '../../lib/current-focus.ts';

const view=deriveCurrentFocus({projects:[{id:'p',name:'Meeple Magnate',tasks:[{id:'t',name:'Improve card contrast',status:'in_progress',description:'Make the card text easier to read.'}]}],state:{executors:{runs:[{taskId:'t',title:'Improve card contrast',executor:'codex',phase:'testing',status:'active',startedAt:'2026-09-07T12:00:00Z',updatedAt:'2026-09-07T12:05:00Z'}]}},now:Date.parse('2026-09-07T12:06:00Z')});
function setup(props={}) {
  const opener=document.createElement('button'); opener.textContent='Current Focus'; document.body.append(opener); opener.focus();
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  let closed=0,refreshed=0;
  const render=(extra={})=>act(()=>root.render(createElement(CurrentFocusPanel,{view,loading:false,errors:[],updatedAt:'2026-09-07T12:06:00Z',connected:true,refresh:async()=>{refreshed++},onClose:()=>{closed++},...props,...extra})));
  render();
  return {opener,render,get closed(){return closed},get refreshed(){return refreshed},cleanup(){act(()=>root.unmount());container.remove();opener.remove()}};
}
test('full panel shows project, task purpose, stage and links with unknown model explicit',()=>{
  const t=setup();try{
    const panel=document.querySelector('[role="dialog"][aria-label="Current Focus"]');
    assert.match(panel.textContent,/Meeple Magnate/);assert.match(panel.textContent,/Make the card text easier/);assert.match(panel.textContent,/Testing/);assert.match(panel.textContent,/Model not reported/);
    assert.ok(panel.querySelector('a[href="/task/t"]'));assert.ok(panel.querySelector('a[href="/project/p"]'));
    assert.equal(document.activeElement.getAttribute('aria-label'),'Close');
    act(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));assert.equal(t.closed,1);
  }finally{t.cleanup()}
});
test('errors never look like an idle success, and refresh is available',async()=>{
  const t=setup({view:deriveCurrentFocus({projects:[],state:null}),errors:['Activity could not refresh.']});try{
    assert.ok(document.querySelector('[role="alert"]'));
    assert.doesNotMatch(document.querySelector('[role="dialog"]').textContent,/Nothing is running or waiting/);
    await act(async()=>[...document.querySelectorAll('button')].find(x=>x.textContent==='Refresh').click());assert.equal(t.refreshed,1);
  }finally{t.cleanup()}
});
test('input wait opens existing approval and keyboard focus stays in the panel',()=>{
  const waitView=deriveCurrentFocus({projects:[],state:{},requests:[{id:'ask',taskId:'t',question:'Which style?',requestedAt:'2026-09-07T12:00:00Z'}]});
  const t=setup({view:waitView});try{
    const panel=document.querySelector('[role="dialog"]');
    assert.ok(panel.querySelector('a[href="/inbox#ask"]'));assert.match(panel.textContent,/Which style\?/);
    const buttons=panel.querySelectorAll('button,a[href]');buttons[buttons.length-1].focus();
    act(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})));
    assert.equal(document.activeElement,buttons[0]);
  }finally{t.cleanup()}
});
