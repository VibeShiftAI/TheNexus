import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CouncilBallots } from "../task-view/council-ballots.tsx";

// Fixtures mirror GET /api/dispatch-insight/task/:id `council`
// (server/services/council-ballots.js).
const source = (file) => ({ store: "praxis:data/council-sessions", file, field: "theses[].parsed", roster: "voices[]" });
const voted = (seat, decision, cue, extra = {}) => ({
  seat, model: seat, recordedAt: "2026-09-23T22:39:16.000Z", state: "voted", decision,
  rank: decision === "include" ? 4 : 0, estimatedMinutes: 45, complexity: 3, cue, ...extra,
});
const splitSession = {
  sessionId: "council-split", topic: "Morning Council day-plan vote (2026-09-23)", createdAt: "2026-09-23T22:34:46.579Z",
  phase: "complete", morningRunId: "run-2026-09-23-rs4pcfn1", source: source("council-split.json"), divergence: "dissent",
  coverage: { seats: 4, voted: 4, unavailable: 0, pending: 0, noPosition: 0 },
  positions: [
    { decision: "hold", seats: ["cli:antigravity/gemini-3.1-pro", "cli:claude-code/claude-fable-5-1"] },
    { decision: "include", seats: ["cli:codex/gpt-6-astra", "cli:claude-code/claude-opus-5"] },
  ],
  seats: [
    voted("cli:antigravity/gemini-3.1-pro", "hold", "Lacks formal acceptance criteria"),
    voted("cli:codex/gpt-6-astra", "include", "Make independent council reasoning inspectable"),
    voted("cli:claude-code/claude-opus-5", "include", "Logging each seat's load-bearing cue makes dissent visible", { rank: 8 }),
    voted("cli:claude-code/claude-fable-5-1", "hold", "Vague one-line routing note"),
  ],
};
const sameSession = {
  sessionId: "council-same", topic: "Morning Council day-plan vote (2026-09-10)", createdAt: "2026-09-10T20:43:29.849Z",
  phase: "complete", morningRunId: null, source: source("council-same.json"), divergence: "no_dissent",
  coverage: { seats: 3, voted: 3, unavailable: 0, pending: 0, noPosition: 0 },
  positions: [{ decision: "hold", seats: ["seat-a", "seat-b", "seat-c"] }],
  seats: [voted("seat-a", "hold", "Not daily-sized"), voted("seat-b", "hold", "No criteria"), voted("seat-c", "hold", "Duplicate suspicion")],
};
const partialSession = {
  sessionId: "council-partial", topic: "Morning Council day-plan vote (2026-09-17)", createdAt: "2026-09-17T19:16:51.604Z",
  phase: "complete", morningRunId: null, source: source("council-partial.json"), divergence: "no_dissent_among_reporting",
  coverage: { seats: 4, voted: 3, unavailable: 1, pending: 0, noPosition: 0 },
  positions: [{ decision: "hold", seats: ["seat-a", "seat-b", "seat-c"] }],
  seats: [
    voted("seat-a", "hold", "a"), voted("seat-b", "hold", "b"), voted("seat-c", "hold", "c"),
    { seat: "cli:antigravity/gemini-3.1-pro", model: null, recordedAt: null, state: "unavailable", detail: "Seat error: Individual quota reached." },
  ],
};
// A session read mid-deliberation: the registered roster has four voting
// seats, two ballots have landed, two seats are still running.
const pendingSeat = (seat) => ({ seat, model: seat, recordedAt: null, state: "pending", detail: "Seat is running; its ballot has not been recorded yet." });
const inflightSession = {
  sessionId: "council-inflight", topic: "Morning Council day-plan vote (2026-09-26)", createdAt: "2026-09-26T13:00:00.000Z",
  phase: "deliberation", morningRunId: "run-2026-09-26", source: source("council-inflight.json"), divergence: "no_dissent_among_reporting",
  coverage: { seats: 4, voted: 2, unavailable: 0, pending: 2, noPosition: 0 },
  positions: [{ decision: "include", seats: ["cli:codex/gpt-6-astra", "cli:claude-code/claude-opus-5"] }],
  seats: [
    voted("cli:codex/gpt-6-astra", "include", "Make independent council reasoning inspectable"),
    pendingSeat("cli:claude-code/claude-fable-5-1"),
    voted("cli:claude-code/claude-opus-5", "include", "Logging each seat's cue makes dissent visible", { rank: 8 }),
    pendingSeat("cli:antigravity/gemini-3.1-pro"),
  ],
};
const council = (sessions, extra = {}) => {
  const totals = { dissent: 0, no_dissent: 0, no_dissent_among_reporting: 0, insufficient: 0 };
  for (const s of sessions) totals[s.divergence] += 1;
  return { available: true, reason: null, sessionsDir: "/x", sessionsScanned: 202, unreadableSessions: 0, totals, totalSessions: sessions.length, sessions, ...extra };
};

async function mount(props) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(React.createElement(CouncilBallots, props)));
  return { node, dispose: async () => { await act(async () => root.unmount()); node.remove(); } };
}
async function click(el) {
  await act(async () => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
}

test("dissent opens by itself and shows both positions with each seat's cue and source", async () => {
  const { node, dispose } = await mount({ council: council([splitSession, sameSession]) });
  try {
    const text = node.textContent;
    assert.match(text, /1 with dissent/);
    assert.match(text, /Seats disagree/);
    assert.match(text, /hold: cli:antigravity\/gemini-3\.1-pro, cli:claude-code\/claude-fable-5-1/);
    assert.match(text, /include: cli:codex\/gpt-6-astra, cli:claude-code\/claude-opus-5/);
    assert.match(text, /Cue: Lacks formal acceptance criteria/);
    assert.match(text, /Cue: Logging each seat's load-bearing cue makes dissent visible/);
    assert.match(text, /rank 8/);
    assert.match(text, /Source: praxis:data\/council-sessions\/council-split\.json · theses\[\]\.parsed · roster voices\[\] · run-2026-09-23-rs4pcfn1/);
    assert.equal(node.querySelectorAll('[data-seat-state="voted"]').length, 4);
  } finally { await dispose(); }
});

test("agreement-only history fabricates neither dissent nor an endorsement", async () => {
  const { node, dispose } = await mount({ council: council([sameSession]) });
  try {
    assert.match(node.textContent, /0 with dissent/);
    assert.doesNotMatch(node.textContent, /Seats disagree/);
    // Folded by default when nothing dissented; open it and the session.
    await click(node.querySelector("button"));
    const text = node.textContent;
    assert.match(text, /No dissent recorded \(3 of 3 seats\)/);
    assert.doesNotMatch(text, /consensus|agreed|unanimous|endorse/i);
    assert.match(text, /Cue: Duplicate suspicion/);
    const chip = node.querySelector('[data-divergence="no_dissent"] span[title]');
    assert.match(chip.getAttribute("title"), /absence of dissent, not evidence the decision is right/);
  } finally { await dispose(); }
});

test("a seat without a position is shown as such, never counted toward the majority", async () => {
  const { node, dispose } = await mount({ council: council([partialSession]) });
  try {
    await click(node.querySelector("button"));
    const text = node.textContent;
    assert.match(text, /No dissent among 3 of 4 seats; 1 gave no position/);
    assert.match(text, /3 of 4 seats voted · 1 unavailable/);
    assert.match(text, /no position \(seat unavailable\)/);
    assert.match(text, /Individual quota reached/);
    assert.equal(node.querySelectorAll('[data-seat-state="unavailable"]').length, 1);
  } finally { await dispose(); }
});

test("a session still in flight shows its pending seats and never claims all seats agree", async () => {
  const { node, dispose } = await mount({ council: council([inflightSession]) });
  try {
    assert.match(node.textContent, /0 with dissent/);
    assert.match(node.textContent, /0 no dissent \(all seats\)/);
    assert.match(node.textContent, /1 no dissent among reporting seats/);
    await click(node.querySelector("button"));
    const block = node.querySelector('[data-divergence="no_dissent_among_reporting"]');
    const text = block.textContent;
    assert.match(text, /No dissent among 2 of 4 seats; 2 not yet recorded/);
    assert.match(text, /session in progress \(deliberation\)/);
    assert.match(text, /2 of 4 seats voted · 2 not yet recorded/);
    assert.doesNotMatch(text, /No dissent recorded|all seats|every seat|consensus|agreed|unanimous|endorse/i);
    assert.equal(block.querySelectorAll('[data-seat-state="pending"]').length, 2);
    assert.equal(block.querySelectorAll('[data-seat-state="voted"]').length, 2);
    assert.equal((text.match(/ballot not yet recorded/g) || []).length, 2);
    assert.match(text, /cli:claude-code\/claude-fable-5-1 · ballot not yet recordedSeat is running; its ballot has not been recorded yet\./);
    assert.match(text, /Source: praxis:data\/council-sessions\/council-inflight\.json · theses\[\]\.parsed · roster voices\[\] · run-2026-09-26/);
    const chip = block.querySelector('span[title]');
    assert.match(chip.getAttribute("title"), /has not reported yet, so dissent is not ruled out/);
    assert.match(block.querySelector("[data-session-phase]").getAttribute("title"), /ballots may still land/);
  } finally { await dispose(); }
});

test("panel and session toggles expose their expanded state and controlled content", async () => {
  const { node, dispose } = await mount({ council: council([sameSession, partialSession]) });
  try {
    const panelToggle = node.querySelector("button");
    assert.equal(panelToggle.getAttribute("aria-expanded"), "false");
    assert.ok(panelToggle.getAttribute("aria-controls"));
    await click(panelToggle);
    assert.equal(panelToggle.getAttribute("aria-expanded"), "true");
    const list = document.getElementById(panelToggle.getAttribute("aria-controls"));
    assert.ok(list, "aria-controls resolves to the rendered session list");
    assert.ok(list.querySelector('[data-divergence="no_dissent"]'));
    const [first, second] = list.querySelectorAll('[data-divergence] > button');
    assert.equal(first.getAttribute("aria-expanded"), "true");
    assert.ok(document.getElementById(first.getAttribute("aria-controls")));
    assert.equal(second.getAttribute("aria-expanded"), "false");
    await click(second);
    assert.equal(second.getAttribute("aria-expanded"), "true");
    assert.ok(document.getElementById(second.getAttribute("aria-controls")).textContent.includes("3 of 4 seats voted"));
  } finally { await dispose(); }
});

test("an unreadable store and a never-balloted task each say so instead of reading as no dissent", async () => {
  let m = await mount({ council: { available: false, reason: "Council session store unreadable (ENOENT); dissent is unknown, not absent.", sessionsDir: "/x", sessionsScanned: 0, unreadableSessions: 0, totals: null, totalSessions: 0, sessions: [] } });
  try {
    assert.ok(m.node.querySelector('[data-council="unavailable"]'));
    assert.match(m.node.textContent, /Council ballots unavailable\. .*unknown, not absent/);
  } finally { await m.dispose(); }
  m = await mount({ council: council([]) });
  try {
    assert.ok(m.node.querySelector('[data-council="none"]'));
    assert.match(m.node.textContent, /No Morning Council ballot has a row for this task \(202 session files scanned\)/);
    assert.match(m.node.textContent, /not because seats agreed/);
  } finally { await m.dispose(); }
  m = await mount({ council: undefined });
  try {
    assert.equal(m.node.innerHTML, "");
  } finally { await m.dispose(); }
});
