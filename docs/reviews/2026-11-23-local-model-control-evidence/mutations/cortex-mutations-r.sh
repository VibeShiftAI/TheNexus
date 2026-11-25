#!/bin/bash
# TheCortex mutations R1-R4 of the one-read-at-a-time Nexus read in
# cortex/local_model.py (TheCortex 892708c8): each takes one part of it out of a
# scratch copy of that commit and runs tests/test_local_model_setting.py under the
# offline guards of cortex-tests.sh (every service URL on port 1, the
# offline_network_guard plugin, no pytest cache, no bytecode written). The diff
# each mutation made is printed before its result.
#   R1: a caller sends its read while another is in flight (no waiting at all)
#   R2: a waiting caller takes the answer of a read that started before it asked
#   R3: a read that raises leaves the in-flight mark set and wakes no one
#   R4: a waiting caller sends its own read even when one it can share came back
S=/Volumes/Projects/.scratch-fa032fc0
CW=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheCortex
COMMIT=892708c8df06133e9b545962ac82575ec7eea9c0
M=$S/cortex-mut-r
rm -rf "$M" && mkdir -p "$M"
git -C $CW archive $COMMIT TheCortex | tar -x -C "$M" || { echo "archive failed"; exit 1; }
ln -s $CW/TheCortex/.env "$M/TheCortex/.env"
F="$M/TheCortex/python/cortex/local_model.py"
cp "$F" "$S/cortex-local-model-892708c8.py"
echo "TheCortex under test: $COMMIT (scratch copy $M)"

run() { # name
  local name=$1
  cp "$S/cortex-local-model-892708c8.py" "$F"
  if [ "$name" != control ]; then
    /usr/bin/python3 - "$F" "$name" <<'PY' || return
import sys
path, name = sys.argv[1], sys.argv[2]
MUTATIONS = {
    "r1": (
        "        while _read_in_flight:\n"
        "            _lock.wait()\n"
        "            if _read_returned > asked_after:\n"
        "                # A read that started after this call asked has come back.\n"
        "                return _returned\n",
        "",
    ),
    "r2": (
        "            if _read_returned > asked_after:\n",
        "            if _read_returned >= asked_after:\n",
    ),
    "r3": (
        "    try:\n"
        "        result = local_model_in_effect()\n"
        "    finally:\n",
        "    if True:\n"
        "        result = local_model_in_effect()\n"
        "    if True:\n",
    ),
    "r4": (
        "                return _returned\n",
        "                pass\n",
    ),
}
old, new = MUTATIONS[name]
src = open(path, encoding="utf-8").read()
count = src.count(old)
if count != 1:
    print(f"   NOT APPLIED: the text to replace occurs {count} times")
    sys.exit(1)
open(path, "w", encoding="utf-8").write(src.replace(old, new))
PY
    diff -u "$S/cortex-local-model-892708c8.py" "$F" | tail -n +3 | sed 's/^/   local_model.py /'
  fi
  bash $S/cortex-tests.sh "$M/TheCortex" $S/cortex-mutation-r-$name.txt -vv tests/test_local_model_setting.py
  echo "   result: $(grep -E "^[=]+ .*(passed|failed).* [=]+$|^exit=" $S/cortex-mutation-r-$name.txt | tr '\n' ' ')"
  grep -E "^FAILED " $S/cortex-mutation-r-$name.txt | sed 's/ - .*//' | sed 's/^/   /'
}

for name in control r1 r2 r3 r4; do
  case $name in
    control) echo "== control: no mutation" ;;
    r1) echo "== R1: a caller sends its read while another is in flight" ;;
    r2) echo "== R2: a waiting caller takes the answer of a read that started before it asked" ;;
    r3) echo "== R3: a read that raises leaves the in-flight mark set and wakes no one" ;;
    r4) echo "== R4: a waiting caller sends its own read even when one it can share came back" ;;
  esac
  run $name
done
cp "$S/cortex-local-model-892708c8.py" "$F"
echo "== scratch copy left at $M for inspection; deleted with the scratch folder"
