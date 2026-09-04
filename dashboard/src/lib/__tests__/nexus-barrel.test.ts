import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as nexus from "../nexus";

const DASHBOARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const REPO = path.resolve(DASHBOARD, "..");
const BARREL = path.join(DASHBOARD, "src/lib/nexus.ts");
const TRACKED = "dashboard/src/lib/nexus.ts";

/** Names declared-and-exported by a TypeScript source, per the ticket's grammar. */
function declaredExports(source: string): Set<string> {
    return new Set(
        [...source.matchAll(/^export (?:async )?(?:function|const|type|interface) (\w+)/gm)].map((m) => m[1]),
    );
}

/**
 * The export surface lib/nexus.ts had before the P2-25 split: the newest
 * revision of the tracked file that still DECLARED its exports. Resolved by
 * walking history rather than pinning HEAD, so the assertion keeps its meaning
 * once the split itself is committed (at which point HEAD holds the barrel,
 * which declares nothing).
 */
function preSplitExports(): Set<string> {
    const revs = execFileSync("git", ["log", "--format=%H", "--", TRACKED], { cwd: REPO, encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
    for (const rev of revs) {
        const source = execFileSync("git", ["show", `${rev}:${TRACKED}`], {
            cwd: REPO,
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
        });
        const names = declaredExports(source);
        if (names.size > 0) return names;
    }
    throw new Error(`No revision of ${TRACKED} declares exports`);
}

test("the barrel re-exports exactly the pre-split export surface", () => {
    const expected = preSplitExports();
    assert.ok(expected.size > 100, `expected a large pre-split surface, got ${expected.size}`);

    // Runtime exports cover values; types are erased, so read the type
    // re-exports back off the barrel's own source.
    const barrel = readFileSync(BARREL, "utf8");
    const typeNames = [...barrel.matchAll(/^export type \{([^}]*)\} from/gm)]
        .flatMap((m) => m[1].split(",").map((n) => n.trim()))
        .filter(Boolean);

    const actual = new Set<string>([...Object.keys(nexus), ...typeNames]);

    const missing = [...expected].filter((n) => !actual.has(n)).sort();
    const extra = [...actual].filter((n) => !expected.has(n)).sort();
    assert.deepEqual(missing, [], `names lost by the split: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `names the barrel adds: ${extra.join(", ")}`);
});

test("the barrel declares nothing of its own", () => {
    const barrel = readFileSync(BARREL, "utf8");
    assert.deepEqual([...declaredExports(barrel)], []);

    for (const line of barrel.split("\n")) {
        if (!line.startsWith("export")) continue;
        assert.match(line, /^export (?:type )?\{[^}]*\} from "\.\/nexus\/[a-z-]+";$/,
            `barrel line is not a plain re-export: ${line}`);
    }
});
