import test from 'node:test';
import assert from 'node:assert/strict';
import { topicAccessStrength, visibleTopicAccesses } from '../topic-activity.ts';
import { deriveBridgeActivity } from '../bridge-activity.ts';

const now = Date.parse('2026-09-08T12:00:00Z');
const access = { topicId: 12, title: 'Memory', at: new Date(now-1000).toISOString(), communityUpdatedAt: '2026-09-06T00:00:00Z', mapIdentity: JSON.stringify(['Memory',20,['Neo4j']]), entityCount: 2, entities: ['Neo4j', 'Vectors'] };
const map = { nodes: [{id:12,title:'Memory',size:20,top_entities:['Neo4j']}], links:[], computed_at: '2026-09-08T11:00:00Z' };

test('only fresh, attributed accesses for the displayed community generation illuminate topics', () => {
  const records = [access, {...access,topicId:13}, {...access,communityUpdatedAt:'2026-09-08T11:59:00Z'}];
  assert.deepEqual(visibleTopicAccesses(records,map,now), [access]);
  assert.deepEqual(visibleTopicAccesses([{...access,at:new Date(now+1000).toISOString()}],map,now), []);
  assert.deepEqual(visibleTopicAccesses([access],map,now+20_000), []);
  assert.ok(topicAccessStrength(access.at,now)>topicAccessStrength(access.at,now+3000));
  assert.equal(topicAccessStrength(access.at,now+20_000),0);
});

test('reused community IDs fail closed in either direction across a map rebuild', () => {
  const rebuilt = {...map,computed_at:'2026-09-08T11:59:30Z',nodes:[{...map.nodes[0],title:'Completely different topic',top_entities:['Biology']}]};
  assert.deepEqual(visibleTopicAccesses([access],rebuilt,now),[],'old access cannot illuminate a newer map reusing the ID');
  const newAccess = {...access,mapIdentity:JSON.stringify(['Completely different topic',20,['Biology']]),communityUpdatedAt:'2026-09-08T10:59:00Z'};
  assert.deepEqual(visibleTopicAccesses([newAccess],map,now),[],'rebuild start timestamp cannot authorize access against an older cached map');
  assert.deepEqual(visibleTopicAccesses([{...access,mapIdentity:undefined}],map,now),[],'missing identity never falls back to the numeric ID');
});

test('topic telemetry remains independent of generic MCP calls, and expires on source failure', () => {
  const base = { now, connected:false, events:[], runs:[], runsAvailable:false, knowledge:{at:new Date(now).toISOString(),sources:{memory:false,vault:false,topics:true},calls:[],files:[],topicAccesses:[access]} };
  const live = deriveBridgeActivity(base);
  assert.deepEqual(live.topicAccesses,[access]);
  assert.equal(live.channels.find(c=>c.id==='memory')?.hot,true);
  assert.ok(live.items.some(i=>i.topicId===12 && i.href?.includes('term=Neo4j')));
  assert.deepEqual(deriveBridgeActivity({...base,now:now+21_000}).topicAccesses,[]);
  assert.deepEqual(deriveBridgeActivity({...base,knowledge:{...base.knowledge,sources:{...base.knowledge.sources,topics:false}}}).topicAccesses,[]);
  assert.deepEqual(deriveBridgeActivity({...base,knowledge:{...base.knowledge,topicAccesses:[],calls:[{id:1,at:access.at,tool:'vault_write',caller:'codex',success:true}]}}).topicAccesses,[]);
});
