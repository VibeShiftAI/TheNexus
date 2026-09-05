import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('dispatch station delegates task invalidation to the shared board hook', () => {
  const source = fs.readFileSync('src/components/bridge/dispatch-station.tsx', 'utf8');
  assert.match(source, /useBoardState\(\)/);
  assert.doesNotMatch(source, /useStreamRefetch/, 'an independent 800ms subscription fetches again after the shared 400ms refresh');
});
