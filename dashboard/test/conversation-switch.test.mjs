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

async function fixture(t, operation, delay, { rejectNavigation = false, modelReply, sendPost, ingestPost } = {}) {
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
        if (pathname === '/api/ingest' && ingestPost) return ingestPost(JSON.parse(init.body));
        const request = () => nativeFetch(origin + pathname + search, init);
        const switching = pathname.endsWith('/switch') || (pathname === '/api/chat/conversations' && init?.method === 'POST');
        if (switching && delay === 'request') {
            held.resolve();
            await release.promise;
            if (rejectNavigation) return new Response(null, { status: 503 });
        }
        if (pathname === '/api/ai/chat' && init?.method === 'POST') {
            posts.push(JSON.parse(init.body));
            const response = sendPost ? await sendPost(request) : await request();
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

function submitDuringSwitch(view) {
    const field = view.host.querySelector('textarea');
    typeCharacter(field, message);
    pressKey(field, 'Enter');
    assert.equal(view.rows('user').filter(row => row.includes(message)).length, 1);
    return field;
}

test('picking the same chat twice keeps the accepted user row exactly once', async t => {
    const post = gate();
    const savedReply = gate();
    const deliverReply = gate();
    t.after(post.resolve);
    t.after(deliverReply.resolve);
    const view = await fixture(t, 'switch', 'response', {
        sendPost: async request => {
            await post.promise;
            const response = await request();
            savedReply.resolve();
            await deliverReply.promise;
            return response;
        },
    });
    const field = submitDuringSwitch(view);
    await view.pick(view.target);
    await act(async () => { view.release.resolve(); });
    // The second snapshot is older than the POST. Then re-open with a fresh snapshot.
    await view.until(() => view.currentId() === view.target.id && view.posts.length === 1);
    await act(async () => { post.resolve(); await savedReply.promise; });
    const userRows = () => view.rows('user').filter(row => row.includes(message)).length;
    assert.equal(userRows(), 1, 'the older snapshot must keep the local send');
    await view.pick(view.target);
    await view.until(() => view.currentId() === view.target.id);
    assert.equal(userRows(), 1, 'the fresh snapshot already contains the in-flight send');
    await act(async () => { deliverReply.resolve(); });
    await view.until(() => !field.disabled);
    const saved = await db.getChatMessages(view.target.id);
    const stored = saved.filter(row => row.role === 'user' && row.content === message).length;
    const replyVisible = view.rows('assistant').some(row => row.includes('Test reply'));
    t.diagnostic(JSON.stringify({ stored, visibleUserRows: userRows(), replyVisible }));
    assert.equal(stored, 1);
    assert.equal(replyVisible, true);
    assert.equal(userRows(), 1);
    assert.equal(view.posts.length, 1);
});

test('a stale repeat-pick response arriving after the send keeps both rows of the turn', async t => {
    const snapshotRead = gate();
    const releaseSnapshot = gate();
    t.after(snapshotRead.resolve);
    t.after(releaseSnapshot.resolve);
    const view = await fixture(t, 'switch', 'response', {
        sendPost: async request => { await snapshotRead.promise; return request(); },
    });
    const field = submitDuringSwitch(view);
    await view.pick(view.target);
    const getHistory = db.getChatMessages;
    t.mock.method(db, 'getChatMessages', async (...args) => {
        const rows = await getHistory(...args);
        snapshotRead.resolve();
        await releaseSnapshot.promise;
        return rows;
    }, { times: 1 });
    await act(async () => { view.release.resolve(); });
    await view.until(() => view.posts.length === 1 && !field.disabled);
    await act(async () => { releaseSnapshot.resolve(); });
    await view.until(() => view.currentId() === view.target.id);
    assert.equal(view.rows('user').filter(row => row.includes(message)).length, 1);
    assert.equal(view.rows('assistant').filter(row => row.includes('Test reply')).length, 1);
});

for (const failure of ['HTTP 503', 'Nexus error response']) {
    test('a failed POST after a successful later pick keeps the submitted text visible: ' + failure, async t => {
        const post = gate();
        t.after(post.resolve);
        const view = await fixture(t, 'create', 'response', {
            sendPost: async request => {
                await post.promise;
                if (failure === 'HTTP 503') return new Response(null, { status: 503 });
                return request();
            },
        });
        const created = (await db.getActiveConversation()).id;
        const field = submitDuringSwitch(view);
        await view.pick(view.target);
        await act(async () => { view.release.resolve(); });
        await view.until(() => view.currentId() === view.target.id && view.posts.length === 1);
        if (failure === 'Nexus error response') {
            t.mock.method(db, 'saveChatMessage', () => { throw new Error('Storage unavailable'); }, { times: 1 });
        }
        await act(async () => { post.resolve(); });
        await view.until(() => !field.disabled);
        const [attempt] = view.posts;
        const stored = Boolean(await db.getChatMessageById(attempt.clientMessageId));
        const notice = [...view.host.querySelectorAll('[role="alert"]')].find(el => el.textContent.includes(message));
        t.diagnostic(JSON.stringify({ stored, draft: field.value, notice: notice?.textContent ?? null }));
        assert.equal(attempt.conversationId, created);
        assert.equal(stored, false);
        assert.equal(view.currentId(), view.target.id);
        assert.equal(view.currentId(), (await db.getActiveConversation()).id);
        assert.deepEqual(view.rows('user'), [], 'the failed turn does not belong to the newly selected chat');
        assert.ok(notice && /could not be confirmed/i.test(notice.textContent));
        assert.equal(notice.querySelector('a').getAttribute('href'), '/chat/turns/' + attempt.clientMessageId);
        act(() => notice.querySelector('button').click());
        assert.equal(view.host.contains(notice), false);
        assert.equal(view.posts.length, 1);
    });
}

for (const [sequence, bOpens, attemptC] of [
    ['B opens', true, false],
    ['B opens, C fails', true, true],
    ['B fails, C fails', false, true],
]) {
    test('New, send, ' + sequence + ' keeps the message in the new chat', async t => {
        const third = await db.createConversation('praxis', 'Third pick ' + t.name);
        const view = await fixture(t, 'create', 'response');
        const created = (await db.getActiveConversation()).id;
        const field = submitDuringSwitch(view);
        await view.pick(view.target);
        if (attemptC) {
            await view.pick(third);
            await db.deleteConversation(third.id);
        }
        if (!bOpens) await db.deleteConversation(view.target.id);
        await act(async () => { view.release.resolve(); });
        const expected = bOpens ? view.target.id : created;
        await view.until(() => view.currentId() === expected && !field.disabled);
        assert.equal((await db.getActiveConversation()).id, expected);
        assert.equal(view.posts.length, 1);
        assert.equal(view.posts[0].conversationId, created);
        const copies = (await db.getChatMessages(created)).filter(m => m.role === 'user' && m.content === message);
        assert.deepEqual(copies.map(m => m.id), [view.posts[0].clientMessageId]);
        assert.equal(view.rows('user').filter(row => row.includes(message)).length, bOpens ? 0 : 1);
        assert.equal(view.rows('assistant').some(row => row.includes('Destination history')), bOpens);
        assert.equal(view.rows('system').some(row => row.includes('Could not open')), attemptC);
    });
}

// Longer than the 80 characters the /ingest row keeps, with its end past that cut.
const longNote = 'important pasted note '.repeat(8) + 'tail of the note';
const shortNote = 'short pasted note';
const alertWith = (view, text) => [...view.host.querySelectorAll('[role="alert"]')].find(el => el.textContent.includes(text));

function heldIngest(t, outcome = () => Response.json({ error: 'Ingest unavailable' }, { status: 503 })) {
    const started = gate();
    const result = gate();
    const bodies = [];
    t.after(result.resolve);
    return {
        started, result, bodies,
        ingestPost: async body => {
            bodies.push(body);
            started.resolve();
            await result.promise;
            return outcome();
        },
    };
}

function submitIngest(view, note) {
    const field = view.host.querySelector('textarea');
    typeCharacter(field, '/ingest ' + note);
    pressKey(field, 'Enter');
    return field;
}

test('New, send /ingest, B opens, ingest fails: a notice keeps the full payload and has no turn link', async t => {
    const ingest = heldIngest(t);
    const view = await fixture(t, 'create', 'response', { ingestPost: ingest.ingestPost });
    const field = submitIngest(view, longNote);
    await view.pick(view.target);
    await act(async () => { view.release.resolve(); await ingest.started.promise; });
    await view.until(() => view.currentId() === view.target.id);
    await act(async () => { ingest.result.resolve(); });
    await view.until(() => !field.disabled);
    const notice = alertWith(view, longNote);
    t.diagnostic(JSON.stringify({ shownIsB: view.currentId() === view.target.id, draft: field.value, notice: notice?.textContent ?? null }));
    assert.equal(ingest.bodies[0].text, longNote);
    assert.ok(notice, 'the full submitted payload is on screen');
    assert.match(notice.textContent, /Ingest unavailable/);
    assert.equal(notice.querySelector('a')?.getAttribute('href') ?? null, null, 'ingest has no client turn to link to');
    act(() => notice.querySelector('button').click());
    assert.equal(view.host.contains(notice), false);
});

for (const [label, note, needsNotice] of [['long', longNote, true], ['short', shortNote, false]]) {
    test('New, send a ' + label + ' /ingest, B fails, ingest fails: the whole payload stays on screen', async t => {
        const ingest = heldIngest(t);
        const view = await fixture(t, 'create', 'response', { ingestPost: ingest.ingestPost });
        const created = (await db.getActiveConversation()).id;
        const field = submitIngest(view, note);
        await view.pick(view.target);
        await db.deleteConversation(view.target.id);
        await act(async () => { view.release.resolve(); await ingest.started.promise; });
        await view.until(() => view.currentId() === created && view.rows('system').some(row => row.includes('Could not open')));
        await act(async () => { ingest.result.resolve(); });
        await view.until(() => !field.disabled);
        const notice = alertWith(view, note);
        t.diagnostic(JSON.stringify({ rows: view.rows('user'), notice: notice?.textContent ?? null }));
        assert.equal(view.rows('system').some(row => row.includes('Ingestion failed: Ingest unavailable')), true);
        assert.equal(view.rows('user').some(row => row.includes(note)), !needsNotice);
        assert.equal(Boolean(notice), needsNotice, 'a notice appears only when the row cut the payload');
        assert.equal(view.host.textContent.includes(note), true);
    });
}

test('New, send text with files and a voice memo, B opens, POST fails: the notice names all of them', async t => {
    class FakeRecorder {
        start() {}
        stop() {
            this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }) });
            this.onstop?.();
        }
    }
    globalThis.MediaRecorder = FakeRecorder;
    Object.defineProperty(window.navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    t.after(() => { delete globalThis.MediaRecorder; delete window.navigator.mediaDevices; });
    const post = gate();
    t.after(post.resolve);
    const view = await fixture(t, 'create', 'response', {
        sendPost: async () => { await post.promise; return new Response(null, { status: 503 }); },
    });
    for (const name of ['evidence.txt', 'second.txt']) {
        const event = new window.Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { files: [new File([name], name, { type: 'text/plain' })] } });
        act(() => view.host.querySelector('.custom-scrollbar.overflow-y-auto').dispatchEvent(event));
    }
    await act(async () => { view.host.querySelector('button[title="Record voice memo"]').click(); });
    await view.until(() => view.host.querySelector('button[title="Stop recording"]'));
    await act(async () => { view.host.querySelector('button[title="Stop recording"]').click(); });
    const field = submitDuringSwitch(view);
    await view.pick(view.target);
    await act(async () => { view.release.resolve(); });
    await view.until(() => view.currentId() === view.target.id && view.posts.length === 1);
    await act(async () => { post.resolve(); });
    await view.until(() => !field.disabled);
    const notice = alertWith(view, message);
    t.diagnostic(JSON.stringify({ draft: field.value, notice: notice?.textContent ?? null }));
    assert.ok(notice, 'the failed send is reported');
    for (const part of ['evidence.txt', 'second.txt', 'Voice memo']) {
        assert.ok(notice.textContent.includes(part), 'the notice names ' + part);
    }
    assert.equal(notice.querySelector('a').getAttribute('href'), '/chat/turns/' + view.posts[0].clientMessageId);
});

// The provider reloads the chat list once a pick that is still current has settled.
const settledLists = () => globalThis.fetch.mock.calls.filter(({ arguments: [url, init] }) =>
    new URL(url, 'http://x').pathname === '/api/chat/conversations' && !init?.method).length;
// Real chat turns from earlier tests stay tracked for the page's lifetime, so match ingest rows only.
const turnLookups = () => globalThis.fetch.mock.calls.map(call => String(call.arguments[0])).filter(url => url.includes('/turns/ingest'));
const ingestRows = (view, text) => view.rows('user').filter(row => row.includes('/ingest ' + text)).length;

async function openingChat(t, view, opening) {
    if (opening === 'switch') return view.target;
    const created = await db.getActiveConversation();
    const title = 'Created ' + t.name;
    await db.updateConversationTitle(created.id, title);
    return { ...created, title };
}

async function assertIngestKept(t, view, field, chosen, note, needsNotice) {
    const notice = alertWith(view, note);
    const stored = (await db.getChatMessages(chosen.id)).filter(row => row.role === 'user');
    t.diagnostic(JSON.stringify({ shown: view.currentId(), active: (await db.getActiveConversation()).id, draft: field.value, rows: view.rows('user'), system: view.rows('system'), notice: notice?.textContent ?? null, stored: stored.length }));
    assert.equal(view.currentId(), chosen.id);
    assert.equal((await db.getActiveConversation()).id, chosen.id);
    assert.equal(view.host.textContent.includes(note), true, 'the full payload is on screen');
    assert.equal(ingestRows(view, note.slice(0, 60)), 1, 'the sent row is visible exactly once');
    assert.equal(view.rows('system').some(row => row.includes('Ingestion failed: Ingest unavailable')), true);
    assert.equal(Boolean(notice), needsNotice);
    assert.equal(notice?.querySelector('a')?.getAttribute('href') ?? null, null);
    assert.deepEqual(stored, [], 'a failed ingest is not a stored chat message');
    assert.deepEqual(turnLookups(), [], 'an ingest row is not followed as a chat turn');
}

for (const [opening, label] of [['create', 'New'], ['switch', 'Existing chat']]) {
    for (const [size, note, needsNotice] of [['short', shortNote, false], ['long', longNote, true]]) {
        test(label + ', send a ' + size + ' /ingest, pick that chat again, ingest fails: the payload stays', async t => {
            const ingest = heldIngest(t);
            const view = await fixture(t, opening, 'response', { ingestPost: ingest.ingestPost });
            const chosen = await openingChat(t, view, opening);
            const field = submitIngest(view, note);
            await view.pick(chosen);
            const before = settledLists();
            await act(async () => { view.release.resolve(); await ingest.started.promise; });
            await view.until(() => settledLists() > before && view.currentId() === chosen.id);
            assert.equal(ingestRows(view, note.slice(0, 60)), 1, 'the row survives the repeat pick while the ingest runs');
            await act(async () => { ingest.result.resolve(); });
            await view.until(() => !field.disabled);
            await assertIngestKept(t, view, field, chosen, note, needsNotice);
        });
    }
}

for (const [size, note, needsNotice] of [['short', shortNote, false], ['long', longNote, true]]) {
    test('Chat already open, send a ' + size + ' /ingest, pick that chat again, ingest fails: the payload stays', async t => {
        const ingest = heldIngest(t);
        const view = await fixture(t, 'switch', 'response', { ingestPost: ingest.ingestPost });
        const opened = settledLists();
        await act(async () => { view.release.resolve(); });
        await view.until(() => view.currentId() === view.target.id && settledLists() > opened);
        const field = submitIngest(view, note);
        await act(async () => { await ingest.started.promise; });
        await view.pick(view.target);
        const before = settledLists();
        await view.until(() => settledLists() > before);
        await act(async () => { ingest.result.resolve(); });
        await view.until(() => !field.disabled);
        await assertIngestKept(t, view, field, view.target, note, needsNotice);
    });
}

test('an /ingest failing while the repeat pick still loads keeps its payload and error in a notice', async t => {
    const ingest = heldIngest(t);
    const snapshotRead = gate();
    const releaseSnapshot = gate();
    t.after(releaseSnapshot.resolve);
    const view = await fixture(t, 'switch', 'response', { ingestPost: ingest.ingestPost });
    const field = submitIngest(view, shortNote);
    await view.pick(view.target);
    const getHistory = db.getChatMessages;
    t.mock.method(db, 'getChatMessages', async (...args) => {
        const rows = await getHistory(...args);
        snapshotRead.resolve();
        await releaseSnapshot.promise;
        return rows;
    }, { times: 1 });
    await act(async () => { view.release.resolve(); await ingest.started.promise; await snapshotRead.promise; });
    await act(async () => { ingest.result.resolve(); });
    await view.until(() => !field.disabled);
    const before = settledLists();
    await act(async () => { releaseSnapshot.resolve(); });
    await view.until(() => settledLists() > before);
    const notice = alertWith(view, shortNote);
    t.diagnostic(JSON.stringify({ rows: view.rows('user'), notice: notice?.textContent ?? null }));
    assert.ok(notice, 'the failure is reported after the snapshot replaces the transcript');
    assert.match(notice.textContent, /Ingest unavailable/);
    assert.equal(notice.querySelector('a')?.getAttribute('href') ?? null, null);
    assert.equal(ingestRows(view, shortNote), 1);
    assert.deepEqual(turnLookups(), []);
});

test('a successful /ingest across a repeat pick keeps one row and raises no notice', async t => {
    const ingest = heldIngest(t, () => Response.json({ success: true, title: 'Saved note', contentLength: 17 }));
    const view = await fixture(t, 'switch', 'response', { ingestPost: ingest.ingestPost });
    const field = submitIngest(view, shortNote);
    await view.pick(view.target);
    const before = settledLists();
    await act(async () => { view.release.resolve(); await ingest.started.promise; });
    await view.until(() => settledLists() > before);
    await act(async () => { ingest.result.resolve(); });
    await view.until(() => !field.disabled);
    assert.equal(ingestRows(view, shortNote), 1);
    assert.equal(view.rows('system').some(row => row.includes('Ingested: "Saved note"')), true);
    assert.equal(view.host.querySelectorAll('[role="alert"]').length, 0);
    assert.deepEqual(turnLookups(), []);
});
