/**
 * YouTube Data API v3 client (thin).
 *
 * Used by the Studio ingestion pipeline to pull real video metadata for
 * `youtube_search` and `youtube_channel` sources, and to expand the object
 * catalog with related videos for a given topic.
 *
 * Key resolution: YOUTUBE_API_KEY, falling back to GOOGLE_API_KEY. If neither is
 * set (or the API is disabled), callers should treat a thrown error / empty list
 * as "skip this source gracefully" rather than a fatal failure.
 */

const API = 'https://www.googleapis.com/youtube/v3';

function getKey() {
  return process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || null;
}

function hasKey() {
  return Boolean(getKey());
}

async function ytFetch(endpoint, params) {
  const key = getKey();
  if (!key) throw new Error('No YOUTUBE_API_KEY / GOOGLE_API_KEY configured');
  const qs = new URLSearchParams({ ...params, key }).toString();
  const res = await fetch(`${API}/${endpoint}?${qs}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    let detail = '';
    try { const body = await res.json(); detail = body?.error?.message || ''; } catch { /* ignore */ }
    throw new Error(`YouTube API ${endpoint} HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Search YouTube for videos matching a free-text query. */
async function searchVideos(query, max = 6) {
  if (!query || !String(query).trim()) return [];
  const data = await ytFetch('search', {
    part: 'snippet',
    type: 'video',
    maxResults: String(Math.max(1, Math.min(25, max))),
    q: String(query),
    relevanceLanguage: 'en',
    safeSearch: 'none',
  });
  return (data.items || [])
    .filter((it) => it.id && it.id.videoId)
    .map((it) => ({
      videoId: it.id.videoId,
      title: it.snippet?.title || `YouTube video ${it.id.videoId}`,
      channelTitle: it.snippet?.channelTitle || '',
      publishedAt: it.snippet?.publishedAt || null,
      url: watchUrl(it.id.videoId),
    }));
}

/** Resolve a channel reference (URL, @handle, /user/, or raw UC id) to a channel id. */
async function resolveChannelId(ref) {
  if (!ref) return null;
  const s = String(ref).trim();

  // Raw channel id
  const ucMatch = s.match(/(UC[0-9A-Za-z_-]{20,})/);
  if (ucMatch) return ucMatch[1];

  // /channel/UC... already handled above; handle @handle and /user/
  const handleMatch = s.match(/@([A-Za-z0-9._-]+)/);
  if (handleMatch) {
    const data = await ytFetch('channels', { part: 'id', forHandle: `@${handleMatch[1]}` });
    return data.items?.[0]?.id || null;
  }
  const userMatch = s.match(/\/user\/([A-Za-z0-9._-]+)/);
  if (userMatch) {
    const data = await ytFetch('channels', { part: 'id', forUsername: userMatch[1] });
    return data.items?.[0]?.id || null;
  }

  // Last resort: treat the whole string as a search for the channel
  const data = await ytFetch('search', { part: 'snippet', type: 'channel', maxResults: '1', q: s });
  return data.items?.[0]?.id?.channelId || null;
}

/** Most recent uploads for a channel reference. */
async function channelUploads(ref, max = 6) {
  const channelId = await resolveChannelId(ref);
  if (!channelId) return [];
  const channelData = await ytFetch('channels', { part: 'contentDetails', id: channelId });
  const uploads = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];
  const data = await ytFetch('playlistItems', {
    part: 'snippet',
    maxResults: String(Math.max(1, Math.min(25, max))),
    playlistId: uploads,
  });
  return (data.items || [])
    .map((it) => it.snippet)
    .filter((sn) => sn && sn.resourceId && sn.resourceId.videoId)
    .map((sn) => ({
      videoId: sn.resourceId.videoId,
      title: sn.title || `YouTube video ${sn.resourceId.videoId}`,
      channelTitle: sn.channelTitle || '',
      publishedAt: sn.publishedAt || null,
      url: watchUrl(sn.resourceId.videoId),
    }));
}

module.exports = { getKey, hasKey, searchVideos, channelUploads, resolveChannelId, watchUrl };
