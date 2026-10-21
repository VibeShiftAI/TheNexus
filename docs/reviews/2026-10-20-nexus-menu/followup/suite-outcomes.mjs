#!/usr/bin/env node
/**
 * Helpers for attribute-suite-failures.sh (task 68909e82).
 *
 *   node suite-outcomes.mjs failures <run.tap>             the totals and the TAP block of every failing test
 *   node suite-outcomes.mjs compare <label>=<outcomes>...  Markdown: totals, failures per run, and every
 *                                                          test whose status differs between runs
 *
 * Outcomes files come from outcome-reporter.mjs. Tests are keyed by file and
 * name, not line, so a test that moved inside its file still matches.
 */
import { readFileSync } from "node:fs";

function failures(tapPath) {
    const lines = readFileSync(tapPath, "utf8").split("\n");
    const totals = Object.fromEntries(lines.filter((l) => /^# (tests|pass|fail|cancelled|skipped|todo) \d+$/.test(l)).map((l) => l.slice(2).split(" ")).map(([k, v]) => [k, Number(v)]));
    const out = [`# ${JSON.stringify(totals)}`];
    for (let i = 0; i < lines.length; i++) {
        if (!/^not ok \d+ - /.test(lines[i])) continue;
        const block = [lines[i]];
        let file = "?";
        for (let j = i + 1; j < lines.length && !/^(ok|not ok) \d+ - |^# Subtest: |^1\.\.\d+$/.test(lines[j]); j++) {
            block.push(lines[j]);
            const loc = /^ {2}location: '.*?\/dashboard\/(.+?):\d+:\d+'$/.exec(lines[j]);
            if (loc) file = loc[1];
        }
        out.push("", `# ${file}`, ...block);
    }
    return out.join("\n") + "\n";
}

// Same-named tests in one file collapse into one key whose status lists each run of it.
function readOutcomes(path) {
    const map = new Map();
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        const [status, file, ...name] = line.split("\t");
        const key = `${file} :: ${name.join("\t")}`;
        map.set(key, map.has(key) ? [map.get(key), status].sort().join(",") : status);
    }
    return map;
}

function compare(args) {
    const runs = args.map((a) => { const i = a.indexOf("="); return { label: a.slice(0, i), map: readOutcomes(a.slice(i + 1)) }; });
    const count = (r, s) => [...r.map.values()].flatMap((v) => v.split(",")).filter((x) => x === s).length;
    const out = ["| Run | Tests | Pass | Fail | Skip |", "| --- | --- | --- | --- | --- |"];
    for (const r of runs) out.push(`| ${r.label} | ${["ok", "not ok", "skip"].reduce((n, s) => n + count(r, s), 0)} | ${count(r, "ok")} | ${count(r, "not ok")} | ${count(r, "skip")} |`);
    for (const r of runs) {
        const failing = [...r.map].filter(([, s]) => s.includes("not ok")).map(([k]) => k);
        out.push("", `Failing in ${r.label} (${failing.length}):`, ...failing.map((f) => `- ${f}`));
    }
    const keys = [...new Set(runs.flatMap((r) => [...r.map.keys()]))].sort();
    const changed = [];
    const partial = [];
    for (const k of keys) {
        const statuses = runs.map((r) => r.map.get(k) ?? "absent");
        const present = statuses.filter((s) => s !== "absent");
        if (new Set(present).size > 1) changed.push([k, statuses]);
        else if (present.length !== runs.length && present.some((s) => s.includes("not ok"))) partial.push([k, statuses]);
    }
    const table = (rows) => [`| Test | ${runs.map((r) => r.label).join(" | ")} |`, `| --- | ${runs.map(() => "---").join(" | ")} |`, ...rows.map(([k, s]) => `| ${k} | ${s.join(" | ")} |`)];
    out.push("", `Tests whose status differs between runs where they exist (${changed.length}):`);
    if (changed.length) out.push("", ...table(changed));
    out.push("", `Failing tests that exist in only some runs (${partial.length}):`);
    if (partial.length) out.push("", ...table(partial));
    for (let i = 1; i < runs.length; i++) {
        const only = [...runs[i].map.keys()].filter((k) => !runs[0].map.has(k)).length;
        const gone = [...runs[0].map.keys()].filter((k) => !runs[i].map.has(k)).length;
        out.push("", `${runs[i].label} vs ${runs[0].label}: ${only} tests only in ${runs[i].label}, ${gone} only in ${runs[0].label}.`);
    }
    return out.join("\n") + "\n";
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "failures") process.stdout.write(failures(args[0]));
else if (mode === "compare") process.stdout.write(compare(args));
else {
    console.error("usage: suite-outcomes.mjs failures <run.tap> | compare <label>=<outcomes>...");
    process.exit(2);
}
