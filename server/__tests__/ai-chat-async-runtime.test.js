const http = require('http');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nativeFetch = global.fetch;

test('an async receipt and exact reply survive a fresh router using real SQLite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-async-runtime-'));
    const originalDbPath = process.env.NEXUS_DB_PATH;
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    let server;
    try {
        const db = require('../../db');
        const run = jest.fn(async () => ({ response: 'stored exact reply', suppressVoice: true, attachments: [{ type: 'image', url: '/api/chat/files/test-image' }] }));
        const mount = async () => {
            const app = express(); app.use(express.json());
            app.use('/api/ai/chat', require('../routes/ai-chat-async')({ db, io: { emit() {} }, run }));
            server = http.createServer(app);
            await new Promise(r => server.listen(0, '127.0.0.1', r));
            return `http://127.0.0.1:${server.address().port}/api/ai/chat`;
        };
        let base = await mount();
        const body = { async: true, clientMessageId: 'persisted', message: 'inspect the photo', attachments: [{ mimeType: 'image/png', url: '/api/chat/files/photo' }] };
        const post = () => nativeFetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        expect((await post()).status).toBe(202);
        for (let i = 0; i < 30 && !(await db.getChatMessageById('persisted:reply')); i++) await new Promise(r => setTimeout(r, 5));
        server.closeAllConnections(); await new Promise(r => server.close(r));
        base = await mount();
        const replay = await (await post()).json();
        expect(replay).toMatchObject({ accepted: true, status: 'completed', assistantMessageId: 'persisted:reply', response: 'stored exact reply', suppressVoice: true, attachments: [{ type: 'image', url: '/api/chat/files/test-image' }] });
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][0].attachments[0].url).toBe('/api/chat/files/photo');
    } finally {
        if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
        if (originalDbPath === undefined) delete process.env.NEXUS_DB_PATH; else process.env.NEXUS_DB_PATH = originalDbPath;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
