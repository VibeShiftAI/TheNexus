import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {mountTerminal,findComposerInput,typeCharacter,act} from './helpers.mjs';
import {useChatActivity} from '../src/hooks/use-chat-activity.ts';
import {peekLiveSocket} from '../src/lib/live-socket.ts';

function probe() {
  let latest;let commits=0;
  function Probe(){latest=useChatActivity('test-conversation',Date.now());commits++;return null;}
  const container=document.createElement('div');document.body.append(container);
  const root=createRoot(container);act(()=>root.render(createElement(Probe)));
  return {get latest(){return latest;},get commits(){return commits;},unmount(){act(()=>root.unmount());container.remove();}};
}
async function settle(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});}

test('real composer send drives sending, confirmed receipt, working, streaming, and final completion',async()=>{
  const original=globalThis.fetch;let releaseHeaders,requestBody,controller;
  const stream=new ReadableStream({start(c){controller=c;}});
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/activity')) return {ok:true,json:async()=>({at:new Date().toISOString(),turns:[]})};
    requestBody=JSON.parse(init.body);return new Promise(resolve=>{releaseHeaders=resolve;});
  };
  const terminal=mountTerminal([]);const status=probe();
  const frame=event=>controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  try {
    await settle();
    for(const character of 'Are you working?')typeCharacter(findComposerInput(terminal.container),character);
    await act(async()=>terminal.container.querySelector('[aria-label="Send message"]').click());
    assert.equal(status.latest.phase,'sending');assert.equal(status.latest.acceptedAt,undefined);
    const at=new Date().toISOString();
    await act(async()=>peekLiveSocket().__emit('chat-activity',{at,turns:[{id:requestBody.clientMessageId,conversationId:'test-conversation',phase:'received',receivedAt:at,updatedAt:at}]}));
    assert.equal(status.latest.phase,'received');assert.equal(status.latest.acceptedAt,at);
    await act(async()=>releaseHeaders(new Response(stream,{headers:{'Content-Type':'text/event-stream'}})));
    assert.equal(status.latest.phase,'working');
    await act(async()=>frame({type:'delta',delta:'Yes'}));
    assert.equal(status.latest.phase,'replying');const commits=status.commits;
    await act(async()=>frame({type:'delta',delta:'.'}));
    assert.equal(status.commits,commits,'more tokens do not re-render the chat indicator');
    await act(async()=>{frame({type:'final',response:'Yes.',assistantMessageId:'reply'});controller.close();});
    assert.equal(status.latest.phase,'completed');assert.equal(status.latest.active,false);
  } finally {terminal.unmount();status.unmount();globalThis.fetch=original;}
});

test('an interrupted response never leaves the center working or claims completion',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async url=>String(url).endsWith('/activity')?{ok:true,json:async()=>({at:new Date().toISOString(),turns:[]})}:new Response('data: {"type":"delta","delta":"Partial"}\n\n',{headers:{'Content-Type':'text/event-stream'}});
  const terminal=mountTerminal([]);const status=probe();
  try {
    await settle();typeCharacter(findComposerInput(terminal.container),'x');
    await act(async()=>terminal.container.querySelector('[aria-label="Send message"]').click());await settle();
    assert.equal(status.latest.phase,'failed');assert.equal(status.latest.active,false);
    assert.match(status.latest.detail,/before completion/);
  } finally {terminal.unmount();status.unmount();globalThis.fetch=original;}
});
