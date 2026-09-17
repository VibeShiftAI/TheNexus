import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveChatActivity } from '../chat-activity.ts';
const now=Date.parse('2026-09-08T13:00:00Z');
const turn={id:'a',conversationId:'one',preview:'Hello',phase:'received' as const,receivedAt:new Date(now-2000).toISOString(),updatedAt:new Date(now-1000).toISOString()};
const snapshot={at:new Date(now).toISOString(),turns:[turn]};

test('only the selected conversation and chat-correlated states drive the center',()=>{
 assert.equal(deriveChatActivity({snapshot,local:null,conversationId:'one',now}).phase,'received');
 assert.equal(deriveChatActivity({snapshot,local:null,conversationId:'two',now}).phase,'idle');
 assert.equal(deriveChatActivity({snapshot:{...snapshot,turns:[]},local:null,conversationId:'one',now}).active,false);
});
test('immediate sending never claims receipt; stale server work stops animating',()=>{
 const local={...turn,phase:'sending' as const,updatedAt:new Date(now).toISOString()};
 assert.equal(deriveChatActivity({snapshot:null,local,conversationId:'one',now}).phase,'sending');
 assert.equal(deriveChatActivity({snapshot,local,conversationId:'one',now}).phase,'received','authoritative receipt wins over local sending');
 const stale=deriveChatActivity({snapshot,local:null,conversationId:'one',now:now+30_000});
 assert.equal(stale.phase,'delayed');assert.equal(stale.active,false);
});
test('a local failure before acceptance never invents a message receipt',()=>{
 const local={...turn,phase:'failed' as const};
 assert.equal(deriveChatActivity({snapshot:null,local,conversationId:'one',now}).acceptedAt,undefined);
 assert.equal(deriveChatActivity({snapshot,local,conversationId:'one',now}).acceptedAt,turn.receivedAt);
});
test('fresh receipts between dashboard clock ticks stay visible without a Signal lost flash',()=>{
 const fresh={...snapshot,at:new Date(now+900).toISOString()};
 assert.equal(deriveChatActivity({snapshot:fresh,local:null,conversationId:'one',now}).phase,'received');
});
test('an older response cannot hide a newer pending message, while a final reply ends work',()=>{
 const older={...turn,id:'b',phase:'completed' as const,receivedAt:new Date(now-5000).toISOString(),updatedAt:new Date(now).toISOString()};
 assert.equal(deriveChatActivity({snapshot:{...snapshot,turns:[older,turn]},local:null,conversationId:'one',now}).phase,'received');
 assert.equal(deriveChatActivity({snapshot:{...snapshot,turns:[{...turn,phase:'completed'}]},local:null,conversationId:'one',now}).phase,'completed');
});
