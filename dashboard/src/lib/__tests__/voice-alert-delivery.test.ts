import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceAlertSubject, voiceAlertFailureReason, voiceAlertFailureText } from '../voice-alert-delivery';

test('a failure identifies the work from the brief when no readable task title is available', () => {
  const brief = { kind: 'update', project: 'Praxis', situation: 'Memory pressure stopped the quality review.', problem: '', ask: '' };
  assert.equal(voiceAlertSubject({ title: '11223344-1122-1122-1122-112233445566', brief }), brief.situation);
});

test('failure diagnostics retain bounded codes and never service secrets or arbitrary error text', () => {
  const diagnostic = voiceAlertFailureReason(new Error('HTTP 503 secret=private-value /private/path'));
  assert.deepEqual(diagnostic, { code: 'http-error', httpStatus: 503 });
  const text = voiceAlertFailureText({ ...diagnostic, stage: 'playback', subject: 'Quality review', textSaved: true });
  assert.match(text, /service was unavailable/); assert.match(text, /text is saved in Recent Activity/);
  assert.doesNotMatch(text, /HTTP 503/);
  assert.doesNotMatch(text, /private/);
  assert.deepEqual(voiceAlertFailureReason(new Error('secret=private-value')), { code: 'unknown' });
});
