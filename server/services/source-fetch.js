/**
 * Shared source fetcher.
 *
 * Extracted from server/routes/ingest.js so the URL/YouTube fetch+clean logic has
 * a single implementation reused by the Studio ingestion worker. Handles YouTube
 * (oEmbed title + transcript), JSON, plain text, and HTML (stripped to text).
 */

const YT_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/;
const MAX_CHARS = 50000;

function youtubeId(url) {
  const m = String(url || '').match(YT_RE);
  return m ? m[1] : null;
}

async function fetchYouTube(videoId, url, userTitle) {
  let title = userTitle || '';
  let contentType = 'transcript';
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) { const oembed = await res.json(); if (!title) title = oembed.title || ''; }
  } catch { /* title is best-effort */ }
  if (!title) title = `YouTube Video ${videoId}`;

  let content = '';
  try {
    const { YoutubeTranscript } = await import('youtube-transcript/dist/youtube-transcript.esm.js');
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    if (segments?.length) {
      content = segments.map((seg) => {
        const minutes = Math.floor(seg.offset / 60000);
        const seconds = Math.floor((seg.offset % 60000) / 1000);
        return `[${minutes}:${seconds.toString().padStart(2, '0')}] ${seg.text}`;
      }).join('\n');
    }
  } catch { /* transcript may be disabled */ }

  if (!content) {
    content = `[No transcript available]\n\nVideo: ${title}\nURL: ${url || watchUrl(videoId)}\nVideo ID: ${videoId}`;
    contentType = 'bookmark (no transcript)';
  }
  return { content, title, contentType };
}

function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function fetchWeb(url, userTitle) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TheNexus/1.0', 'Accept': 'text/html,application/xhtml+xml,text/plain,application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch URL: HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  const raw = await res.text();
  let title = userTitle || '';
  let content = '';
  let contentType = 'article';

  if (ct.includes('application/json')) {
    try { content = JSON.stringify(JSON.parse(raw), null, 2); } catch { content = raw; }
    if (!title) title = `JSON from ${safeHost(url)}`;
    contentType = 'json';
  } else if (ct.includes('text/plain') || ct.includes('text/markdown')) {
    content = raw;
    if (!title) title = `Document from ${safeHost(url)}`;
    contentType = 'document';
  } else {
    content = raw
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');
    if (!title) {
      const m = raw.match(/<title[^>]*>(.*?)<\/title>/i);
      title = m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : `Article from ${safeHost(url)}`;
    }
    content = content.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  }
  return { content, title, contentType };
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return 'source'; }
}

/**
 * Fetch and clean content for a URL.
 * @returns {Promise<{content:string,title:string,contentType:string,url:string,videoId:?string}>}
 */
async function fetchSourceContent(url, { userTitle = '' } = {}) {
  if (!url) throw new Error('url is required');
  const videoId = youtubeId(url);
  const result = videoId ? await fetchYouTube(videoId, url, userTitle) : await fetchWeb(url, userTitle);
  let content = result.content || '';
  if (content.length > MAX_CHARS) content = `${content.slice(0, MAX_CHARS)}\n\n[... truncated — content exceeded ${MAX_CHARS} characters]`;
  return { ...result, content, url, videoId };
}

module.exports = { fetchSourceContent, youtubeId, watchUrl };
