const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const scripts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
function context(origin, isTopFrame) {
  const events = [];
  const window = { location: { origin }, dispatchEvent: event => events.push(event) };
  window.self = window;
  window.top = isTopFrame ? window : {};
  return { window, location: window.location, events, CustomEvent: class {
    constructor(type, init) { this.type = type; this.detail = init.detail; }
  } };
}

for (const [origin, isTopFrame, admitted] of [
  ['https://nexus.vibeshiftai.com', true, true],
  ['https://nexus.vibeshiftai.com', false, false],
  ['https://nexus.vibeshiftai.com.evil.test', true, false],
  ['http://nexus.vibeshiftai.com', true, false],
  ['https://nexus.vibeshiftai.com:444', true, false],
  ['https://gayguyde.vibeshiftai.com', true, false],
  ['null', true, false],
]) {
  const test = context(origin, isTopFrame);
  vm.runInNewContext(scripts.initialization, test);
  vm.runInNewContext(scripts.result, test);
  assert.equal(Boolean(test.window.__NEXUS_DISPLAYS__), admitted);
  assert.equal(test.events.length, admitted ? 1 : 0);
  if (admitted) {
    assert.equal(test.window.__NEXUS_DISPLAYS__.version, 1);
    assert.equal(test.window.__NEXUS_DISPLAYS__.platform, 'windows');
    assert.ok(Object.isFrozen(test.window.__NEXUS_DISPLAYS__));
    assert.equal(test.events[0].type, 'nexus:display-result');
    assert.equal(test.events[0].detail.requestId, 'r-1');
    assert.equal(test.events[0].detail.state, 'expired');
    // Native replies may race a document navigation: the JS check still denies.
    test.location.origin = 'https://evil.test';
    vm.runInNewContext(scripts.result, test);
    assert.equal(test.events.length, 1);
  }
}
console.log('Passed 7 bridge origin/frame cases, immutable native flag, correlated result, and navigation race.');

// Tauri capability windows/webviews scopes are ORed, not intersected.
// `main` includes its chrome and loader children; an output window has a
// different parent and must never receive a wildcard webview capability.
const capability = JSON.parse(fs.readFileSync(path.join(__dirname, '../src-tauri/capabilities/default.json'), 'utf8'));
assert.deepEqual(capability.windows, ['main']);
assert.equal(capability.webviews, undefined);
assert.equal(capability.remote, undefined);
assert.ok(capability.permissions.includes('core:default'));
console.log('Main-window chrome/loaders retain core capability; presentation is outside its window scope and no remote scope exists.');
