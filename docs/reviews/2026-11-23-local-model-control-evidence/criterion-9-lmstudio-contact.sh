#!/bin/bash
# Task fa032fc0, criterion 9: every contact this run had with LM Studio, read
# from both sides. Read-only; it contacts no service.
#  1. LM Studio's own server log, from this run's first start (2026-11-23
#     21:39:35 EST) to now: every request it logged, counted by method and path
#     (every client), and the time of each listing request (GET /api/v1/models,
#     the path this task's read-backs use, and GET /v1/models).
#  2. This run's session transcript and its subagents' transcripts: every Bash
#     call that sends a request to port 1234 (curl, fetch, urlopen), runs the
#     lms CLI, or runs the read-back script (criterion-9-readback.sh, first run
#     from scratch as criterion9-readback-final.sh; one listing request per
#     run), with its time. Then, separately, every other Bash call whose text
#     names port 1234 (search patterns, guard settings, echoed headings), so a
#     reader can check that none of them sends anything. A transcript can hold
#     the same tool call more than once, so calls are counted once per tool
#     call id. For each transcript it also prints the time of its first and
#     last entry and its longest pause between two entries, which shows when
#     the session was idle.
# LM Studio's log is local time (EST, UTC-5); the transcripts' UTC times are
# converted to EST here.
SINCE="2026-11-23 21:39:35"
L="$HOME/.lmstudio/server-logs/2026-11"
LOGS=("$L"/2026-11-23.*.log "$L"/2026-11-24.*.log)
T="$HOME/.claude/projects/-Volumes-Projects--praxis-worktrees-fa032fc0-7472-4406-b6cb-d4671b72a28a-TheNexus/55d225db-3825-46d5-a7e0-bcae377a4dce"
echo "# Made $(date '+%Y-%m-%d %H:%M:%S %Z') by a read-only script; no service contacted."
echo
echo "## 1. LM Studio's server log from $SINCE EST to now"
for f in "${LOGS[@]}"; do echo "log file: $f ($(wc -c < "$f" | tr -d ' ') bytes)"; done
since() { awk -v s="$SINCE" 'substr($0, 2, 19) >= s' "${LOGS[@]}" | grep -aE '^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}\]\[[A-Z]+\] Received request: [A-Z]+ to '; }
echo "requests by method and path (every client):"
since | sed -E 's/.*Received request: ([A-Z]+) to ([^ ?]+).*/\1 \2/' | sort | uniq -c | sort -rn
echo "every GET /api/v1/models:"
since | grep -aE 'Received request: GET to /api/v1/models' | cut -c2-20 | sed 's/^/  /'
echo "every GET /v1/models:"
since | grep -aE 'Received request: GET to /v1/models' | cut -c2-20 | sed 's/^/  /'
echo
echo "## 2. This run's Bash calls (session $(basename "$T") and its subagents)"
node - "$T.jsonl" "$T"/subagents/*.jsonl <<'EOF'
const fs = require('fs');
const sends = [
  /curl[^|;&]*(127\.0\.0\.1|localhost):1234/,
  /(fetch|urlopen|requests\.(get|post)|http\.(get|request))\(\s*['"`]https?:\/\/(127\.0\.0\.1|localhost):1234/,
  /(^|\n|;|&&|\|\||\$\(|\bthen\s|\bdo\s)\s*(\S*\/)?lms\s+(load|unload|ps|ls|get|server)\b/,
  /\bbash\s+[^|;&\n]*criterion-?9-?readback[\w-]*\.sh/,
];
const est = (ts) => (ts ? new Date(ts).toLocaleString('sv-SE', { timeZone: 'America/New_York' }) : 'time not recorded');
const around = (cmd, at) => cmd.slice(Math.max(0, at - 50), at + 110).replace(/\s+/g, ' ');
for (const file of process.argv.slice(2)) {
  const byId = new Map();
  const times = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.match(/"timestamp":"([^"]+)"/);
    if (t) times.push(t[1]);
    if (!line.includes('"tool_use"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const content = j?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== 'tool_use' || c.name !== 'Bash') continue;
      const seen = byId.get(c.id);
      if (seen) { if (!seen.ts && j.timestamp) seen.ts = j.timestamp; continue; }
      byId.set(c.id, { ts: j.timestamp, cmd: String(c.input?.command ?? '') });
    }
  }
  const sent = [];
  const named = [];
  for (const { ts, cmd } of [...byId.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
    const re = sends.find((r) => r.test(cmd));
    if (re) { sent.push(`  ${est(ts)}: ${around(cmd, cmd.match(re).index)}`); continue; }
    const m = cmd.match(/:1234\b/);
    if (m) named.push(`  ${est(ts)}: ${around(cmd, m.index)}`);
  }
  console.log(`${file.split('/').pop()}: ${byId.size} Bash calls; ${sent.length} send to LM Studio; ${named.length} other calls name port 1234`);
  times.sort();
  let gap = [0, '', ''];
  for (let i = 1; i < times.length; i++) {
    const d = Date.parse(times[i]) - Date.parse(times[i - 1]);
    if (d > gap[0]) gap = [d, times[i - 1], times[i]];
  }
  if (times.length) console.log(` entries from ${est(times[0])} to ${est(times[times.length - 1])}; the longest pause between two entries: ${est(gap[1])} to ${est(gap[2])}`);
  if (sent.length) console.log(' calls that send to LM Studio:\n' + sent.join('\n'));
  if (named.length) console.log(' other calls that name port 1234:\n' + named.join('\n'));
}
EOF
echo "# done"
