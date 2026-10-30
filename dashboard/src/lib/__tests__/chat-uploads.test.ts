import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareChatFiles, voiceClipBase64 } from '../chat-uploads';

test('small text files ride inline, every file is uploaded, and a failed upload is skipped', async t => {
  const uploaded: string[] = [];
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    assert.equal(String(input), '/api/chat/files/upload');
    const file = (init?.body as FormData).get('file') as File;
    uploaded.push(file.name);
    return file.name === 'broken.png'
      ? new Response('nope', { status: 500 })
      : Response.json({ fileId: `id-${file.name}`, url: `/files/${file.name}`, mimeType: file.type, originalName: file.name, size: file.size });
  });
  const notes = new File(['hello'], 'notes.md', { type: '' });
  const photo = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
  const broken = new File([new Uint8Array([4])], 'broken.png', { type: 'image/png' });
  const { fileContents, uploadedAttachments } = await prepareChatFiles([notes, photo, broken]);
  assert.deepEqual(fileContents, [{ name: 'notes.md', content: 'hello', type: 'text/plain' }]);
  assert.deepEqual(uploaded.sort(), ['broken.png', 'notes.md', 'photo.png']);
  assert.deepEqual(uploadedAttachments.map(a => a.originalName).sort(), ['notes.md', 'photo.png']);
});

test('a voice clip is base64 encoded, and no clip is undefined', async () => {
  assert.equal(await voiceClipBase64(null), undefined);
  const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
  const encoded = await voiceClipBase64(new Blob([bytes]));
  assert.deepEqual(new Uint8Array(Buffer.from(encoded!, 'base64')), bytes, 'chunked encoding round-trips past one chunk');
});
