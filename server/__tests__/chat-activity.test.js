const { createChatActivity } = require('../services/chat-activity');

test('tracks receipt, work and reply by exact request, retaining independent concurrent conversations', () => {
  let now=1000;const emitted=[];
  const activity=createChatActivity({now:()=>now,io:{emit:(event,data)=>emitted.push({event,data})}});
  activity.begin({id:'a',conversationId:'one',preview:'Hello'});
  activity.begin({id:'b',conversationId:'two',preview:'Another'});
  now+=100;activity.update('a','working');activity.update('a','replying');
  activity.update('a','completed');activity.update('a','working');
  const snapshot=activity.snapshot();
  expect(snapshot.turns.find(t=>t.id==='a').phase).toBe('completed');
  expect(snapshot.turns.find(t=>t.id==='b').phase).toBe('received');
  expect(snapshot.turns.find(t=>t.id==='a').receivedAt).toBe(new Date(1000).toISOString());
  expect(emitted.every(e=>e.event==='chat-activity')).toBe(true);
  expect(activity.snapshot().at).toBe(new Date(now).toISOString());
});

test('failed turns do not turn into successful or busy records, and a restarted tracker invents no work', () => {
  const activity=createChatActivity();
  activity.begin({id:'a',conversationId:'one'});activity.update('a','failed','Upstream disconnected');
  activity.update('a','completed');
  expect(activity.snapshot().turns[0]).toMatchObject({id:'a',phase:'failed',detail:'Upstream disconnected'});
  expect(createChatActivity().snapshot().turns).toEqual([]);
});
test('an explicit new attempt can recover a failed ID without accepting updates from the old attempt',()=>{
  const activity=createChatActivity();
  const first=activity.begin({id:'a',conversationId:'one'});activity.update('a','failed','Disconnected',first);
  const second=activity.begin({id:'a',conversationId:'one'});activity.update('a','failed','Late old failure',first);
  expect(activity.snapshot().turns[0].phase).toBe('received');
  activity.update('a','completed',undefined,second);
  expect(activity.snapshot().turns[0].phase).toBe('completed');
});
