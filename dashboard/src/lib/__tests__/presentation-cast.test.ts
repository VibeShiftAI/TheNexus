import test from 'node:test';
import assert from 'node:assert/strict';
import { startCastReceiver } from '../presentation-cast';

test('Cast receiver starts only the read-only app, rejects media LOAD and ends when sender leaves', () => {
  const listeners: Record<string, () => void> = {}, interceptors: Record<string, () => unknown> = {};
  let options: unknown, stopped = 0, ended = 0;
  const context = {
    start: (value: unknown) => { options = value; }, stop: () => { stopped++; }, getSenders: () => [],
    addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; },
    removeEventListener: (type: string) => { delete listeners[type]; },
    getPlayerManager: () => ({ setMessageInterceptor: (type: string, fn: () => unknown) => { interceptors[type] = fn; } }),
  };
  const framework = { CastReceiverContext: { getInstance: () => context }, system: { EventType: { SENDER_DISCONNECTED: 'left' } }, messages: { MessageType: { LOAD: 'load', QUEUE_LOAD: 'queue' } } };
  const cleanup = startCastReceiver(framework, () => { ended++; });
  assert.deepEqual(options, { disableIdleTimeout: true, skipPlayersLoad: true, maxInactivity: 15, statusText: 'Nexus read-only presentation' });
  assert.equal(interceptors.load(), null); assert.equal(interceptors.queue(), null);
  listeners.left(); assert.equal(ended, 1); assert.equal(stopped, 1);
  cleanup(); assert.equal(Object.keys(listeners).length, 0);
});

test('a missing Cast SDK is an explicit failure, not a browser pretending to be Cast', () => {
  assert.throws(() => startCastReceiver(undefined, () => {}), /Cast receiver SDK/);
});
