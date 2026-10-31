// fetchSourceContent used to cut every page to its first 50,000 characters
// after reading the whole body, so the cut protected nothing and the stored
// note was partial. The page now comes back whole; the edge guard is the
// fetch clock, which fails the fetch rather than storing part of a page.
describe('source fetch', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  function page(body, contentType) {
    return { ok: true, status: 200, headers: { get: () => contentType }, text: async () => body };
  }

  test('a long plain-text page comes back whole', async () => {
    const body = `Start. ${'Plain text line.\n'.repeat(6000)}END OF PAGE`;
    global.fetch = jest.fn(async () => page(body, 'text/plain'));
    const { fetchSourceContent } = require('../services/source-fetch');
    const result = await fetchSourceContent('https://example.com/long.txt');
    expect(body.length).toBeGreaterThan(50000);
    expect(result.content).toBe(body);
    expect(result.content).not.toMatch(/truncated/);
  });

  test('a long HTML page comes back whole after cleaning', async () => {
    const paragraphs = Array.from({ length: 3000 }, (_, i) => `<p>Paragraph ${i} of the article.</p>`).join('');
    global.fetch = jest.fn(async () => page(`<html><head><title>Long</title></head><body>${paragraphs}<p>LAST PARAGRAPH</p></body></html>`, 'text/html'));
    const { fetchSourceContent } = require('../services/source-fetch');
    const result = await fetchSourceContent('https://example.com/long.html');
    expect(result.title).toBe('Long');
    expect(result.content.length).toBeGreaterThan(50000);
    expect(result.content).toContain('Paragraph 2999 of the article.');
    expect(result.content.endsWith('LAST PARAGRAPH')).toBe(true);
  });

  test('a page that runs past the fetch clock fails instead of coming back partial', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); } }));
    const { fetchSourceContent } = require('../services/source-fetch');
    await expect(fetchSourceContent('https://example.com/slow')).rejects.toThrow(/timeout/);
  });
});
