#!/bin/bash
# Task fa032fc0: the full-suite log (6.1 MB) is not copied whole. This writes the
# parts that carry the result, verbatim: the command and the "Running 895 of 901"
# line (lines 1-5), then everything from the runner's final summary ("ℹ tests") to
# the end, which is the summary and its "failing tests" section with every failure.
IN=${1:-/Volumes/Projects/.scratch-fa032fc0/praxis-merged5-full-run.txt}
START=$(grep -n '^ℹ tests ' "$IN" | tail -1 | cut -d: -f1)
{
  echo "# extract of $(basename "$IN") ($(wc -l < "$IN" | tr -d ' ') lines): lines 1-5, then lines $START-end"
  sed -n 1,5p "$IN"
  echo "# ... lines 6-$((START - 1)) left out (passing output and per-test detail) ..."
  tail -n +"$START" "$IN"
}
