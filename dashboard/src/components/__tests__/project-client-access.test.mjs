/**
 * The Client Access panel renders a project's entitlements, published
 * versions and client decisions from GET /api/projects/:id/client-access,
 * and reports an unavailable API instead of pretending nothing is granted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { ProjectClientAccess } from "../project-client-access.tsx";

const PROJECT = "05d25bcc-5dea-4720-8a08-e49ccecf0fa5";
const MEMBER = { id: "cb182cba-5d14-4c71-b0a8-eaee91edf359", name: "Joey Lautrup", email: "jlautrup01@gmail.com" };
const ACCEPT = {
  id: "rev-accept", client_decision_id: "portal-1", member: MEMBER, artifact_id: "art-1",
  version_hash: "a".repeat(64), decision: "accept", body: "", created_at: "2026-10-02T15:00:00.000Z",
  evidence_ref: "nexus:client-review:rev-accept",
};
const COMMENT = { ...ACCEPT, id: "rev-comment", client_decision_id: "portal-0", decision: "comment", body: "Colors are off.", created_at: "2026-10-02T14:30:00.000Z", evidence_ref: "nexus:client-review:rev-comment" };
const SUMMARY = {
  project_id: PROJECT,
  scope: "client_project",
  entitlements: [
    {
      id: "ent-old", member_id: MEMBER.id, project_id: PROJECT, scope: "client_project", member_snapshot: MEMBER,
      granted_by: "robert", authority: "operator_credential", source: null, note: null, granted_at: "2026-10-01T12:00:00.000Z",
      state: "revoked", revoked: { at: "2026-10-01T18:00:00.000Z", reason: "Engagement paused", by: "robert", authority: "operator_credential" },
      member: { ...MEMBER, status: "active" }, access: "revoked",
    },
    {
      id: "ent-live", member_id: MEMBER.id, project_id: PROJECT, scope: "client_project", member_snapshot: MEMBER,
      granted_by: "operator_local:robertwashko", authority: "operator_local",
      source: "/Volumes/Projects/shared-mind/memories/feedback_joey_lautrup_client_workflow_2026-10-02.md", note: null,
      granted_at: "2026-10-02T13:00:00.000Z", state: "active", revoked: null, member: { ...MEMBER, status: "active" }, access: "granted",
    },
  ],
  artifacts: [
    {
      id: "art-1", kind: "preview", title: "Prototype preview", version: "build-7", version_hash: "a".repeat(64),
      url: "https://preview.example.invalid/build-7", state: "current", published_by: "runtime", published_at: "2026-10-02T14:00:00.000Z",
      reviews: [COMMENT, ACCEPT], accepted: [ACCEPT],
    },
  ],
  reviews: [COMMENT, ACCEPT],
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function mount(handler) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => { requests.push([String(url), options]); return handler(String(url), options); };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(React.createElement(ProjectClientAccess, { projectId: PROJECT })));
  return { node, requests, dispose: async () => { await act(async () => root.unmount()); node.remove(); globalThis.fetch = original; } };
}

test("renders entitlements with their live access, published versions and client decisions", async () => {
  const h = await mount(async () => json(SUMMARY));
  try {
    assert.ok(h.requests[0][0].includes(`/api/projects/${PROJECT}/client-access`), "reads the project-scoped cockpit summary");
    const text = h.node.textContent;
    assert.match(text, /1 member has project-scoped client access/);
    assert.match(text, /Joey Lautrup/);
    assert.match(text, /jlautrup01@gmail.com/);
    assert.match(text, /access granted/);
    assert.match(text, /revoked 2026-10-01 18:00 UTC: Engagement paused/);
    assert.match(text, /feedback_joey_lautrup_client_workflow_2026-10-02\.md/);
    assert.match(text, /Prototype preview/);
    assert.match(text, /preview · build-7/);
    assert.match(text, /accepted by Joey Lautrup/);
    assert.match(text, /Accepted/);
    assert.match(text, /Changes requested|Comment/);
    assert.match(text, /Colors are off\./);
    assert.match(text, /nexus:client-review:rev-accept/);
    assert.match(text, /decision-maker flag alone grants nothing/);
    assert.equal(h.node.querySelector('[data-entitlement="ent-live"]').getAttribute("data-access"), "granted");
    assert.equal(h.node.querySelector('[data-entitlement="ent-old"]').getAttribute("data-access"), "revoked");
    assert.equal(h.node.querySelector('[data-review="rev-accept"]').getAttribute("data-decision"), "accept");
    assert.equal(h.node.querySelector('a[href="https://preview.example.invalid/build-7"]').getAttribute("rel"), "noreferrer");
    // Newest decision first.
    const order = [...h.node.querySelectorAll("[data-review]")].map((el) => el.getAttribute("data-review"));
    assert.deepEqual(order, ["rev-accept", "rev-comment"]);
  } finally {
    await h.dispose();
  }
});

test("an empty ledger and an unavailable API are both stated plainly", async () => {
  const empty = await mount(async () => json({ project_id: PROJECT, scope: "client_project", entitlements: [], artifacts: [], reviews: [] }));
  try {
    assert.match(empty.node.textContent, /0 members have project-scoped client access/);
    assert.match(empty.node.textContent, /No client entitlements recorded/);
    assert.equal(empty.node.querySelectorAll("[data-artifact]").length, 0);
  } finally {
    await empty.dispose();
  }
  const down = await mount(async () => json({ error: "Not found" }, 404));
  try {
    assert.match(down.node.textContent, /Client access API unavailable \(404\)/);
    assert.doesNotMatch(down.node.textContent, /No client entitlements recorded/);
  } finally {
    await down.dispose();
  }
});
