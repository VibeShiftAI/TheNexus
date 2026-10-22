import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dashboard = fileURLToPath(new URL('../../../', import.meta.url));

for (const legacy of [true, false]) {
  test(`standalone Cast document renders with ${legacy ? 'Chromium 92 runtime APIs' : 'native Object.hasOwn'}`, () => {
    // A child process isolates the built-in API change and the real entry's root/timers.
    const script = String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM, VirtualConsole } from 'jsdom';
      import { buildSync } from 'esbuild';
      const errors = [];
      const virtualConsole = new VirtualConsole();
      virtualConsole.on('jsdomError', error => errors.push(error.cause?.stack || error.message));
      const dom = new JSDOM('<!doctype html><html data-nexus-receiver="cast"><body><div id="presentation"></div></body></html>', {
        url: 'http://receiver.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
      });
      const { window } = dom;
      const { document } = window;
      window.addEventListener('error', event => errors.push(event.error?.stack || event.message));
      const bundle = buildSync({ entryPoints: ['src/presentation/entry.tsx'], bundle: true, write: false,
        format: 'iife', platform: 'browser', target: ['es2020'], jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' }).outputFiles[0].text;
      let stopped = 0;
      window.cast = { framework: {
        messages: { MessageType: { LOAD: 'LOAD', QUEUE_LOAD: 'QUEUE_LOAD' } },
        system: { EventType: { SENDER_DISCONNECTED: 'left' } },
        CastReceiverContext: { getInstance: () => ({
          start() {}, stop() { stopped++; }, getSenders: () => [{}],
          addEventListener() {}, removeEventListener() {},
          getPlayerManager: () => ({ setMessageInterceptor() {} }),
        }) },
      } };
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      window.fetch = async (url, init) => {
        assert.equal(init.credentials, 'omit');
        if (url === '/receiver/pairings') return Response.json({ code: '03', pollToken: 'poll-only', expiresAt });
        if (url === '/receiver/pairings/03') {
          assert.equal(init.headers.Authorization, 'Bearer poll-only');
          return Response.json({ state: 'paired', token: 'selected-view-only' });
        }
        assert.equal(url, '/receiver/view');
        assert.equal(init.headers.Authorization, 'Bearer selected-view-only');
        return Response.json({ version: 1, sampledAt: new Date().toISOString(),
          session: { id: 'selected-session', state: 'active', expiresAt },
          content: { kind: 'document', documentId: 'exact-document', revisionId: 'pinned-revision',
            contentHash: 'a'.repeat(64), title: 'Selected document', mediaType: 'markdown', mimeType: 'text/markdown',
            content: '# Receiver document\n\n[Private link](/api/private) ![Private image](/api/private)',
            assetUrl: null, newerRevisionAvailable: true },
        });
      };
      const original = window.Object.hasOwn;
      if (${legacy}) delete window.Object.hasOwn;
      try {
        window.eval(bundle);
        const root = document.getElementById('presentation');
        for (let tries = 0; tries < 100 && !errors.length && !root.textContent.includes('pinned-revision'); tries++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.deepEqual(errors, [], 'receiver render errors');
        for (const text of ['Selected document', 'exact-document', 'pinned-revision', 'Read-only presentation', 'newer revision']) {
          assert.ok(root.textContent.includes(text), text);
        }
        assert.equal(root.querySelector('a, img, button, textarea'), null);
        assert.equal(stopped, 0, 'rendering must not tear down the Cast session');
        if (!${legacy}) assert.equal(window.Object.hasOwn, original, 'preserve the native implementation');
        assert.equal(Object.getOwnPropertyDescriptor(window.Object, 'hasOwn').enumerable, false);
        const symbol = Symbol('own');
        const value = Object.assign(Object.create({ inherited: true }), { own: true, [symbol]: true, hasOwnProperty: false });
        assert.equal(window.Object.hasOwn(value, 'own'), true);
        assert.equal(window.Object.hasOwn(value, 'inherited'), false);
        assert.equal(window.Object.hasOwn(value, symbol), true);
        assert.equal(window.Object.hasOwn('text', 'length'), true);
        assert.equal(window.Object.hasOwn(Object.create(null), 'missing'), false);
        assert.throws(() => window.Object.hasOwn(null, 'x'), window.TypeError);
        assert.throws(() => window.Object.hasOwn(undefined, 'x'), window.TypeError);
        let coercedKey = false;
        const key = { [Symbol.toPrimitive]() { coercedKey = true; return 'x'; } };
        assert.throws(() => window.Object.hasOwn(null, key), window.TypeError);
        assert.equal(coercedKey, false, 'reject null before coercing a property key');
        console.log('Pinned read-only Markdown rendered; Cast stayed connected; property semantics passed.');
        dom.window.close(); process.exit(0);
      } catch (error) { console.error(error.stack); process.exit(1); }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      cwd: dashboard, input: script, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Pinned read-only Markdown rendered/);
  });
}
