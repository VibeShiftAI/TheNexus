import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresentationOperationQueue } from '../presentation-operations';

test('reconciliation waits for native activation and an old stop cannot close a later start', async () => {
  const enqueue = createPresentationOperationQueue();
  const events: string[] = [];
  let activate!: () => void;
  const activation = new Promise<void>(resolve => { activate = resolve; });
  const start = enqueue(async () => { events.push('server-created'); await activation; events.push('native-active'); });
  const heartbeat = enqueue(async () => { events.push('heartbeat-active'); throw new Error('expired'); }).catch(() => {});
  const replacement = enqueue(async () => { events.push('replacement-active'); });
  await Promise.resolve();
  assert.deepEqual(events, ['server-created']);
  activate(); await Promise.all([start, heartbeat, replacement]);
  assert.deepEqual(events, ['server-created', 'native-active', 'heartbeat-active', 'replacement-active']);
});
