#!/bin/bash
# Task fa032fc0: Praxis suites that load TheNexus code find it through
# tests/fixtures/nexus-require.ts: NEXUS_TEST_ROOT, else a sibling ../TheNexus,
# else /Volumes/Projects/TheNexus. A scratch copy has no sibling, so in every
# merged and plain-main check these suites loaded the code of the shared
# checkout. Three of them set NEXUS_DB_PATH to a temp file before they load
# ./db. The other two (document_replacement_retirement, scope_change_gate) never
# set it, and TheNexus's db/index.js opens ../nexus.db when it is loaded without
# NEXUS_DB_PATH. This checks that those two never load it: it runs them with
# NEXUS_TEST_ROOT pointed at a scratch TheNexus copy that has no nexus.db and
# lists every file written in that copy during the run. Once with today's code
# (main 519530a9 merged with the branch; TheNexus a2870083 plus the branch) and
# once with the code of the round-4 runs (plain 4d076f91; TheNexus 3189bb99 plus
# the branch).
S=/Volumes/Projects/.scratch-fa032fc0
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "== which TheNexus a scratch copy loads"
(cd $S/merged-praxis8 && npx tsx -e "import('./tests/fixtures/nexus-require.ts').then(m => console.log('without NEXUS_TEST_ROOT:', m.requireNexus.resolve('./db')))")
(cd $S/merged-praxis8 && NEXUS_TEST_ROOT=$S/merged-nexus6 npx tsx -e "import('./tests/fixtures/nexus-require.ts').then(m => console.log('with NEXUS_TEST_ROOT:', m.requireNexus.resolve('./db')))")
echo "== suites that load TheNexus code, and how many lines set NEXUS_DB_PATH in each"
for f in $(grep -lE "requireNexus\(" $S/merged-praxis8/tests/*.ts); do
  echo "$(basename $f): $(grep -oE "requireNexus\(['\"][^'\"]+['\"]\)" $f | sort -u | tr '\n' ' ')| NEXUS_DB_PATH set: $(grep -cE 'NEXUS_DB_PATH *=' $f)"
done
check() { # praxis-dir nexus-root tag
  local M=$S/$3.marker
  if ls $S/$2/nexus.db* >/dev/null 2>&1; then echo "$2 already has a nexus.db, stopping"; exit 1; fi
  touch $M
  NEXUS_TEST_ROOT=$S/$2 bash $S/praxis-files-guarded.sh $S/$1 $3 document_replacement_retirement scope_change_gate | sed 1d
  echo "files written under $2 during the run: $(find $S/$2 -newer $M -type f ! -path '*/node_modules/*' | wc -l | tr -d ' '); nexus.db files there: $(ls $S/$2/nexus.db* 2>/dev/null | wc -l | tr -d ' ')"
  rm -f $M
}
echo "== today's code: merged-praxis8 with merged-nexus6"
check merged-praxis8 merged-nexus6 nexus-root-today
echo "== the round-4 code: plain-praxis-main4 with merged-main4"
check plain-praxis-main4 merged-main4 nexus-root-round4
echo "== done"
