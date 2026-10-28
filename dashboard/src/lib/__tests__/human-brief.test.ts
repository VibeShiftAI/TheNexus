import test from 'node:test';
import assert from 'node:assert/strict';
import { briefFromMetadata } from '../human-brief';

test('an update needs a project and situation but invents no problem or request', () => {
  const brief = briefFromMetadata({ brief: { kind: 'update', project: 'Praxis', situation: 'The quality review could not run because memory was low.' } });
  assert.deepEqual(brief, { kind: 'update', project: 'Praxis', situation: 'The quality review could not run because memory was low.', problem: '', ask: '' });
  assert.equal(briefFromMetadata({ brief: { kind: 'update', project: 'Praxis', situation: '' } }), undefined);
  assert.equal(briefFromMetadata({ brief: { kind: 'update', project: '', situation: 'Done.' } }), undefined);
});

test('legacy decisions retain their required fields and unsupported kinds are rejected', () => {
  const brief = { project: 'Praxis', situation: 'Review paused.', problem: 'A decision is missing.', ask: 'Approve the scope?' };
  assert.deepEqual(briefFromMetadata({ brief }), brief);
  assert.equal(briefFromMetadata({ brief: { ...brief, ask: '' } }), undefined);
  assert.equal(briefFromMetadata({ brief: { ...brief, kind: 'other' } }), undefined);
  assert.equal(briefFromMetadata({ brief: { ...brief, kind: 'update', problem: 42 } }), undefined);
});
