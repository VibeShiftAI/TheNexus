/**
 * Ingest Routes
 * URL/text ingestion with YouTube transcript support and Cortex forwarding.
 */
const express = require('express');
const { fetchSourceContent } = require('../services/source-fetch');

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
                const fetched = await fetchSourceContent(url, { userTitle: autoTitle });
                content = fetched.content;
                autoTitle = fetched.title;
                contentType_label = fetched.contentType;
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
