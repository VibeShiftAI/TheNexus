#!/bin/bash
# Task fa032fc0: praxis-merged-main6.sh archived "main" twice, and Praxis main
# fast-forwarded from 613f66b6 to 3b431d2b at 14:31:18 between the two calls, so
# its plain copy was 3b431d2b (two more files: src/telemetry/step-redaction.ts
# and tests/run_record_redaction.test.ts, which the branch does not touch). This
# rebuilds the plain copy from 613f66b6 by its full hash, checks it file by file
# against that tree, and reruns the two suites that failed on the merged tree,
# under the same guards.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
REV=$(git -C $P rev-parse 613f66b6^{commit}) || exit 1
D=$S/plain-praxis-main6
mkdir -p "$D" || exit 1
[ -z "$(ls -A "$D")" ] || { echo "plain-praxis-main6 is not empty, stopping"; exit 1; }
git -C $P archive "$REV" | tar -x -C "$D" || { echo "archive failed"; exit 1; }
ln -s $P/node_modules "$D/node_modules"
echo "== plain copy of $REV"
T=$(mktemp)
git -C $P ls-tree -r "$REV" -- src tests scripts package.json | awk -F'\t' '{split($1,a," "); print a[3]"\t"$2}' > "$T"
echo "tracked files compared: $(wc -l < "$T" | tr -d ' '), differ: $(paste <(cut -f1 "$T") <(cut -f2 "$T" | (cd "$D" && git hash-object --no-filters --stdin-paths)) | awk '$1!=$2' | wc -l | tr -d ' '), extra: $(cd "$D" && find src tests scripts -type f | sort | comm -23 - <(cut -f2 "$T" | sort) | wc -l | tr -d ' ')"
rm -f "$T"
bash $S/praxis-files-guarded.sh "$D" plain6-failing code_freshness_recovery webhook_routes_inventory
echo "== done"
