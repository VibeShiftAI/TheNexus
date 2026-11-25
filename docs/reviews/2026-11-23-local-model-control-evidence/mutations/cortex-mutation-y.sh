#!/bin/bash
# Task fa032fc0, TheCortex mutation Y: undo the read-order guard in
# cortex/local_model.py (an answer is kept whatever order its read started in)
# in a scratch copy of the working tree, and run test_local_model_setting.py
# with the same offline guards. The race test should fail, and only it.
S=/Volumes/Projects/.scratch-fa032fc0
CW=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheCortex
M=$S/cortex-mutation-y
mkdir -p "$M" || exit 1
[ -z "$(ls -A "$M")" ] || { echo "cortex-mutation-y is not empty, stopping"; exit 1; }
git -C $CW archive HEAD TheCortex | tar -x -C "$M" || { echo "archive failed"; exit 1; }
cp $CW/TheCortex/python/cortex/local_model.py "$M/TheCortex/python/cortex/local_model.py"
cp $CW/TheCortex/tests/test_local_model_setting.py "$M/TheCortex/tests/test_local_model_setting.py"
ln -s $CW/TheCortex/.env "$M/TheCortex/.env"
F="$M/TheCortex/python/cortex/local_model.py"
/usr/bin/python3 - "$F" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
old = ("            if read > _last_answer_read:\n"
       "                _last_answer, _last_answer_read = model, read\n")
new = "            _last_answer, _last_answer_read = model, read\n"
assert src.count(old) == 1, "guard not found exactly once"
open(path, "w", encoding="utf-8").write(src.replace(old, new))
print("mutation Y applied: the read-order guard is gone")
PY
diff -u $CW/TheCortex/python/cortex/local_model.py "$F"
bash $S/cortex-tests.sh "$M/TheCortex" $S/cortex-mutation-y.txt -vv tests/test_local_model_setting.py
grep -E "FAILED|passed|failed|exit=" $S/cortex-mutation-y.txt | cut -c1-200
grep -nE "^E +assert|^E +AssertionError" $S/cortex-mutation-y.txt | head -5
