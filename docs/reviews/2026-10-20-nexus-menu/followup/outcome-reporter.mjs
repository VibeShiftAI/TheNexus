/**
 * node:test reporter for attribute-suite-failures.sh (task 68909e82): one line
 * per top-level test, "<ok|not ok|skip>\t<dashboard-relative file>\t<name>",
 * sorted by file and name. TAP gives a location only for failing tests, so a
 * per-test comparison across runs needs this instead.
 *
 *   node --test --test-reporter=./outcome-reporter.mjs --test-reporter-destination=out.tsv ...
 */
export default async function* outcomes(source) {
    const rows = [];
    for await (const event of source) {
        if (event.type !== "test:pass" && event.type !== "test:fail") continue;
        const { data } = event;
        if (data.nesting !== 0) continue;
        const file = (data.file || "?").replace(/^.*?\/dashboard\//, "");
        const status = event.type === "test:fail" ? "not ok" : data.skip || data.todo ? "skip" : "ok";
        rows.push([status, file, data.name]);
    }
    rows.sort((a, b) => a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]) || a[0].localeCompare(b[0]));
    yield rows.map((r) => r.join("\t")).join("\n") + "\n";
}
