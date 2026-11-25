#!/bin/bash
# Task fa032fc0: the second half of praxis-nexus-root-check.sh. That check ran
# the two suites that load TheNexus code without setting NEXUS_DB_PATH. The
# other three (document_delivery_contract, document_revision_lifecycle,
# stakeholder-living-report) set NEXUS_DB_PATH to a temp file but not
# NEXUS_REVIEW_BLOB_DIR, and TheNexus's server/services/review-media.js keeps
# review blobs under its own data/review-blobs when that is unset. So this runs
# all five suites with NEXUS_TEST_ROOT pointed at a scratch TheNexus copy that
# has no nexus.db and lists every file written in that copy during the run,
# once with today's code and once with the code of the round-4 runs, as the
# first check did. A file written there is a file the earlier scratch runs
# wrote into the shared checkout /Volumes/Projects/TheNexus.
S=/Volumes/Projects/.scratch-fa032fc0
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
check() { # praxis-dir nexus-root tag
  local M=$S/$3.marker
  if ls $S/$2/nexus.db* >/dev/null 2>&1; then echo "$2 already has a nexus.db, stopping"; exit 1; fi
  touch $M
  NEXUS_TEST_ROOT=$S/$2 bash $S/praxis-files-guarded.sh $S/$1 $3 \
    document_delivery_contract document_revision_lifecycle stakeholder-living-report \
    document_replacement_retirement scope_change_gate | sed 1d
  echo "files written under $2 during the run (node_modules left out): $(find $S/$2 -newer $M -type f ! -path '*/node_modules/*' | wc -l | tr -d ' ')"
  find $S/$2 -newer $M -type f ! -path '*/node_modules/*' | sed "s#^$S/##" | head -20
  echo "nexus.db files there: $(ls $S/$2/nexus.db* 2>/dev/null | wc -l | tr -d ' '); data/review-blobs entries there: $(find $S/$2/data/review-blobs -type f 2>/dev/null | wc -l | tr -d ' ')"
  rm -f $M
}
echo "== today's code: merged-praxis8 with merged-nexus6"
check merged-praxis8 merged-nexus6 nexus-root-five-today
echo "== the round-4 code: plain-praxis-main4 with merged-main4"
check plain-praxis-main4 merged-main4 nexus-root-five-round4
echo "== done"
