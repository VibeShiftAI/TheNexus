/**
 * File-serving routes whose folder sits under a dot folder (2026-11-02).
 * Express 5's `send` refuses a bare absolute path when any folder in it starts
 * with a dot, so a checkout under `.worktrees/` (or a store configured inside
 * one) answered 404 for every file. Each route now serves with `root`, so the
 * dotfile rule sees only the file name. Studio reference images are covered in
 * studio-route.test.js.
 */
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function listen(app) {
    const server = http.createServer(app);
    const sockets = new Set();
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` }));
    });
}

function close(handle) {
    for (const socket of handle.sockets) socket.destroy();
    return new Promise((resolve) => handle.server.close(resolve));
}

let dir;
let handle;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dot-serving-'));
});
afterEach(async () => {
    if (handle) await close(handle);
    handle = null;
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('chat files upload to and serve from a store under a dot folder', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const store = path.join(dir, '.dot-parent', 'chat-files');
    const previous = process.env.NEXUS_CHAT_FILES_DIR;
    process.env.NEXUS_CHAT_FILES_DIR = store;
    try {
        const createChatFilesRouter = require('../routes/chat-files');
        const app = express();
        app.use('/api/chat/files', createChatFilesRouter());
        handle = await listen(app);

        const form = new FormData();
        form.append('file', new Blob([Buffer.from('dotted-chat-bytes')], { type: 'text/plain' }), 'note.txt');
        const uploadRes = await fetch(`${handle.baseUrl}/api/chat/files/upload`, { method: 'POST', body: form });
        expect(uploadRes.status).toBe(200);
        const uploaded = await uploadRes.json();
        expect(fs.readdirSync(store)).toEqual([`${uploaded.fileId}.txt`]);

        const served = await fetch(`${handle.baseUrl}${uploaded.url}`);
        expect(served.status).toBe(200);
        expect(served.headers.get('content-type')).toMatch(/^text\/plain/);
        expect(await served.text()).toBe('dotted-chat-bytes');
    } finally {
        if (previous === undefined) delete process.env.NEXUS_CHAT_FILES_DIR;
        else process.env.NEXUS_CHAT_FILES_DIR = previous;
    }
});

test('the travel update feed serves its manifest and installer from under a dot folder, and still refuses a dot-named file', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const updatesDir = path.join(dir, '.dot-parent', 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    fs.writeFileSync(path.join(updatesDir, 'latest.json'), '{"version":"1.2.3"}');
    fs.writeFileSync(path.join(updatesDir, 'nexus-setup.exe'), 'installer-bytes');
    fs.writeFileSync(path.join(updatesDir, '.hidden.json'), '{"secret":true}');

    const createUpdatesRouter = require('../routes/updates');
    const app = express();
    app.use('/api/updates', createUpdatesRouter({ updatesDir }));
    handle = await listen(app);

    const manifest = await fetch(`${handle.baseUrl}/api/updates/latest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await manifest.json()).toEqual({ version: '1.2.3' });

    const installer = await fetch(`${handle.baseUrl}/api/updates/nexus-setup.exe`);
    expect(installer.status).toBe(200);
    expect(await installer.text()).toBe('installer-bytes');

    // The name passes the allow-list, but the dotfile rule still applies to the file itself.
    const hidden = await fetch(`${handle.baseUrl}/api/updates/.hidden.json`);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain('secret');
});
