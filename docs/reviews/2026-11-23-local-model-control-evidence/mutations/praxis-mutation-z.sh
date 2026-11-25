#!/bin/bash
# Task fa032fc0, Praxis round 4: tests/quantized_tool_gate.test.ts now makes the
# breached model the local model in effect (config.localLlmModel), because a
# local primary runs the Model Control setting (src/llm/manager.ts primaryModel).
# Mutation Z removes the quantized tool gate from chat()'s primary attempts, to
# show the updated test still fails when a breached local primary is not skipped.
# Scratch copy: git archive HEAD (cad6afb2, nothing uncommitted), outside every repository.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
D=$S/praxis-mut-z
mkdir -p "$D" && [ -z "$(ls -A "$D")" ] || { echo "$D is not empty, stopping"; exit 1; }
git -C $P archive HEAD | tar -x -C "$D"
git -C $P diff --binary > $S/praxis-wip-r4z.patch
if [ -s $S/praxis-wip-r4z.patch ]; then (cd "$D" && git apply --whitespace=nowarn $S/praxis-wip-r4z.patch) || { echo "apply failed"; exit 1; }; fi
echo "copy: HEAD $(git -C $P rev-parse --short HEAD) plus $(grep -c '^diff --git' $S/praxis-wip-r4z.patch) changed files"
ln -s $P/node_modules "$D/node_modules"
F=$D/src/llm/manager.ts
cp "$F" "$F.orig"
perl -0pi -e 's/          enforceQuantizedToolGate\(\{\n            provider: this\.activeProvider,\n            model: targetModel,/          void ({\n            provider: this.activeProvider,\n            model: targetModel,/' "$F"
if cmp -s "$F" "$F.orig"; then echo "== mutation Z: NOT APPLIED"; exit 1; fi
echo "== mutation Z (src/llm/manager.ts): applied"; diff "$F.orig" "$F" | sed 's/^/   /'
bash $S/praxis-files-guarded.sh "$D" mutation-z quantized_tool_gate
mv "$F.orig" "$F"
bash $S/praxis-files-guarded.sh "$D" mutation-z-restored quantized_tool_gate
