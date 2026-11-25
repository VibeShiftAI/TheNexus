#!/bin/bash
# Mutations H (choosing makes or reactivates the row again) and I (the old local_default guard),
# each in its own scratch copy of the TheNexus branch tree.
S=/Volumes/Projects/.scratch-fa032fc0
N=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus
for m in h i; do
  D=$S/nexus-mut-$m
  rm -rf "$D" && mkdir -p "$D"
  git -C $N archive HEAD | tar -x -C "$D"
  git -C $N diff --binary > $S/nexus-wip.patch
  (cd "$D" && git apply --whitespace=nowarn $S/nexus-wip.patch) || { echo "apply failed"; exit 1; }
  ln -s $N/node_modules "$D/node_modules"
  if [ $m = h ]; then
    F="$D/server/services/local-model-selection.js"
    perl -0pi -e 's/const known = await findLocalModelRow\(row\.key\);/const known = await ensureLocalModelRow({ key: row.key, label, reasoning: !!row.capabilities?.reasoning });/' "$F"
    echo "== mutation h: $(grep -c 'const known = await ensureLocalModelRow' "$F") mutated line(s)"
  else
    F="$D/server/routes/model-control.js"
    perl -0pi -e 's/if \(!\(body\.is_active === undefined \|\| body\.is_active === true \|\| body\.is_active === 1\)\) \{/if (body.is_active === false || body.is_active === 0) {/; s/        if \(!target\) \{\n            return \{ status: 400, body: \{ error: .local_default_target., message: `\$\{LOCAL_ALIAS\} must name[^\n]*\n        \}\n//; s/if \(target === existing\?\.target\) return null;/if (!target || target === existing?.target) return null;/; s/target = req\.body\.target\.trim\(\);/target = req.body.target;/' "$F"
    echo "== mutation i: old guard lines $(grep -c 'body.is_active === false || body.is_active === 0' "$F"), new refusal left $(grep -c 'must name the local model' "$F")"
  fi
  rm -f $S/net-guard-mut-nx.log
  (cd "$D" && env -u YOUTUBE_API_KEY -u GOOGLE_API_KEY NET_GUARD_LOG=$S/net-guard-mut-nx.log NODE_OPTIONS="--import=file://$S/net-guard.mjs" npx jest server/__tests__/local-model-selection.test.js --cacheDirectory $S/jest-cache-mut > $S/nexus-mutation-$m.txt 2>&1; echo "exit $?" >> $S/nexus-mutation-$m.txt)
  grep -E "^Tests:|^exit" $S/nexus-mutation-$m.txt
  grep -E "✕" $S/nexus-mutation-$m.txt | head -6
  echo "net refusals: $(cat $S/net-guard-mut-nx.log 2>/dev/null | wc -l)"
done
