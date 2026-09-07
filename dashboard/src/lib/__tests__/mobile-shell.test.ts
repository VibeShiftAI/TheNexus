import test from "node:test";
import assert from "node:assert/strict";

import { getMobileShell, postToShell, sanitizeShellPath, currentShellPath } from "../mobile-shell.ts";

function installShell(origin = window.location.origin) {
  const sent: string[] = [];
  window.__NEXUS_MOBILE_SHELL__ = Object.freeze({
    platform: "android",
    appVersion: "0.6.0",
    origin,
    capabilities: ["navigate", "badge"],
    navigateEvent: "nexus-mobile-navigate",
  });
  window.ReactNativeWebView = { postMessage: (data: string) => sent.push(data) };
  return sent;
}

function uninstallShell() {
  delete window.__NEXUS_MOBILE_SHELL__;
  delete window.ReactNativeWebView;
}

test("outside the shell nothing is detected and sends are no-ops", () => {
  uninstallShell();
  assert.equal(getMobileShell(), null);
  assert.equal(postToShell({ type: "open-settings" }), false);
});

test("inside the shell on its own origin messages are serialised to the native side", () => {
  const sent = installShell();
  try {
    assert.equal(getMobileShell()?.appVersion, "0.6.0");
    assert.equal(postToShell({ type: "badge", count: 3 }), true);
    assert.deepEqual(JSON.parse(sent[0]), { type: "badge", count: 3 });
  } finally {
    uninstallShell();
  }
});

test("a shell descriptor for another origin, or without the native channel, is ignored", () => {
  installShell("https://somewhere.else");
  try {
    assert.equal(getMobileShell(), null);
  } finally {
    uninstallShell();
  }
  installShell();
  delete window.ReactNativeWebView;
  try {
    assert.equal(getMobileShell(), null);
    assert.equal(postToShell({ type: "reload" }), false);
  } finally {
    uninstallShell();
  }
});

test("sanitizeShellPath keeps same-origin paths and rejects origin escapes", () => {
  assert.equal(sanitizeShellPath("/inbox#h1"), "/inbox#h1");
  assert.equal(sanitizeShellPath(" /activity?channel=vault "), "/activity?channel=vault");
  for (const bad of ["https://evil.example/", "//evil.example", "/\\evil", "/x\nY", "inbox", "/javascript:alert(1)", 42, null, `/${"a".repeat(3000)}`]) {
    assert.equal(sanitizeShellPath(bad), null, `should reject ${String(bad).slice(0, 30)}`);
  }
});

test("currentShellPath reports path, query and hash", () => {
  window.history.replaceState(null, "", "/task/abc?tab=qa#notes");
  try {
    assert.equal(currentShellPath(), "/task/abc?tab=qa#notes");
  } finally {
    window.history.replaceState(null, "", "/");
  }
});
