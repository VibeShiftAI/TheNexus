import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingRequestTickerText } from '../../lib/ticker-text.ts';

const base = { id: 'q1', reason: 'explicit_request', requestedAt: '2026-10-21T21:18:44.829Z' };

test('an update uses its situation when there is no ask', () => {
  const text = pendingRequestTickerText({ ...base, question: 'Raw record.', metadata: { brief: { kind: 'update', project: 'Praxis', situation: 'The quality review finished.', problem: '', ask: '' } } });
  assert.equal(text, 'Praxis: The quality review finished.');
});

test('the bridge strip names the project and the ask when the card has a brief', () => {
  const text = pendingRequestTickerText({ ...base, question: '**Project:** TheCortex\n\n1. Option (c)?', metadata: { kind: 'ask-robert',
    brief: { project: 'TheCortex', situation: 'The evaluation ran.', problem: 'A choice was recorded as yours.', ask: 'Answer the two questions below.' } } });
  assert.equal(text, 'TheCortex: Answer the two questions below.');
});

test('without a brief it names the project and the task, never the generic type-your-answer line', () => {
  const text = pendingRequestTickerText({ ...base, taskId: 't1', question: 'Which port should the service use?', metadata: { kind: 'task-question', taskTitle: 'Wire the display receiver', projectName: 'TheNexus' } });
  assert.equal(text, 'TheNexus: Wire the display receiver');
  const bare = pendingRequestTickerText({ ...base, question: 'Approve the schedule?\n\nSlots: three.' });
  assert.equal(bare, 'Approve the schedule?');
  assert.doesNotMatch(`${text} ${bare}`, /Your input is needed|Type your answer/);
});

test('a red alert keeps its acknowledgment guidance on the strip', () => {
  const text = pendingRequestTickerText({ ...base, question: 'Service down.', options: ['acknowledged'], metadata: { kind: 'red-alert' } });
  assert.match(text, /does not repair/);
});
