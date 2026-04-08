/**
 * Ingest Routes
 * URL/text ingestion with YouTube transcript support and Cortex forwarding.
 */
const express = require('express');

function createIngestRouter({ db }) {
    const router = express.Router();

    router.post('/', async (req, res) => {
        const { url, text, title: userTitle, projectId } = req.body || {};
        if (!url && !text) return res.status(400).json({ error: 'Either url or text is required' });

        console.log(`\n📥 [Ingest] Request: ${url ? `URL: ${url}` : `Text (${text.length} chars)`}`);

        try {
            let content = '';
            let sourceUrl = url || null;
            let autoTitle = userTitle || '';
            let contentType_label = 'article';

            if (url) {
                // YouTube detection
                const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);

                if (ytMatch) {
                    const videoId = ytMatch[1];
                    console.log(`📺 [Ingest] YouTube detected — video ID: ${videoId}`);
                    contentType_label = 'transcript';

                    try {
                        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { signal: AbortSignal.timeout(8000) });
                        if (oembedRes.ok) { const oembed = await oembedRes.json(); if (!autoTitle) autoTitle = oembed.title || `YouTube Video ${videoId}`; }
                    } catch (oembedErr) { console.warn(`[Ingest] oEmbed title fetch failed:`, oembedErr.message); }
                    if (!autoTitle) autoTitle = `YouTube Video ${videoId}`;

                    try {
                        const { YoutubeTranscript } = await import('youtube-transcript/dist/youtube-transcript.esm.js');
                        const segments = await YoutubeTranscript.fetchTranscript(videoId);
                        if (segments?.length > 0) {
                            content = segments.map(seg => {
                                const minutes = Math.floor(seg.offset / 60000);
                                const seconds = Math.floor((seg.offset % 60000) / 1000);
                                return `[${minutes}:${seconds.toString().padStart(2, '0')}] ${seg.text}`;
                            }).join('\n');
                        }
                    } catch (transcriptErr) {
                        console.warn(`[Ingest] YouTube transcript unavailable: ${transcriptErr.message}`);
                    }

                    if (!content) {
                        content = `[No transcript available]\n\nVideo: ${autoTitle}\nURL: ${url}\nVideo ID: ${videoId}`;
                        contentType_label = 'bookmark (no transcript)';
                    }
                } else {
                    // Standard URL fetch
                    const fetchResponse = await fetch(url, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TheNexus/1.0', 'Accept': 'text/html,application/xhtml+xml,text/plain,application/json' },
                        signal: AbortSignal.timeout(15000),
                    });
                    if (!fetchResponse.ok) throw new Error(`Failed to fetch URL: HTTP ${fetchResponse.status}`);

                    const contentType = fetchResponse.headers.get('content-type') || '';
                    const rawBody = await fetchResponse.text();

                    if (contentType.includes('application/json')) {
                        try { content = JSON.stringify(JSON.parse(rawBody), null, 2); } catch { content = rawBody; }
                        if (!autoTitle) autoTitle = `JSON from ${new URL(url).hostname}`;
                    } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
                        content = rawBody;
                        if (!autoTitle) autoTitle = `Document from ${new URL(url).hostname}`;
                    } else {
                        content = rawBody
                            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                            .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
                            .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
                            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
                            .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');
                        if (!autoTitle) {
                            const titleMatch = rawBody.match(/<title[^>]*>(.*?)<\/title>/i);
                            autoTitle = titleMatch ? titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : `Article from ${new URL(url).hostname}`;
                        }
                        content = content.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
                    }
                }

                if (content.length > 50000) content = content.substring(0, 50000) + '\n\n[... truncated — content exceeded 50,000 characters]';
            } else {
                content = text;
                if (!autoTitle) autoTitle = text.substring(0, 60).replace(/\n/g, ' ') + (text.length > 60 ? '...' : '');
            }

            if (!content || content.trim().length < 10) return res.status(422).json({ error: 'Extracted content is too short or empty' });

            const noteContent = [`## 📥 ${autoTitle}`, sourceUrl ? `**Source:** ${sourceUrl}` : null, `**Ingested:** ${new Date().toLocaleString()}`, `**Length:** ${content.length.toLocaleString()} characters`, '', '---', '', content].filter(Boolean).join('\n');

            const note = await db.createNote({ project_id: projectId || null, content: noteContent, category: 'ingested', source: 'operator' });
            console.log(`✅ [Ingest] Saved as note ${note?.id} (${content.length} chars)`);

            // Cortex fire-and-forget
            const CORTEX_GATEWAY_URL = process.env.CORTEX_GATEWAY_URL || 'http://localhost:8100';
            const MAX_CORTEX_CHARS = 15000;
            const cortexText = content.length > MAX_CORTEX_CHARS ? `${autoTitle}\n\n${content.substring(0, MAX_CORTEX_CHARS)}\n\n[Content truncated]` : `${autoTitle}\n\n${content}`;
            const noteId = note?.id;

            fetch(`${CORTEX_GATEWAY_URL}/api/memory/ingest`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: cortexText, source: sourceUrl || 'nexus-ingest', namespace: 'praxis', use_extraction: true }),
                signal: AbortSignal.timeout(180_000),
            })
                .then(async (cortexRes) => {
                    if (cortexRes.ok) { const result = await cortexRes.json(); console.log(`🧠 [Ingest → Cortex] Ingested: ${result.factoids_ingested} factoids`); if (noteId) await db.markNoteIngested(noteId); }
                    else console.warn(`⚠️ [Ingest → Cortex] HTTP ${cortexRes.status}`);
                })
                .catch((cortexErr) => console.warn(`⚠️ [Ingest → Cortex] ${cortexErr.name === 'AbortError' ? 'Timed out' : cortexErr.message}`));

            return res.json({ success: true, noteId: note?.id, title: autoTitle, contentLength: content.length, contentType: contentType_label, cortex: 'dispatched', source: sourceUrl || 'text' });
        } catch (error) {
            console.error(`❌ [Ingest] Error:`, error);
            return res.status(500).json({ error: `Ingestion failed: ${error.message}` });
        }
    });

    return router;
}

module.exports = createIngestRouter;
