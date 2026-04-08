/**
 * Chat Files Routes
 * File upload/download for chat attachments.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

function createChatFilesRouter() {
    const router = express.Router();

    const CHAT_FILES_DIR = path.join(__dirname, '..', '..', 'data', 'chat-files');

    // Ensure directory exists
    if (!fs.existsSync(CHAT_FILES_DIR)) {
        fs.mkdirSync(CHAT_FILES_DIR, { recursive: true });
        console.log('[Chat Files] Created storage directory:', CHAT_FILES_DIR);
    }

    // Multer config
    const chatFileStorage = multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, CHAT_FILES_DIR),
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname) || '';
            cb(null, `${crypto.randomUUID()}${ext}`);
        }
    });
    const chatFileUpload = multer({ storage: chatFileStorage, limits: { fileSize: 25 * 1024 * 1024 } });

    // POST upload
    router.post('/upload', chatFileUpload.single('file'), (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
            const fileId = path.basename(req.file.filename, path.extname(req.file.filename));
            console.log(`[Chat Files] Uploaded: ${req.file.originalname} → ${req.file.filename} (${(req.file.size / 1024).toFixed(1)} KB)`);
            res.json({ fileId, url: `/api/chat/files/${fileId}`, mimeType: req.file.mimetype, originalName: req.file.originalname, size: req.file.size });
        } catch (error) {
            res.status(500).json({ error: 'File upload failed: ' + error.message });
        }
    });

    // GET serve file
    router.get('/:fileId', (req, res) => {
        try {
            const { fileId } = req.params;
            if (!fileId || fileId.includes('..') || fileId.includes('/')) return res.status(400).json({ error: 'Invalid file ID' });
            const files = fs.readdirSync(CHAT_FILES_DIR);
            const match = files.find(f => f.startsWith(fileId) && !f.startsWith('.'));
            if (!match) return res.status(404).json({ error: 'File not found' });
            const filePath = path.join(CHAT_FILES_DIR, match);
            const ext = path.extname(match).toLowerCase();
            const mimeMap = {
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
                '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
                '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
                '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain',
                '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.zip': 'application/zip',
            };
            res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
            res.setHeader('Content-Disposition', `inline; filename="${match}"`);
            res.sendFile(filePath);
        } catch (error) {
            res.status(500).json({ error: 'Failed to serve file: ' + error.message });
        }
    });

    return router;
}

module.exports = createChatFilesRouter;
