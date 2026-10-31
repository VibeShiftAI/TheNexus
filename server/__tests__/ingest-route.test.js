const express = require('express');
const http = require('http');

// The Cortex copy of an ingested text used to be cut to its first 15,000
// characters, and source-fetch cut every fetched page to 50,000 before it was
// stored as the note.
describe('ingest route', () => {
  const realFetch = global.fetch;
  let handle; let db; let cortexBodies;

  function listen(app) {
    const server = http.createServer(app);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` })));
  }

  async function start(fetched) {
    jest.resetModules();
    if (fetched) jest.doMock('../services/source-fetch', () => ({ fetchSourceContent: jest.fn(async () => fetched) }));
    cortexBodies = [];
    global.fetch = jest.fn(async (url, init) => {
      if (String(url).includes('/api/memory/ingest')) {
        cortexBodies.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ factoids_ingested: 3 }) };
      }
      return realFetch(url, init);
    });
    db = { createNote: jest.fn(async (note) => ({ id: 'n1', ...note })), markNoteIngested: jest.fn(async () => {}) };
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/ingest', require('../routes/ingest')({ db }));
    handle = await listen(app);
  }

  afterEach(async () => {
    global.fetch = realFetch;
    jest.dontMock('../services/source-fetch');
    if (handle) await new Promise((r) => handle.server.close(r));
    handle = null;
  });

  async function ingest(body) {
    const res = await realFetch(`${handle.baseUrl}/api/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  async function cortexCalled() {
    for (let i = 0; i < 50 && !cortexBodies.length; i += 1) await new Promise((r) => setTimeout(r, 10));
  }

  test('pasted text reaches the note and Cortex whole', async () => {
    await start();
    const text = `Opening line. ${'A long pasted paragraph. '.repeat(2000)}FINAL LINE`;
    const result = await ingest({ text, title: 'Pasted' });
    expect(result.status).toBe(200);
    expect(result.body.contentLength).toBe(text.length);
    expect(db.createNote.mock.calls[0][0].content).toContain(text);
    await cortexCalled();
    expect(cortexBodies[0].text).toBe(`Pasted\n\n${text}`);
    expect(cortexBodies[0].text).not.toMatch(/truncated/i);
  });

  test('a fetched page past the old 50,000 is stored and sent whole', async () => {
    const content = `Page start. ${'Fetched article text. '.repeat(4000)}PAGE END`;
    await start({ content, title: 'Long page', contentType: 'article', url: 'https://example.com/long' });
    const result = await ingest({ url: 'https://example.com/long' });
    expect(result.status).toBe(200);
    expect(content.length).toBeGreaterThan(50000);
    expect(db.createNote.mock.calls[0][0].content).toContain(content);
    await cortexCalled();
    expect(cortexBodies[0].text).toBe(`Long page\n\n${content}`);
  });
});
