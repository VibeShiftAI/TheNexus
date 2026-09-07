/**
 * Inside the Android shell the drawer must offer the native "Connection
 * settings" screen (server URL, Access token) and nowhere else — a browser
 * has no such screen. Source-level assertion in the style of
 * nav-sidebar-lars-link.test.mjs; the bridge call itself is covered by
 * mobile-shell.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../nav-sidebar.tsx", import.meta.url), "utf8");

test("the drawer shows Connection settings only when the mobile shell is present", () => {
    assert.match(source, /const mobileShell = useMobileShell\(\);/);
    assert.match(source, /\{mobileShell \? \([\s\S]*?Connection settings[\s\S]*?\) : null\}/);
    assert.match(source, /postToShell\(\{ type: "open-settings" \}\)/);
});
