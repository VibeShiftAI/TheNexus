#!/bin/bash
# Task fa032fc0: the final encoding and em-dash scans of every file this task
# changed, in all three repositories. Reads only. Writes praxis-encoding-scan.txt
# (Praxis's own check) and encoding-and-dash-scans.txt beside this script.
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
N=$W/TheNexus; P=$W/Praxis; C=$W/TheCortex
E=$N/docs/reviews/2026-11-23-local-model-control-evidence
EV=docs/reviews/2026-11-23-local-model-control-evidence
NB=bd02642895fe6a914fe04e45af35bee773f3453e; PB=1fcf4b59; CB=5fdb76a

# UTF-8 scan: fatal TextDecoder, plus BOM and U+FFFD, per file; PNGs are skipped.
utf8_scan() { # <repo dir> <files...>
  local dir="$1"; shift
  (cd "$dir" && node -e '
const fs = require("fs");
const d = new TextDecoder("utf-8", { fatal: true });
let bad = 0, n = 0;
for (const f of process.argv.slice(1)) {
  if (/\.png$/i.test(f)) continue;
  n++;
  try {
    const t = d.decode(fs.readFileSync(f));
    if (t.charCodeAt(0) === 0xFEFF) { console.log("BOM", f); bad++; }
    if (t.includes(String.fromCharCode(0xFFFD))) { console.log("U+FFFD", f); bad++; }
  } catch (e) { console.log("INVALID UTF-8", f, e.message); bad++; }
}
console.log(`scanned ${n} files, problems ${bad}`);' "$@")
}

# Em dashes (U+2014) in lines this task added: diff lines for tracked files,
# every line for untracked ones. Verbatim outputs (.txt/.json in the evidence
# folder) are listed apart: they copy the products' own log wording.
dash_count() { grep -c $'\xe2\x80\x94' || true; }

PFILES=$(git -C $P diff --name-only --diff-filter=d $PB HEAD)
{
  echo "# Praxis: npm run check:encoding over the files changed $PB..$(git -C $P rev-parse --short HEAD) ($(echo $PFILES | wc -w | tr -d ' ') files), $(date '+%Y-%m-%d %H:%M %Z')"
  echo "# working tree status: $(git -C $P status --short | wc -l | tr -d ' ') changed files"
  (cd $P && npm run check:encoding -- $PFILES 2>&1; echo "exit $?")
} > $E/praxis-encoding-scan.txt

{
  echo "# Final encoding and em-dash scans, $(date '+%Y-%m-%d %H:%M %Z'), read-only (made by final-scans.sh)"
  echo
  echo "## TheNexus $(git -C $N rev-parse --short HEAD) plus working tree, every file changed against $NB, and untracked files"
  NFILES=$( (git -C $N diff --name-only --diff-filter=d $NB; git -C $N ls-files --others --exclude-standard) | sort -u)
  echo "files: $(echo "$NFILES" | wc -l | tr -d ' ') ($(echo "$NFILES" | grep -ci '\.png$') PNG skipped)"
  utf8_scan $N $NFILES
  echo
  echo "## TheCortex $(git -C $C rev-parse --short HEAD), every file changed against $CB"
  CFILES=$( (git -C $C diff --name-only --diff-filter=d $CB; git -C $C ls-files --others --exclude-standard) | sort -u)
  echo "files: $(echo "$CFILES" | wc -l | tr -d ' '); working tree status: $(git -C $C status --short | wc -l | tr -d ' ') changed files"
  utf8_scan $C $CFILES
  echo
  echo "## Praxis: its own check:encoding output is in praxis-encoding-scan.txt; the same UTF-8 scan as above"
  utf8_scan $P $PFILES
  echo
  echo "## Em dashes (U+2014) in added lines"
  echo "Praxis ($PB..HEAD, $(echo $PFILES | wc -w | tr -d ' ') files): $(git -C $P diff -U0 $PB HEAD | grep '^+' | grep -v '^+++' | dash_count)"
  echo "TheCortex ($CB..HEAD): $(git -C $C diff -U0 $CB HEAD | grep '^+' | grep -v '^+++' | dash_count)"
  NT=0; NV=0
  for f in $(git -C $N diff --name-only --diff-filter=d $NB); do
    case "$f" in *.png|*.PNG) continue;; esac
    c=$(git -C $N diff -U0 $NB -- "$f" | grep '^+' | grep -v '^+++' | dash_count)
    if [[ "$f" == $EV/*.txt || "$f" == $EV/*.json || "$f" == $EV/*/*.txt ]]; then NV=$((NV + c)); [ "$c" -gt 0 ] && echo "  verbatim output: $f $c"
    else NT=$((NT + c)); [ "$c" -gt 0 ] && echo "  WRITTEN BY THIS TASK: $f $c"; fi
  done
  for f in $(git -C $N ls-files --others --exclude-standard); do
    case "$f" in *.png|*.PNG) continue;; esac
    c=$(dash_count < "$N/$f")
    if [[ "$f" == $EV/*.txt || "$f" == $EV/*.json || "$f" == $EV/*/*.txt ]]; then NV=$((NV + c)); [ "$c" -gt 0 ] && echo "  verbatim output (untracked): $f $c"
    else NT=$((NT + c)); [ "$c" -gt 0 ] && echo "  WRITTEN BY THIS TASK (untracked): $f $c"; fi
  done
  echo "TheNexus code, docs and scripts this task wrote: $NT"
  echo "TheNexus verbatim outputs in the evidence folder (products' own wording): $NV"
  echo
  echo "## The dashboard since the round-1 evidence commit e1bfcc97 (working tree included)"
  echo "dashboard files changed: $(git -C $N diff --name-only e1bfcc97 -- dashboard/ | wc -l | tr -d ' ')"
  echo
  echo "## The registered review package (docs/reviews/2026-11-23-local-model-control/)"
  (cd $N && shasum -a 256 docs/reviews/2026-11-23-local-model-control/*.png)
  echo "uncommitted changes in the package folder: $(git -C $N status --short -- docs/reviews/2026-11-23-local-model-control/ | wc -l | tr -d ' ')"
  echo "files in the package folder: $(ls $N/docs/reviews/2026-11-23-local-model-control | tr '\n' ' ')"
} > $E/encoding-and-dash-scans.txt
echo "done"
