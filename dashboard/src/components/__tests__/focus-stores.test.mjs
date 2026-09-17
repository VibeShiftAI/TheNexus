import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {useBoardState} from '../../hooks/use-board-state.ts';
import {useDispatchState} from '../../hooks/use-dispatch-state.ts';

test('shared snapshots coalesce reads, retain last good data with explicit errors, and recover', async()=>{
  const original=globalThis.fetch;let fail=false;const calls=[];const snapshots=[];
  globalThis.fetch=async url=>{calls.push(String(url));return {ok:!fail,status:fail?503:200,json:async()=>String(url).includes('board-state')?[{id:'p',name:'Project',tasks:[]}]:{executors:{runs:[],cliQueue:[],sessions:[]}}}};
  function Probe({index}) {const board=useBoardState();const dispatch=useDispatchState();snapshots[index]={board,dispatch};return null}
  const div=document.createElement('div'), root=createRoot(div);
  try{
    await act(async()=>{root.render(createElement('div',null,createElement(Probe,{index:0}),createElement(Probe,{index:1})));});
    assert.equal(calls.filter(x=>x.includes('board-state')).length,1);
    assert.equal(calls.filter(x=>x.includes('dispatch-state')).length,1);
    assert.equal(snapshots[0].board.projects[0].name,'Project');assert.ok(snapshots[0].dispatch.updatedAt);
    fail=true;
    await act(async()=>{await Promise.all([snapshots[0].board.refresh(),snapshots[1].board.refresh(),snapshots[0].dispatch.refresh(),snapshots[1].dispatch.refresh()]);});
    assert.equal(calls.length,4);assert.equal(snapshots[0].board.error,true);assert.equal(snapshots[1].dispatch.error,true);assert.equal(snapshots[0].board.projects[0].id,'p');
    fail=false;
    await act(async()=>{await Promise.all([snapshots[0].board.refresh(),snapshots[0].dispatch.refresh()]);});
    assert.equal(snapshots[0].board.error,false);assert.equal(snapshots[1].dispatch.error,false);
  }finally{act(()=>root.unmount());globalThis.fetch=original;div.remove();}
});
