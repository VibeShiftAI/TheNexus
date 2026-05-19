import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

test("project workflows render pending approval controls", () => {
  const component = fs.readFileSync(path.join(root, "src/components/project-workflows.tsx"), "utf-8");
  const api = fs.readFileSync(path.join(root, "src/lib/nexus.ts"), "utf-8");
  const routePath = path.join(root, "src/app/project/[id]/workflows/[workflowId]/approval-artifact/page.tsx");

  assert.ok(component.includes("pending_approval"), "component should read pending approval from supervisor details");
  assert.ok(component.includes("Approve"), "component should render an approve action");
  assert.ok(component.includes("Request Revision"), "component should render a revision action");
  assert.ok(component.includes("approval-artifact"), "component should link to the full approval artifact route");
  assert.ok(component.includes('target="_blank"'), "artifact link should open in a new tab or window");
  assert.ok(component.includes("resumeProjectWorkflowApproval"), "component should call the resume approval API");
  assert.ok(component.includes("output ready"), "component should show completed workflow output");
  assert.ok(component.includes("video_path"), "component should read the final video path");
  assert.ok(api.includes("resumeProjectWorkflowApproval"), "nexus API should expose project workflow approval resume");
  assert.ok(fs.existsSync(routePath), "dashboard should include a full-page approval artifact route");
});
