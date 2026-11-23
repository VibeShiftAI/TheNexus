// Drive the real terminal and provider against the Nexus chat routes. Only the
// upstream model reply is synthetic. Hold the navigation at either side of
// the SQLite write so neither the ordering nor the assertions need a sleep.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, register } from 'node:module';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

register(new URL('./loader-hooks.mjs', import.meta.url), { data: { realModules: ['@/components/cortex-provider'] } });
const { AITerminal } = await import('../src/components/ai-terminal.tsx');
const { CortexProvider, useCortex } = await import('../src/components/cortex-provider.tsx');
const { typeCharacter, pressKey } = await import('./helpers.mjs');
const require = createRequire(import.meta.url);
process.env.NEXUS_DB_PATH = ':memory:';
const filesDir = mkdtempSync(join(tmpdir(), 'nexus-conversation-switch-'));
process.env.NEXUS_CHAT_FILES_DIR = filesDir;
after(() => rmSync(filesDir, { recursive: true, force: true }));
const db = require('../../db');
const express = require('express');

function CurrentConversation() {
    return createElement('output', { id: 'conversation' }, useCortex().conversationId);
}

function gate() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

async function fixture(t, operation, delay, { rejectNavigation = false, modelReply } = {}) {
    const target = await db.createConversation('praxis', 'History ' + t.name);
    const previous = await db.createConversation('praxis', 'Previous');
    const seed = (id, content) => db.saveChatMessage({ conversation_id: id, mode: 'praxis', role: 'assistant', content });
    await seed(target.id, 'Destination history');
    await seed(previous.id, 'Previous history');

    const app = express();
    app.use(express.json());
    app.use('/api/chat/files', require('../../server/routes/chat-files')());
    app.use('/api/chat', require('../../server/routes/chat-history')({ db }));
    app.use('/api/ai/chat', require('../../server/routes/ai-chat')({ db }));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const nativeFetch = globalThis.fetch;
    const held = gate();
    const release = gate();
    const posts = [];
    const replies = [];
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const { pathname, search } = new URL(input, origin);
        if (pathname === '/api/chat') { // Nexus -> Praxis
            if (modelReply) await modelReply.promise;
            if (!JSON.parse(init.body).stream) return Response.json({ response: 'Test reply' });
            return new Response('data: {"type":"final","response":"Test reply"}\n\ndata: [DONE]\n\n');
        }
        const request = () => nativeFetch(origin + pathname + search, init);
        const switching = pathname.endsWith('/switch') || (pathname === '/api/chat/conversations' && init?.method === 'POST');
        if (switching && delay === 'request') {
            held.resolve();
            await release.promise;
            if (rejectNavigation) return new Response(null, { status: 503 });
        }
        if (pathname === '/api/ai/chat' && init?.method === 'POST') {
            posts.push(JSON.parse(init.body));
            const response = await request();
            replies.push(response.clone().text());
            return response;
        }
        const response = await request();
        if (switching && delay === 'response') { held.resolve(); await release.promise; }
        return response;
    });

    const host = document.createElement('div');
    window.sessionStorage.clear();
    document.body.append(host);
    const root = createRoot(host);
    t.after(() => { release.resolve(); act(() => root.unmount()); host.remove(); });
    act(() => root.render(createElement(CortexProvider, null, createElement(CurrentConversation),
        createElement(AITerminal, { mode: 'inline' }))));
    async function until(check) {
        const deadline = Date.now() + 5000;
        while (!check() && Date.now() < deadline) {
            await act(async () => { await new Promise(setImmediate); });
        }
        assert.ok(check(), 'Timed out waiting for ' + check);
    }
    const currentId = () => host.querySelector('#conversation').textContent;
    const rows = role => [...host.querySelectorAll('[data-message-row="' + role + '"]')].map(row => row.textContent);
    await until(() => currentId() === previous.id);
    async function pick(conversation) {
        act(() => host.querySelector('[title="Conversation History"]').click());
        const choice = () => [...host.querySelectorAll('div.truncate')].find(el => el.textContent === conversation.title);
        await until(choice);
        act(() => choice().click());
    }
    if (operation === 'switch') {
        await pick(target);
        await held.promise;
    } else {
        await act(async () => { host.querySelector('[title="New Conversation"]').click(); await held.promise; });
    }
    return { host, previous, target, release, posts, replies, rows, currentId, until, pick };
}

const message = 'Message sent during navigation';
for (const operation of ['create', 'switch']) {
    for (const delay of ['response', 'request']) {
        test(operation + ' with a delayed ' + delay + ' keeps and saves a concurrent send in its destination', async t => {
            const view = await fixture(t, operation, delay);
            const field = view.host.querySelector('textarea');
            typeCharacter(field, message);
            pressKey(field, 'Enter');
            const visible = () => view.rows('user').filter(text => text.includes(message)).length;
            const during = visible();
            assert.equal(during, 1, 'sent row is already visible with navigation pending');
            // Drain a POST that started before release (the original race).
            await act(async () => {});
            if (view.posts.length) await view.until(() => view.replies.length === 1);
            await act(async () => { await Promise.all(view.replies); view.release.resolve(); });
            await view.until(() => view.currentId() !== view.previous.id && view.posts.length === 1 && view.replies.length === 1);
            await act(async () => { await Promise.all(view.replies); });
            const shown = view.currentId();
            if (operation === 'switch') assert.equal(shown, view.target.id);
            const [post] = view.posts;
            const saved = await db.getChatMessageById(post.clientMessageId);
            t.diagnostic(JSON.stringify({ during, after: visible(), shown, previous: view.previous.id, stored: saved?.conversation_id }));
            assert.equal(visible(), 1, 'the navigation reply must keep the sent row visible');
            assert.equal(saved.content, message);
            assert.equal(saved.conversation_id, shown);
            assert.equal(post.conversationId, shown, 'the send pins the selected conversation');
            assert.deepEqual(post.history.map(m => m.content), operation === 'switch' ? ['Destination history'] : []);
            assert.equal(view.rows('assistant').some(text => text.includes('Destination history')), operation === 'switch');
            assert.equal((await db.getActiveConversation()).id, shown);
        });
    }
}

test('new conversation with no concurrent send opens an empty transcript', async t => {
    const view = await fixture(t, 'create', 'response');
    await act(async () => { view.release.resolve(); });
    const destination = (await db.getActiveConversation()).id;
    assert.notEqual(destination, view.previous.id);
    await view.until(() => view.currentId() === destination);
    assert.equal(view.host.querySelectorAll('[data-message-row]').length, 0);
    assert.equal(view.currentId(), (await db.getActiveConversation()).id);
    assert.deepEqual(await db.getChatMessages(view.currentId()), []);
});

test('a failed selection leaves the draft ready to retry without posting it to the previous conversation', async t => {
    const view = await fixture(t, 'create', 'request', { rejectNavigation: true });
    const field = view.host.querySelector('textarea');
    typeCharacter(field, message);
    pressKey(field, 'Enter');
    await act(async () => { view.release.resolve(); });
    await view.until(() => view.rows('system').some(text => text.includes('Could not open the conversation')));
    assert.equal(view.currentId(), view.previous.id);
    assert.equal(field.value, message);
    assert.equal(field.disabled, false);
    assert.equal(view.posts.length, 0);
    assert.deepEqual((await db.getChatMessages(view.previous.id)).map(m => m.content), ['Previous history']);
});

test('a reply arriving after another selection stays in the conversation that accepted the turn', async t => {
    const modelReply = gate();
    t.after(modelReply.resolve);
    const view = await fixture(t, 'switch', 'response', { modelReply });
    const field = view.host.querySelector('textarea');
    typeCharacter(field, message);
    pressKey(field, 'Enter');
    await act(async () => { view.release.resolve(); });
    await view.until(() => view.currentId() === view.target.id && view.posts.length === 1);
    act(() => view.host.querySelector('[title="New Conversation"]').click());
    await view.until(() => view.currentId() && view.currentId() !== view.target.id);
    await act(async () => { modelReply.resolve(); });
    await view.until(() => !field.disabled);
    assert.deepEqual(view.rows('assistant'), []);
    assert.equal((await db.getChatMessages(view.target.id)).at(-1).content, 'Test reply');
});

for (const operation of ['create', 'switch']) {
    test(operation + ' with a queued send is shown if a later pick fails', async t => {
        const laterPick = await db.createConversation('praxis', 'Later pick ' + t.name);
        const view = await fixture(t, operation, 'request');
        const field = view.host.querySelector('textarea');
        typeCharacter(field, message);
        pressKey(field, 'Enter');
        assert.equal(view.rows('user').filter(row => row.includes(message)).length, 1);
        await view.pick(laterPick);
        // The pick came from real history, but is gone by the time its PUT reaches Nexus.
        await db.deleteConversation(laterPick.id);
        await act(async () => { view.release.resolve(); });
        await view.until(() => !field.disabled && view.rows('system').some(row => row.includes('Could not open the conversation')));

        const shown = view.currentId();
        const active = (await db.getActiveConversation()).id;
        assert.equal(view.posts.length, 1);
        const [post] = view.posts;
        const stored = (await db.getChatMessageById(post.clientMessageId)).conversation_id;
        const copies = (await db.getChatMessages(stored)).filter(m => m.role === 'user' && m.content === message).length;
        const visible = view.rows('user').filter(row => row.includes(message)).length;
        t.diagnostic(JSON.stringify({ previous: view.previous.id, shown, active, stored, copies, visible, draft: field.value, system: view.rows('system') }));
        assert.notEqual(stored, view.previous.id);
        assert.equal(stored, operation === 'switch' ? view.target.id : active);
        assert.equal(post.conversationId, stored);
        assert.equal(shown, stored);
        assert.equal(active, shown);
        assert.equal(copies, 1);
        assert.equal(visible, 1);
        assert.equal(view.rows('assistant').some(row => row.includes('Destination history')), operation === 'switch');
        assert.equal(view.rows('assistant').some(row => row.includes('Test reply')), true);
        assert.equal(field.value, '');
        assert.equal(view.host.querySelector('[aria-label="Send message"]').disabled, true);
    });
}

for (const pickSucceeds of [true, false]) {
    test('a failed create followed by a ' + (pickSucceeds ? 'successful' : 'failed') + ' pick keeps the unsent draft', async t => {
        const view = await fixture(t, 'create', 'request');
        t.mock.method(db, 'createConversation', () => { throw new Error('Create unavailable'); }, { times: 1 });
        const field = view.host.querySelector('textarea');
        typeCharacter(field, message);
        pressKey(field, 'Enter');
        await view.pick(view.target);
        if (!pickSucceeds) await db.deleteConversation(view.target.id);
        await act(async () => { view.release.resolve(); });
        const expected = pickSucceeds ? view.target : view.previous;
        await view.until(() => view.currentId() === expected.id && !field.disabled);
        assert.equal((await db.getActiveConversation()).id, expected.id);
        assert.equal(view.posts.length, 0);
        assert.deepEqual(view.rows('user'), []);
        assert.equal(field.value, message);
        assert.equal(view.host.querySelector('[aria-label="Send message"]').disabled, false);
        assert.deepEqual((await db.getChatMessages(expected.id)).filter(m => m.role === 'user'), []);
    });
}

test('a file dropped while a send waits stays attached to the next message', async t => {
    const view = await fixture(t, 'create', 'request');
    const field = view.host.querySelector('textarea');
    const drop = name => {
        const event = new window.Event('drop', { bubbles: true, cancelable: true });
        const file = new File([name], name, { type: 'text/plain' });
        Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
        act(() => view.host.querySelector('.custom-scrollbar.overflow-y-auto').dispatchEvent(event));
    };
    const chips = () => [...view.host.querySelectorAll('span.truncate')].map(el => el.textContent);
    drop('first.txt');
    typeCharacter(field, message);
    pressKey(field, 'Enter');
    assert.equal(field.disabled, true);
    drop('later.txt');
    assert.deepEqual(chips(), ['first.txt', 'later.txt']);
    assert.equal(view.posts.length, 0);
    await act(async () => { view.release.resolve(); });
    await view.until(() => !field.disabled && view.posts.length === 1);
    const sentFiles = post => post.attachments.map(file => file.originalName);
    t.diagnostic(JSON.stringify({ firstRequest: sentFiles(view.posts[0]), remainingChips: chips() }));
    assert.deepEqual(sentFiles(view.posts[0]), ['first.txt']);
    assert.deepEqual(view.posts[0].files.map(file => file.name), ['first.txt']);
    assert.deepEqual(chips(), ['later.txt']);

    pressKey(field, 'Enter');
    await view.until(() => !field.disabled && view.posts.length === 2);
    assert.deepEqual(sentFiles(view.posts[1]), ['later.txt']);
    assert.deepEqual(view.posts[1].files.map(file => file.name), ['later.txt']);
    assert.deepEqual(chips(), []);
});
