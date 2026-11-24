// The local model part of the alias manager (task fa032fc0), mounted the way
// the Model Control page mounts it, against a fake /api/model-control. The
// options are built from a fake LM Studio listing by the server's own option
// builder (server/services/local-model-selection.js), so these tests render
// exactly what Nexus would send for that listing. Nothing here reaches a
// server: fetch is a fake that records every request, and the socket is the
// test stub (test/stubs/socket-io-client.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

import { ModelAliasManager } from "../model-alias-manager.tsx";
import { peekLiveSocket } from "../../lib/live-socket.ts";
import { formatWhen } from "../../lib/local-model.ts";

const require = createRequire(import.meta.url);
const { buildLocalModelOptions } = require("../../../../server/services/local-model-selection.js");

const GIB = 2 ** 30;
const EVENT = "model-control:local-model";

function chatModel(over) {
    return { type: "llm", loaded_instances: [], format: "gguf", quantization: { name: "Q4_K_M", bits_per_weight: 4 }, ...over };
}

// A fake LM Studio GET /api/v1/models: four chat models and an embedding model.
const LISTING = [
    chatModel({ key: "thinkingmachines/inkling-2-mini", display_name: "Inkling 2 Mini", publisher: "thinkingmachines", size_bytes: 18119934834, max_context_length: 1048576, params_string: "26.4B" }),
    chatModel({ key: "qwen/qwen3.8-27b", display_name: "Qwen3.8 27B", publisher: "qwen", size_bytes: 16081678492, max_context_length: 262144, params_string: "27B" }),
    chatModel({ key: "google/gemma-4-31b-qat", display_name: "Gemma 4 31B QAT", publisher: "google", size_bytes: 18851799617, max_context_length: 262144, params_string: "31B" }),
    chatModel({ key: "google/gemma-4-31b", display_name: "Gemma 4 31B", publisher: "google", size_bytes: 19887882864, max_context_length: 262144, params_string: "31B" }),
    { type: "embedding", key: "text-embedding-nomic-embed-text-v1.5", display_name: "Nomic Embed Text v1.5", size_bytes: 84106624, max_context_length: 2048, loaded_instances: [] },
];
// Saved load contexts: none for Qwen.
const SAVED = { "thinkingmachines/inkling-2-mini": 131072, "google/gemma-4-31b-qat": 131072, "google/gemma-4-31b": 131072 };
const TESTED = ["google/gemma-4-31b-qat", "thinkingmachines/inkling-2-mini"];
const GEMMA_QAT = { model: "google/gemma-4-31b-qat", label: "Gemma 4 31B QAT (local)", rowId: "local-gemma-4-31b" };

/** The panel Nexus sends for a listing, built with the server's own option builder. */
function panelFor({ listing = LISTING, saved = SAVED, active = GEMMA_QAT, waiting = null, praxis = { reachable: true, active: active?.model, source: "nexus", since: "2026-11-24T12:00:00.000Z", tested: TESTED }, selection = null, history = [], restore = null } = {}) {
    const { options, hidden } = buildLocalModelOptions({
        listing,
        savedContextFor: key => saved[key] ?? null,
        tested: praxis.reachable ? TESTED : null,
        active: active?.model ?? null,
        waiting: waiting?.model ?? null,
        memoryBytes: 64 * GIB,
    });
    return {
        active,
        selection,
        waiting,
        praxis,
        options,
        hidden,
        listing: { ok: true, url: "http://127.0.0.1:1234/api/v1/models" },
        restore,
        history,
        machine: { memoryBytes: 64 * GIB },
        praxisResyncSeconds: 60,
    };
}

const OPTIONS_STATE = {
    models: [{ id: "local-gemma-4-31b", name: "Gemma 4 31B QAT", provider: "local", api_model_id: "google/gemma-4-31b-qat" }],
    aliases: [{ alias: "local_default", target: "model:local-gemma-4-31b" }],
};

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

/**
 * Mount the alias manager with the local model part. `api.panel` is what
 * GET /local-model answers; `api.reply` answers a PUT/POST to /local-model.
 */
async function mount({ panel, reply = null, aliasReply = null }) {
    const original = globalThis.fetch;
    const api = { panel, reply, aliasReply, requests: [] };
    globalThis.fetch = async (url, init = {}) => {
        const method = init.method || "GET";
        const body = init.body ? JSON.parse(init.body) : undefined;
        api.requests.push({ method, url: String(url), body });
        const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
        if (String(url).startsWith("/api/model-control/options")) return json(200, OPTIONS_STATE);
        if (String(url) === "/api/model-control/local-model" && method === "GET") return json(200, api.panel);
        if (String(url).startsWith("/api/model-control/local-model") && api.reply) {
            const { status, payload } = api.reply({ method, url: String(url), body });
            return json(status, payload);
        }
        if (String(url).startsWith("/api/model-control/aliases/") && api.aliasReply) {
            const { status, payload } = api.aliasReply({ method, url: String(url), body });
            return json(status, payload);
        }
        throw new Error(`unexpected request ${method} ${url}`);
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(ModelAliasManager, { localModel: true })); });
    await settle();
    return {
        host,
        api,
        section: () => host.querySelector("[data-local-model]"),
        row: key => host.querySelector(`[data-local-model-option="${key}"]`),
        radio: key => host.querySelector(`[data-local-model-option="${key}"] input[type="radio"]`),
        button: text => [...host.querySelectorAll("button")].find(b => b.textContent.includes(text)) || null,
        waitingBox: () => host.querySelector("[data-local-model-waiting]"),
        cleanup: () => { act(() => root.unmount()); host.remove(); globalThis.fetch = original; },
    };
}

async function click(element) {
    await act(async () => { element.click(); });
    await settle();
}

async function emitEvent(reason) {
    await act(async () => { peekLiveSocket().__emit(EVENT, { reason, at: new Date().toISOString() }); });
    await settle();
}

const optionKeys = view => [...view.host.querySelectorAll("[data-local-model-option]")].map(row => row.getAttribute("data-local-model-option"));
const factsOf = view => key => view.row(key).querySelector("span.block").textContent;

test("each downloaded chat model is offered with its name, size on disk, saved context and handling; the embedding model is not offered", async () => {
    const view = await mount({ panel: panelFor() });
    try {
        assert.deepEqual(optionKeys(view), ["thinkingmachines/inkling-2-mini", "qwen/qwen3.8-27b", "google/gemma-4-31b-qat", "google/gemma-4-31b"]);
        const facts = factsOf(view);
        assert.match(view.row("google/gemma-4-31b-qat").textContent, /^Gemma 4 31B QATin effect/);
        assert.equal(facts("google/gemma-4-31b-qat"), "18.9 GB · context 131,072 (saved) · tested handling");
        assert.equal(facts("thinkingmachines/inkling-2-mini"), "18.1 GB · context 131,072 (saved) · tested handling");
        assert.equal(facts("google/gemma-4-31b"), "19.9 GB · context 131,072 (saved) · conservative defaults");
        assert.equal(facts("qwen/qwen3.8-27b"), "16.1 GB · no saved context · conservative defaults");
        assert.equal(view.radio("google/gemma-4-31b-qat").checked, true, "the model in effect starts picked");

        // The embedding model has no radio; it is listed under "Not offered" with the reason.
        assert.equal(view.radio("text-embedding-nomic-embed-text-v1.5"), null);
        const notOffered = [...view.host.querySelectorAll("details")].find(d => d.querySelector("summary").textContent.startsWith("Not offered"));
        assert.equal(notOffered.querySelector("summary").textContent, "Not offered (1)");
        assert.match(notOffered.textContent, /Nomic Embed Text v1\.5Embedding model: it makes embeddings, not chat replies\./);

        assert.equal(view.section().querySelector("[data-local-model-active]").textContent.includes("Gemma 4 31B QAT (local)google/gemma-4-31b-qat"), true);
    } finally { view.cleanup(); }
});

test("a new download appears on the next read, with no code change: Nexus's event refreshes the list", async () => {
    const view = await mount({ panel: panelFor() });
    try {
        assert.equal(view.row("mistralai/ministral-4-14b"), null);
        view.api.panel = panelFor({
            listing: [...LISTING, chatModel({ key: "mistralai/ministral-4-14b", display_name: "Ministral 4 14B", size_bytes: 8800000000, max_context_length: 131072 })],
            saved: { ...SAVED, "mistralai/ministral-4-14b": 32768 },
        });
        await emitEvent("studio-work");
        assert.equal(factsOf(view)("mistralai/ministral-4-14b"), "8.8 GB · context 32,768 (saved) · conservative defaults");
        assert.equal(view.radio("mistralai/ministral-4-14b").disabled, false);

        // Coming back to the window reads the list again too.
        view.api.panel = panelFor();
        await act(async () => { window.dispatchEvent(new window.Event("focus")); });
        await settle();
        assert.equal(view.row("mistralai/ministral-4-14b"), null);
        const reads = view.api.requests.filter(r => r.url === "/api/model-control/local-model");
        assert.equal(reads.length, 3, "one read at mount, one per event; no polling");
    } finally { view.cleanup(); }
});

test("a model with no saved load context cannot be picked, and its row says what is missing", async () => {
    const view = await mount({ panel: panelFor({ saved: { "google/gemma-4-31b-qat": 131072 } }) });
    try {
        const inkling = view.radio("thinkingmachines/inkling-2-mini");
        assert.equal(inkling.disabled, true);
        const reason = view.host.querySelector(`#${inkling.getAttribute("aria-describedby")}`);
        assert.equal(
            reason.textContent,
            "Cannot be chosen. No saved load context in LM Studio, so the context it would load with is not set. " +
            "Its maximum is 1,048,576 tokens, which can need more memory than this machine's 64 GB. " +
            "Save a context length for it in LM Studio's load settings to make it selectable.",
        );
        await click(inkling);
        assert.equal(inkling.checked, false);
        assert.equal(view.radio("google/gemma-4-31b-qat").checked, true);
        assert.equal(view.button("is in effect").disabled, true, "nothing to choose: the picked model is the one in effect");
        assert.equal(view.api.requests.some(r => r.method !== "GET"), false);
    } finally { view.cleanup(); }
});

test("choosing during a local job sends one request, loads nothing, and shows the switch waiting until Nexus reports it applied", async () => {
    const JOB = { kind: "local_job", id: "job-7", label: "Nightly transcript summaries", since: "2026-11-24T23:10:00.000Z" };
    const INKLING = { model: "thinkingmachines/inkling-2-mini", label: "Inkling 2 Mini", requestedAt: "2026-11-24T23:12:00.000Z" };
    const selection = { selectionId: "sel-1", model: INKLING.model, label: INKLING.label, action: "choose", surface: "model-control", requestedAt: INKLING.requestedAt, status: "waiting", appliedAt: null };
    const waitingPanel = panelFor({
        waiting: { ...INKLING, studio: [], praxis: [JOB] },
        selection,
        praxis: { reachable: true, active: GEMMA_QAT.model, source: "nexus", since: "2026-11-24T12:00:00.000Z", tested: TESTED, pending: { model: INKLING.model, selectionId: "sel-1", requestedAt: INKLING.requestedAt, surface: "model-control", waitingFor: [JOB], nexusWaitingFor: [], applying: false } },
        restore: { model: GEMMA_QAT.model, label: GEMMA_QAT.label, available: true, reason: null },
    });
    const view = await mount({
        panel: panelFor(),
        reply: ({ method }) => (method === "PUT"
            ? { status: 200, payload: { result: "waiting", model: INKLING.model, selectionId: "sel-1", praxisTold: true, panel: waitingPanel } }
            : { status: 500, payload: { error: "unexpected" } }),
    });
    try {
        assert.equal(view.waitingBox(), null);
        await click(view.radio(INKLING.model));
        const use = view.button("Use Inkling 2 Mini");
        assert.equal(use.disabled, false);
        await click(use);

        const writes = view.api.requests.filter(r => r.method !== "GET");
        assert.deepEqual(writes, [{ method: "PUT", url: "/api/model-control/local-model", body: { model: INKLING.model, surface: "model-control", selectionId: null } }]);

        const box = view.waitingBox();
        assert.equal(box.getAttribute("role"), "status");
        assert.match(box.textContent, /^Switch to Inkling 2 Mini is waiting/);
        assert.match(box.textContent, /Running local work keeps Gemma 4 31B QAT \(local\) until it finishes; nothing is interrupted and nothing is loaded now\./);
        assert.match(box.textContent, new RegExp(`Waiting forNightly transcript summaries \\(Praxis local job, since ${formatWhen(JOB.since)}\\)`));
        assert.match(view.row(INKLING.model).textContent, /Inkling 2 Miniwaiting/);
        assert.match(view.row(GEMMA_QAT.model).textContent, /in effect/);
        assert.match(view.section().querySelector("[data-local-model-active]").textContent, /Gemma 4 31B QAT \(local\)/);
        assert.match(view.host.querySelector('[role="status"]:not([data-local-model-waiting])').textContent, /^Chose Inkling 2 Mini\. Nothing was loaded; the switch waits until no local work runs/);
        assert.equal(view.button("is the waiting choice").disabled, true);

        // The job ends; Praxis applies the switch and Nexus tells open panels.
        view.api.panel = panelFor({
            active: { model: INKLING.model, label: "Inkling 2 Mini (local)", rowId: "local-inkling-2-mini" },
            selection: { ...selection, status: "applied", appliedAt: "2026-11-24T23:40:00.000Z" },
            restore: { model: GEMMA_QAT.model, label: GEMMA_QAT.label, available: true, reason: null },
        });
        await emitEvent("applied");
        assert.equal(view.waitingBox(), null);
        assert.match(view.section().querySelector("[data-local-model-active]").textContent, /^In effectInkling 2 Mini \(local\)thinkingmachines\/inkling-2-mini/);
        assert.match(view.row(INKLING.model).textContent, /in effect/);
        assert.equal(view.api.requests.filter(r => r.method !== "GET").length, 1, "the panel never asked for a load or anything else");
    } finally { view.cleanup(); }
});

test("each switch is listed with what changed, when and from where, and the previous choice restores in one action", async () => {
    const history = [
        { id: "s2", selection_id: "sel-2", action: "choose", from_model: "google/gemma-4-31b-qat", from_label: "Gemma 4 31B QAT (local)", to_model: "thinkingmachines/inkling-2-mini", to_label: "Inkling 2 Mini", surface: "model-control", requested_at: "2026-11-24T23:12:00.000Z", status: "applied", applied_at: "2026-11-24T23:40:00.000Z", replaced_at: null, details: { savedContext: 131072 } },
        { id: "s1", selection_id: "sel-1", action: "choose", from_model: "google/gemma-4-31b-qat", from_label: "Gemma 4 31B QAT (local)", to_model: "google/gemma-4-31b", to_label: "Gemma 4 31B", surface: "alias-editor", requested_at: "2026-11-24T22:00:00.000Z", status: "replaced", applied_at: null, replaced_at: "2026-11-24T23:12:00.000Z", details: {} },
    ];
    const inklingActive = { model: "thinkingmachines/inkling-2-mini", label: "Inkling 2 Mini (local)", rowId: "local-inkling-2-mini" };
    const selection = { selectionId: "sel-2", model: inklingActive.model, label: "Inkling 2 Mini", action: "choose", surface: "model-control", requestedAt: history[0].requested_at, status: "applied", appliedAt: history[0].applied_at };
    const restoredPanel = panelFor({ selection: { ...selection, selectionId: "sel-3", model: GEMMA_QAT.model, action: "restore", status: "applied", appliedAt: "2026-11-24T23:50:00.000Z" }, history });
    const view = await mount({
        panel: panelFor({ active: inklingActive, selection, history, restore: { model: GEMMA_QAT.model, label: "Gemma 4 31B QAT (local)", available: true, reason: null } }),
        reply: ({ method, url }) => (method === "POST" && url.endsWith("/restore")
            ? { status: 200, payload: { result: "waiting", model: GEMMA_QAT.model, selectionId: "sel-3", praxisTold: true, panel: restoredPanel } }
            : { status: 500, payload: { error: "unexpected" } }),
    });
    try {
        const log = view.host.querySelector("[data-local-model-history]");
        assert.equal(log.querySelector("summary").textContent, "Switch history (2)");
        const rows = [...log.querySelectorAll("li")].map(li => li.textContent);
        assert.deepEqual(rows, [
            `Gemma 4 31B QAT (local) → Inkling 2 MiniChosen under Model Control · ${formatWhen(history[0].requested_at)} · in effect from ${formatWhen(history[0].applied_at)}`,
            `Gemma 4 31B QAT (local) → Gemma 4 31BChosen under the alias editor · ${formatWhen(history[1].requested_at)} · replaced by a newer choice ${formatWhen(history[1].replaced_at)}`,
        ]);

        await click(view.button("Restore Gemma 4 31B QAT (local)"));
        const writes = view.api.requests.filter(r => r.method !== "GET");
        assert.deepEqual(writes, [{ method: "POST", url: "/api/model-control/local-model/restore", body: { surface: "model-control", selectionId: "sel-2" } }]);
        assert.match(view.section().querySelector("[data-local-model-active]").textContent, /Gemma 4 31B QAT \(local\)/);
        assert.match(view.host.querySelector('[role="status"]').textContent, /^Gemma 4 31B QAT \(local\) is now the local model\. Nothing was loaded/);
    } finally { view.cleanup(); }
});

test("a restore that cannot be made says why, and a choice made elsewhere in between is refused, not overwritten", async () => {
    const selection = { selectionId: "sel-2", model: "google/gemma-4-31b", label: "Gemma 4 31B", action: "choose", surface: "api", requestedAt: "2026-11-24T22:00:00.000Z", status: "applied", appliedAt: "2026-11-24T22:01:00.000Z" };
    const reason = "Qwen3.8 27B is not in LM Studio's list of downloaded models.";
    const view = await mount({
        panel: panelFor({ active: { model: "google/gemma-4-31b", label: "Gemma 4 31B (local)", rowId: "local-gemma-4-31b-2" }, selection, restore: { model: "qwen/qwen3.8-27b", label: "Qwen3.8 27B", available: false, reason } }),
        reply: () => ({ status: 409, payload: { error: "superseded", message: "Another choice was made since this panel was loaded; nothing changed.", selectionId: "sel-9" } }),
    });
    try {
        const restore = view.button("Restore Qwen3.8 27B");
        assert.equal(restore.disabled, true);
        assert.equal(view.host.querySelector(`#${restore.getAttribute("aria-describedby")}`).textContent, reason);

        await click(view.radio("thinkingmachines/inkling-2-mini"));
        const readsBefore = view.api.requests.filter(r => r.method === "GET" && r.url === "/api/model-control/local-model").length;
        await click(view.button("Use Inkling 2 Mini"));
        assert.deepEqual(view.api.requests.filter(r => r.method === "PUT").map(r => r.body), [{ model: "thinkingmachines/inkling-2-mini", surface: "model-control", selectionId: "sel-2" }]);
        assert.equal(view.host.querySelector('[role="alert"]').textContent, "Another choice was made since this panel was loaded; nothing changed.");
        assert.equal(view.api.requests.filter(r => r.method === "GET" && r.url === "/api/model-control/local-model").length, readsBefore + 1, "the panel reads the newer choice");
    } finally { view.cleanup(); }
});

test("with Praxis out of reach a waiting switch says how Praxis will pick it up", async () => {
    const view = await mount({
        panel: panelFor({
            waiting: { model: "google/gemma-4-31b", label: "Gemma 4 31B", requestedAt: "2026-11-24T22:00:00.000Z", studio: [], praxis: [] },
            praxis: { reachable: false, error: "connect ECONNREFUSED 127.0.0.1:54322" },
        }),
    });
    try {
        assert.match(view.waitingBox().textContent, /Praxis did not answer \(connect ECONNREFUSED 127\.0\.0\.1:54322\)\. It reads the setting at its start-up and every 60 s, and puts the switch into effect when no local work runs\./);
        assert.equal(factsOf(view)("google/gemma-4-31b"), "19.9 GB · context 131,072 (saved) · handling not known");
    } finally { view.cleanup(); }
});

test("the alias editor shows Nexus's sentence when it refuses a local_default target, and reads the panel again after one it records", async () => {
    let reply = { status: 422, payload: { error: "no_saved_context", message: "Qwen3.8 27B: No saved load context in LM Studio, so the context it would load with is not set." } };
    const view = await mount({ panel: panelFor(), aliasReply: () => reply });
    try {
        const alias = view.host.querySelector('input[placeholder="alias"]');
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(alias, "local_default");
            alias.dispatchEvent(new window.Event("input", { bubbles: true }));
        });
        await click(view.button("Save Alias"));
        assert.equal(view.host.querySelector(".text-red-400").textContent, "Qwen3.8 27B: No saved load context in LM Studio, so the context it would load with is not set.");

        reply = { status: 200, payload: { result: "waiting", model: "google/gemma-4-31b", selectionId: "sel-5", praxisTold: true } };
        const reads = () => view.api.requests.filter(r => r.method === "GET" && r.url === "/api/model-control/local-model").length;
        const before = reads();
        await click(view.button("Save Alias"));
        assert.equal(reads(), before + 1);
        assert.equal(view.host.querySelector(".text-red-400"), null);
    } finally { view.cleanup(); }
});
