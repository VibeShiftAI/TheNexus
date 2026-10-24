/**
 * Photo attachments on inbox answers (task 0df94949, 2026-10-24).
 *
 * The browser uploads a photo through the existing chat upload API and names
 * it on the resolve body as payload.attachments[].fileId. These tests pin the
 * Nexus-side trust boundary: references are rebuilt from the upload store,
 * anything that is not an uploaded image is refused with a 400 before Praxis
 * is called, and text-only answers are forwarded byte for byte.
 */
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_HEADER = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 1)]);

function listen(app) {
  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(handle) {
  for (const socket of handle.sockets) socket.destroy();
  return new Promise((resolve) => handle.server.close(resolve));
}

function storeFile(dir, ext, bytes) {
  const fileId = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, `${fileId}${ext}`), bytes);
  return fileId;
}

describe('inbox answer attachments', () => {
  let dir;
  const { normalizeAnswerAttachments, hitlAnswerAttachmentGuard, DEFAULT_LIMITS } = require('../services/hitl-answer-attachments');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hitl-attachments-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds a reference from the stored image and ignores client-supplied url, mime and size', () => {
    const fileId = storeFile(dir, '.png', ONE_PIXEL_PNG);
    const result = normalizeAnswerAttachments(
      [{ fileId, url: 'javascript:alert(1)', mimeType: 'text/html', size: 1, originalName: 'Screenshot 2026-10-24.png' }],
      { dir },
    );
    expect(result).toEqual({
      ok: true,
      attachments: [{
        fileId,
        url: `/api/chat/files/${fileId}`,
        mimeType: 'image/png',
        originalName: 'Screenshot 2026-10-24.png',
        size: ONE_PIXEL_PNG.length,
      }],
    });
  });

  it('accepts the phone image formats by extension and content', () => {
    const jpg = storeFile(dir, '.JPG', JPEG_HEADER);
    const heic = storeFile(dir, '.heic', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(16)]));
    const result = normalizeAnswerAttachments([{ fileId: jpg }, { fileId: heic }], { dir });
    expect(result.ok).toBe(true);
    expect(result.attachments.map((a) => a.mimeType)).toEqual(['image/jpeg', 'image/heic']);
    expect(result.attachments.map((a) => a.originalName)).toEqual([`${jpg}.JPG`, `${heic}.heic`]);
  });

  it('refuses anything that is not an uploaded image file', () => {
    const txt = storeFile(dir, '.txt', Buffer.from('not a photo'));
    const fakePng = storeFile(dir, '.png', Buffer.from('<html><script>alert(1)</script></html>'));
    const cases = [
      [[{ fileId: 'not-a-uuid' }], /uploaded through the Nexus upload API/],
      [[{ fileId: '../../etc/passwd' }], /uploaded through the Nexus upload API/],
      [[{ fileId: crypto.randomUUID() }], /not found in the Nexus upload store/],
      [[{ fileId: txt }], /Only photos and screenshots/],
      [[{ fileId: fakePng }], /not a readable image/],
      [[{ url: '/api/chat/files/x' }], /uploaded through the Nexus upload API/],
      ['/api/chat/files/x', /must be a list/],
      [[null], /uploaded through the Nexus upload API/],
    ];
    for (const [raw, detail] of cases) {
      const result = normalizeAnswerAttachments(raw, { dir });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(detail);
    }
  });

  it('bounds the count and the size and cleans the display name', () => {
    const ids = Array.from({ length: DEFAULT_LIMITS.maxCount + 1 }, () => storeFile(dir, '.png', ONE_PIXEL_PNG));
    const tooMany = normalizeAnswerAttachments(ids.map((fileId) => ({ fileId })), { dir });
    expect(tooMany).toEqual({ ok: false, detail: `Up to ${DEFAULT_LIMITS.maxCount} photos can be attached to one answer` });

    const tooBig = normalizeAnswerAttachments([{ fileId: ids[0] }], { dir, limits: { maxBytes: 10 } });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.detail).toMatch(/Photos up to 0 MB/);

    const cleaned = normalizeAnswerAttachments(
      [{ fileId: ids[0], originalName: '..\\evil/\u0007name\u0000.png' }, { fileId: ids[0].toUpperCase() }, { fileId: ids[1], originalName: 'x'.repeat(400) }],
      { dir },
    );
    expect(cleaned.ok).toBe(true);
    expect(cleaned.attachments).toHaveLength(2);
    expect(cleaned.attachments[0].originalName).toBe('..-evil-name.png');
    expect(cleaned.attachments[1].originalName).toHaveLength(DEFAULT_LIMITS.maxNameLength);
  });

  it('as middleware leaves text, choice and voice bodies untouched and rewrites only attachments', () => {
    const fileId = storeFile(dir, '.png', ONE_PIXEL_PNG);
    const guard = hitlAnswerAttachmentGuard({ dir });
    const run = (body) => new Promise((resolve) => {
      const req = { body };
      const res = { status(code) { this.code = code; return this; }, json(payload) { resolve({ status: this.code, body: payload, req }); } };
      guard(req, res, () => resolve({ status: 'next', req }));
    });
    return (async () => {
      for (const body of [{ freeText: 'yes' }, { choice: 'approve' }, { audioBase64: 'aGk=' }, {}, { payload: { scheduleOverrides: {} } }, undefined]) {
        const before = JSON.stringify(body);
        const outcome = await run(body);
        expect(outcome.status).toBe('next');
        expect(JSON.stringify(outcome.req.body)).toBe(before);
      }
      const emptied = await run({ freeText: 'yes', payload: { attachments: [] } });
      expect(emptied.status).toBe('next');
      expect(emptied.req.body).toEqual({ freeText: 'yes' });
      const refused = await run({ freeText: 'yes', payload: { attachments: [{ fileId: crypto.randomUUID() }] } });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_attachment');
      const accepted = await run({ freeText: 'yes', payload: { answers: { q1: 'yes' }, attachments: [{ fileId, mimeType: 'text/html' }] } });
      expect(accepted.status).toBe('next');
      expect(accepted.req.body.payload.answers).toEqual({ q1: 'yes' });
      expect(accepted.req.body.payload.attachments[0]).toMatchObject({ fileId, mimeType: 'image/png', url: `/api/chat/files/${fileId}` });
    })();
  });
});

describe('inbox answer attachments through the Nexus API', () => {
  let dir;
  let praxisHandle;
  let nexusHandle;
  let router;
  const forwarded = [];
  const previousDir = process.env.NEXUS_CHAT_FILES_DIR;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hitl-attachments-api-'));
    process.env.NEXUS_CHAT_FILES_DIR = dir;
    jest.resetModules();
    const praxis = express();
    praxis.use(express.json());
    praxis.post('/hitl/:id/resolve', (req, res) => {
      forwarded.push({ id: req.params.id, body: req.body });
      if (req.params.id === 'refused-by-praxis') return res.status(400).json({ error: 'invalid_answer', detail: 'Enter an answer before submitting' });
      return res.json({ status: 'resolved', request: { id: req.params.id, resolution: { ...req.body, resolvedAt: '2026-10-24T16:00:00.000Z', resolvedBy: 'robert' } } });
    });
    praxisHandle = await listen(praxis);
    process.env.PRAXIS_URL = praxisHandle.baseUrl;
    const nexus = express();
    nexus.use(express.json({ limit: '50mb' }));
    nexus.use('/api/chat/files', require('../routes/chat-files')());
    router = require('../routes/praxis-stream')();
    nexus.use('/api/praxis', router);
    nexusHandle = await listen(nexus);
  });

  afterAll(async () => {
    router?.closeUpstream();
    if (nexusHandle) await close(nexusHandle);
    if (praxisHandle) await close(praxisHandle);
    delete process.env.PRAXIS_URL;
    if (previousDir === undefined) delete process.env.NEXUS_CHAT_FILES_DIR;
    else process.env.NEXUS_CHAT_FILES_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function resolve(id, body) {
    const response = await fetch(`${nexusHandle.baseUrl}/api/praxis/hitl/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  it('uploads through the existing store, forwards the rebuilt reference, and serves the bytes back', async () => {
    const form = new FormData();
    form.append('file', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'gmail-screenshot.png');
    const upload = await fetch(`${nexusHandle.baseUrl}/api/chat/files/upload`, { method: 'POST', body: form });
    expect(upload.status).toBe(200);
    const uploaded = await upload.json();
    expect(uploaded.url).toBe(`/api/chat/files/${uploaded.fileId}`);
    expect(fs.existsSync(path.join(dir, `${uploaded.fileId}.png`))).toBe(true);

    const text = 'Gmail looks good, one column and full-width buttons';
    const result = await resolve('ask-robert-fixture', {
      freeText: text,
      payload: { attachments: [{ ...uploaded, url: 'http://evil.example/steal', mimeType: 'text/html' }] },
    });
    expect(result.status).toBe(200);
    const sent = forwarded.find((f) => f.id === 'ask-robert-fixture');
    expect(sent.body).toEqual({
      freeText: text,
      payload: {
        attachments: [{
          fileId: uploaded.fileId,
          url: `/api/chat/files/${uploaded.fileId}`,
          mimeType: 'image/png',
          originalName: 'gmail-screenshot.png',
          size: ONE_PIXEL_PNG.length,
        }],
      },
    });
    expect(result.body.request.resolution.payload.attachments[0].fileId).toBe(uploaded.fileId);

    const served = await fetch(`${nexusHandle.baseUrl}${uploaded.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(ONE_PIXEL_PNG)).toBe(true);
  });

  it('forwards text-only and choice answers unchanged and relays the upstream verdict', async () => {
    forwarded.length = 0;
    const textOnly = await resolve('text-only', { freeText: 'proceed with the gmail approval' });
    expect(textOnly.status).toBe(200);
    expect(forwarded[0].body).toEqual({ freeText: 'proceed with the gmail approval' });
    const choiceOnly = await resolve('choice-only', { choice: 'approve', freeText: undefined });
    expect(choiceOnly.status).toBe(200);
    expect(forwarded[1].body).toEqual({ choice: 'approve' });
    const refused = await resolve('refused-by-praxis', { freeText: '' });
    expect(refused).toEqual({ status: 400, body: { error: 'invalid_answer', detail: 'Enter an answer before submitting' } });
  });

  it('refuses a reference that is not an uploaded image before Praxis is called', async () => {
    forwarded.length = 0;
    const bogus = await resolve('never-reaches-praxis', {
      freeText: 'see photo',
      payload: { attachments: [{ fileId: crypto.randomUUID(), url: 'file:///etc/passwd' }] },
    });
    expect(bogus.status).toBe(400);
    expect(bogus.body.error).toBe('invalid_attachment');
    expect(bogus.body.detail).toMatch(/not found in the Nexus upload store/);
    const notImage = await resolve('never-reaches-praxis', {
      freeText: 'see file',
      payload: { attachments: [{ fileId: storeFile(dir, '.txt', Buffer.from('plain')) }] },
    });
    expect(notImage.status).toBe(400);
    expect(notImage.body.detail).toMatch(/Only photos and screenshots/);
    expect(forwarded).toEqual([]);
  });
});
