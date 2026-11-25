#!/usr/bin/env python3
"""List every guard log in the task's scratch folder and count the lines that
name LM Studio's port, 1234. Run before the scratch folder is deleted.

A guard log is any file under the scratch folder (symlinks not followed) whose
name ends in .log and contains "guard", "shims" or "fake-lms". Each guard writes
one line per call it refused or recorded, so a line naming port 1234 would mean
a run tried to reach LM Studio.

Usage: python3 -I guard-logs-scan.py /Volumes/Projects/.scratch-fa032fc0
"""
import os
import re
import sys
import time

root = sys.argv[1]
port_1234 = re.compile(r"(?<![0-9])1234(?![0-9])")
logs = []
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
    for name in filenames:
        path = os.path.join(dirpath, name)
        if os.path.islink(path) or not name.endswith(".log"):
            continue
        if not any(key in name for key in ("guard", "shims", "fake-lms")):
            continue
        logs.append(path)

print(f"# guard logs under {root}, scanned {time.strftime('%Y-%m-%d %H:%M:%S %Z')}")
print("# columns: lines in the log, lines naming port 1234, path relative to the scratch folder")
total_hits = 0
for path in sorted(logs):
    with open(path, "rb") as fh:
        text = fh.read().decode("utf-8", errors="replace")
    lines = text.splitlines()
    hits = [line for line in lines if port_1234.search(line)]
    total_hits += len(hits)
    print(f"{len(lines):6d} {len(hits):4d}  {os.path.relpath(path, root)}")
    for line in hits:
        print(f"         port 1234: {line[:240]}")
print(f"# {len(logs)} guard logs, {total_hits} lines naming port 1234")
