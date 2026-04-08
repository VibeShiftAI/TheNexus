/**
 * Notes Routes
 * Global and project-scoped notes, ingestion tracking.
 */
const express = require('express');

function createNotesRouter({ db }) {
    const router = express.Router();

    // GET global notes
    router.get('/', async (req, res) => {
        try {
            res.json({ notes: await db.getNotes(null) });
        } catch (error) {
            console.error('Error fetching global notes:', error);
            res.status(500).json({ error: 'Failed to fetch notes' });
        }
    });

    // GET uningested notes (MUST be before /:noteId to avoid matching)
    router.get('/uningested', async (req, res) => {
        try {
            const notes = await db.getUningestedNotes(req.query.category || null);
            res.json({ notes, count: notes.length });
        } catch (error) {
            console.error('Error fetching uningested notes:', error);
            res.status(500).json({ error: 'Failed to fetch uningested notes' });
        }
    });

    // POST create global note
    router.post('/', async (req, res) => {
        try {
            const { content, category, source } = req.body;
            if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });
            const note = await db.createNote({ project_id: null, content: content.trim(), category: category || 'daily-log', source: source || 'operator' });
            if (!note) return res.status(500).json({ error: 'Failed to create note' });
            res.status(201).json({ success: true, note });
        } catch (error) {
            console.error('Error creating global note:', error);
            res.status(500).json({ error: 'Failed to create note' });
        }
    });

    // PATCH update note
    router.patch('/:noteId', async (req, res) => {
        try {
            const allowedFields = ['content', 'category', 'pinned'];
            const updates = {};
            for (const key of Object.keys(req.body)) {
                if (allowedFields.includes(key)) updates[key] = req.body[key];
            }
            if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
            const note = await db.updateNote(req.params.noteId, updates);
            if (!note) return res.status(404).json({ error: 'Note not found' });
            res.json({ success: true, note });
        } catch (error) {
            res.status(500).json({ error: 'Failed to update note' });
        }
    });

    // DELETE note
    router.delete('/:noteId', async (req, res) => {
        try {
            const deleted = await db.deleteNote(req.params.noteId);
            if (!deleted) return res.status(404).json({ error: 'Note not found or delete failed' });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to delete note' });
        }
    });

    // POST mark note as ingested
    router.post('/:noteId/mark-ingested', async (req, res) => {
        try {
            const note = await db.markNoteIngested(req.params.noteId);
            if (!note) return res.status(404).json({ error: 'Note not found' });
            console.log(`🧠 [Notes] Marked note ${req.params.noteId} as cortex-ingested`);
            res.json({ success: true, cortex_ingested_at: note.cortex_ingested_at });
        } catch (error) {
            res.status(500).json({ error: 'Failed to mark note ingested' });
        }
    });

    return router;
}

module.exports = createNotesRouter;

