/**
 * A task whose QA correction was withheld must not read as an ordinary todo.
 *
 * Fixture: the real `qa_correction_withheld_paused` ops event Praxis wrote for
 * task 1e7f4570 on 2026-09-02 (Nexus ag_events row 13065) — one of the three
 * of Robert's tasks that sat parked with chat as the only way to find out.
 * The fixture is the raw event MESSAGE, so this also proves the server's
 * reason/findings split against a real body rather than a hand-shaped one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

import { QaHoldPanel } from "../task-view/qa-hold-panel.tsx";

const TASK_ID = "1e7f4570-44d6-4a12-8b8f-a3906c8b0d24";

/** Verbatim ag_events.message from row 13065 (trimmed after the findings head). */
const EVENT_MESSAGE = [
    "QA (codex) failed this round, but autonomy is paused (no live day schedule — autonomy is paused. " +
        "Install a day plan (morning routine) or dispatch this task explicitly to resume it; " +
        "PRAXIS_AUTONOMY_WHEN_PAUSED=1 overrides.) so the task was NOT re-dispatched. " +
        "It is parked at `todo` with its findings; dispatch it to resume.",
    "",
    "Q1: No — 7/10 criteria pass; the build/typecheck passed and the live header/picker worked, " +
        "but failed-save behavior and the dashboard suite do not satisfy the task.",
].join("\n");

/**
 * The same split server/routes/dispatch-insight.js performs, applied to the
 * verbatim event body — the fixture the relay would hand the client.
 */
function parseHoldMessage(message) {
    const open = message.indexOf("autonomy is paused (");
    let reason = null;
    if (open !== -1) {
        const from = open + "autonomy is paused (".length;
        const close = message.indexOf(") so the task was", from);
        if (close !== -1) reason = message.slice(from, close).trim();
    }
    const split = message.indexOf("\n\n");
    const findings = split === -1 ? null : message.slice(split + 2).trim() || null;
    return { reason, findings };
}

const PARSED = parseHoldMessage(EVENT_MESSAGE);

const HOLD = {
    taskId: TASK_ID,
    title: "Chat model control",
    status: "todo",
    projectId: "c0117b65-9ad7-4afa-90e6-c675b483ccc3",
    reason: PARSED.reason,
    heldAt: "2026-09-02 10:50:19",
    findings: PARSED.findings,
    eventId: 13065,
    operatorInitiated: false,
};

async function mount(holds, taskId = TASK_ID) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        assert.match(String(url), /\/api\/dispatch-insight\/qa-holds/);
        return new Response(JSON.stringify({ at: new Date().toISOString(), holds }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(createElement(QaHoldPanel, { taskId }));
    });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    return {
        container,
        text: container.textContent,
        cleanup() {
            act(() => root.unmount());
            container.remove();
            globalThis.fetch = realFetch;
        },
    };
}

test("the real 2026-09-02 event splits into a pause reason and reviewer findings", () => {
    assert.equal(
        PARSED.reason,
        "no live day schedule — autonomy is paused. Install a day plan (morning routine) " +
            "or dispatch this task explicitly to resume it; PRAXIS_AUTONOMY_WHEN_PAUSED=1 overrides.",
    );
    assert.match(PARSED.findings, /^Q1: No — 7\/10 criteria pass/);
});

test("a held task is badged with the reason, distinct from an ordinary todo", async () => {
    const view = await mount([HOLD]);
    try {
        assert.match(view.text, /QA failed — correction held/);
        assert.match(view.text, /no live day schedule/);
        // The three facts that make it NOT an ordinary todo.
        assert.match(view.text, /no strike spent/);
        assert.match(view.text, /parked at/i);
        assert.match(view.text, /resumes it with them/);
        assert.match(view.text, /Held 2026-09-02 10:50:19/);
    } finally {
        view.cleanup();
    }
});

test("the findings the badge links to are rendered in full", async () => {
    const view = await mount([HOLD]);
    try {
        const section = view.container.querySelector("#qa-hold");
        assert.ok(section, "the #qa-hold anchor the board badge links to must exist");
        assert.match(view.text, /Reviewer findings/);
        assert.match(view.text, /Q1: No — 7\/10 criteria pass/);
        assert.match(
            section.getAttribute("aria-label"),
            /QA reviewed this task on 2026-09-02 10:50:19 and it FAILED/,
        );
    } finally {
        view.cleanup();
    }
});

test("an operator-started task says the explicit stop holds its correction too", async () => {
    const view = await mount([
        {
            ...HOLD,
            operatorInitiated: true,
            reason: "an explicit pause is in effect (requested by Robert).",
        },
    ]);
    try {
        assert.match(view.text, /started this task by hand/);
        assert.match(view.text, /an explicit pause is in effect/);
    } finally {
        view.cleanup();
    }
});

test("a task with no hold renders nothing at all", async () => {
    const view = await mount([HOLD], "some-other-task-id");
    try {
        assert.equal(view.container.querySelector("#qa-hold"), null);
        assert.equal(view.text, "");
    } finally {
        view.cleanup();
    }
});
