// Deterministic generator for bridge-conversation.json — a SANITIZED
// stand-in for the live bridge conversation, so no real chat content is
// committed. Mirrors the real transcript's shape as measured on 2026-08-28
// (305 messages: 214 system / 54 assistant / 37 user, ~290 KB, 15 messages
// with markdown tables, 8 with fenced code, task-id mentions throughout).
// Regenerate with: node test/fixtures/generate-fixture.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Seeded PRNG — same output every run, so tests stay reproducible.
function mulberry32(seed) {
    return function rand() {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(20260828);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

const TOPICS = [
    "the overnight ingestion sweep", "the dispatch console refresh", "the QA correction round",
    "the schedule timeline", "the voice announcement queue", "the model routing table",
    "the token telemetry panel", "the HITL approval flow", "the skill harvest batch",
    "the workspace snapshot diff", "the presence heartbeat", "the morning status briefing",
];
const VERBS = ["completed", "dispatched", "verified", "paused", "resumed", "queued", "reviewed", "escalated"];
const sentence = () => `Praxis ${pick(VERBS)} ${pick(TOPICS)} and logged the outcome to the board.`;
const paragraph = (n) => Array.from({ length: n }, sentence).join(" ");

function mdTable() {
    const rows = Array.from({ length: 3 + Math.floor(rand() * 4) }, (_, r) =>
        `| ${pick(TOPICS)} | ${pick(VERBS)} | ${(rand() * 90 + 5).toFixed(0)}k tokens | ${r % 2 ? "✅" : "⏳"} |`);
    return ["| Item | Status | Cost | Gate |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function fence(withLang) {
    const body = [
        "const status = await board.state();",
        "if (!status.ok) throw new Error('cockpit degraded');",
        `dispatch('${pick(VERBS)}', { task: '${uuid()}' });`,
        "return summarize(status.tasks);",
    ].join("\n");
    return withLang ? "```ts\n" + body + "\n```" : "```\n" + body + "\n```";
}

function assistantBody({ table, code }) {
    const parts = [
        `**Bridge report.** ${paragraph(4 + Math.floor(rand() * 4))}`,
        `- ${sentence()}\n- ${sentence()}\n- Task ${uuid()} is next in the queue.`,
        paragraph(5 + Math.floor(rand() * 5)),
        `**Assessment.** ${paragraph(3 + Math.floor(rand() * 4))}`,
    ];
    if (table) parts.splice(1, 0, mdTable());
    if (code) parts.push(fence(rand() < 0.5));
    return parts.join("\n\n");
}

const systemCard = ({ table }) => [
    `[MORNING ROUTINE] ${sentence()}`,
    `### Watchlist\n- ${sentence()}\n- ${sentence()}`,
    table ? mdTable() : paragraph(4),
    `Next check-in scheduled — task ${uuid()} holds the gate.`,
].join("\n\n");

const systemLine = () => `${pick(["📥", "✅", "⏸️", "🔁"])} ${sentence()} (task ${uuid()})`;
const userLine = () => pick([
    `Can you walk me through ${pick(TOPICS)}?`,
    `Go ahead and prioritize ${pick(TOPICS)} this afternoon.`,
    `What happened with ${pick(TOPICS)} overnight?`,
    `Hold ${pick(TOPICS)} until I'm back at the desk.`,
]);

// Role sequence shaped like the real transcript: long runs of system events
// punctuated by user/assistant exchanges.
const roles = [];
while (roles.length < 305) {
    const burst = 2 + Math.floor(rand() * 7);
    for (let i = 0; i < burst && roles.length < 305; i++) roles.push("system");
    if (roles.length < 305) roles.push("user");
    if (roles.length < 305) roles.push("assistant");
}

// Distribute the special bodies: 15 tables, 8 fences.
const assistantIdx = roles.flatMap((r, i) => (r === "assistant" ? [i] : []));
const systemIdx = roles.flatMap((r, i) => (r === "system" ? [i] : []));
const tableAt = new Set([...assistantIdx.filter((_, k) => k % 4 === 1).slice(0, 9),
    ...systemIdx.filter((_, k) => k % 30 === 3).slice(0, 6)]);
const codeAt = new Set(assistantIdx.filter((_, k) => k % 5 === 2).slice(0, 8));

const startMs = Date.parse("2026-08-27T09:00:00Z");
const messages = roles.map((role, i) => {
    const table = tableAt.has(i);
    const code = codeAt.has(i);
    let content;
    if (role === "assistant") content = assistantBody({ table, code });
    else if (role === "user") content = userLine();
    else content = table || rand() < 0.45 ? systemCard({ table }) : systemLine();
    return {
        id: uuid(),
        role,
        content,
        created_at: new Date(startMs + i * 47_000).toISOString().replace("T", " ").slice(0, 19),
    };
});

const out = fileURLToPath(new URL("./bridge-conversation.json", import.meta.url));
fs.writeFileSync(out, JSON.stringify(messages, null, 1), "utf8");
const stats = {
    count: messages.length,
    roles: messages.reduce((a, m) => ((a[m.role] = (a[m.role] || 0) + 1), a), {}),
    withTables: messages.filter((m) => /\|\s*---/.test(m.content)).length,
    withFences: messages.filter((m) => m.content.includes("```")).length,
    bytes: messages.reduce((a, m) => a + m.content.length, 0),
};
console.log("wrote sanitized fixture:", stats);
