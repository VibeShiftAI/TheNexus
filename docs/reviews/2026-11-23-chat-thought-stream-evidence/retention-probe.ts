/**
 * The retention cases from the QA round of task eed607d4, on the current code.
 *
 * The reviewer's probe (data/tasks/eed607d4-.../evidence/reviewer-limits.ts)
 * imports the limit constants this repair removed, so it no longer loads. This
 * runs its exact inputs with those old limits as literals (240 and 2,000
 * characters, 500 steps, 64 folded turns), then the same cases at ten times the
 * size. It exits 1 if anything is lost.
 *
 *   cd ../Praxis && NODE_ENV=test npx tsx <path to this file>
 */
import { ChatTurnSteps } from "../../../../Praxis/src/chat-turn-steps.ts";
import { createTurnStepsStore } from "../../../dashboard/src/lib/chat-turn-steps.ts";

const OLD_LIMITS = { STEP_TEXT_MAX: 240, REASONING_TEXT_MAX: 2_000, MAX_STEPS_PER_TURN: 500, MAX_FOLDED_TURNS: 64 };
let lost = false;
const report = (result: Record<string, unknown>, kept: boolean) => {
  if (!kept) lost = true;
  console.log(JSON.stringify({ ...result, kept }));
};

for (const scale of [1, 10]) {
  const recorder = new ChatTurnSteps(Date.now());
  const label = `${"Review the complete change ".repeat(20 * scale)}END_OF_LABEL`;
  const reasoning = `${"Compare the evidence before deciding. ".repeat(100 * scale)}END_OF_REASONING`;
  recorder.record({ type: "tool_start", id: "long-label", name: "Bash", input: { description: label } });
  recorder.record({ type: "tool_end", id: "long-label", failed: false });
  recorder.record({ type: "reasoning", id: "reasoning", text: reasoning });
  const texts = recorder.snapshot().steps.map((step) => step.text);
  report({
    scale, labelChars: label.length, reasoningChars: reasoning.length,
    labelTailRetained: texts[0]?.endsWith("END_OF_LABEL") ?? false,
    reasoningTailRetained: texts[1]?.endsWith("END_OF_REASONING") ?? false,
  }, texts[0] === label && texts[1] === reasoning.trim());

  const extraSteps = OLD_LIMITS.MAX_STEPS_PER_TURN * scale;
  for (let i = 0; i < extraSteps; i += 1) {
    recorder.record({ type: "tool_start", id: `tool-${i}`, name: "Read", input: { file_path: `file-${i}` } });
    recorder.record({ type: "tool_end", id: `tool-${i}`, failed: false });
  }
  const snapshot = recorder.snapshot();
  report({
    scale, stepCount: snapshot.step_count, replayableSteps: snapshot.steps.length,
    omitted: snapshot.step_count - snapshot.steps.length, firstReplaySeq: snapshot.steps[0]?.seq,
  }, snapshot.step_count === extraSteps + 2 && snapshot.steps.length === extraSteps + 2 && snapshot.steps[0]?.seq === 1);

  const store = createTurnStepsStore(() => 100);
  const turns = (OLD_LIMITS.MAX_FOLDED_TURNS + 1) * scale;
  for (let i = 0; i < turns; i += 1) {
    store.begin(`t${i}`, "conversation", "Working");
    store.noteStep(`t${i}`, { id: "s1", seq: 1, kind: "tool", text: "Read a file", status: "done" });
    store.fold(`t${i}`, `reply${i}`, { duration_ms: 10 });
  }
  report({
    scale, foldedTurns: turns, storedFoldedTurns: store.getFolded().size,
    firstReplyStillExpandable: store.getFolded().has("reply0"),
  }, store.getFolded().size === turns && store.getFolded().get("reply0")?.steps.length === 1);
}

console.log(lost ? "RETENTION_PROBE lost content" : "RETENTION_PROBE ok");
process.exit(lost ? 1 : 0);
