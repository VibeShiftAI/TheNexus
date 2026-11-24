#!/bin/bash
# Task fa032fc0, criterion 9: the read-only read-back at the end of the task.
# Reads the live nexus.db read-only, asks LM Studio for its listing once (a
# listing loads nothing), lists the live listeners, and attributes every model
# load LM Studio logged today. Writes nothing anywhere but this script's output.
LMLOG="$HOME/.lmstudio/server-logs/2026-11"
PXLOG=/Volumes/Projects/Praxis/data/logs/praxis.log
DB="file:/Volumes/Projects/TheNexus/nexus.db?mode=ro"
echo "# Criterion 9 read-back at the end of the task, $(date '+%Y-%m-%d %H:%M:%S %Z'), read-only"
echo
echo "## Live Nexus database (/Volumes/Projects/TheNexus/nexus.db, opened mode=ro)"
sqlite3 -header -column "$DB" "SELECT a.alias, a.target, a.is_active, a.updated_at AS alias_updated_at, m.display_name, m.provider, m.api_model_id FROM model_aliases a LEFT JOIN models m ON 'model:' || m.id = a.target WHERE a.alias = 'local_default';"
echo
echo "Live rows this task would add once landed (none expected: the change has not landed):"
echo "  local_model_switches table: $(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='local_model_switches';") (0 = absent)"
echo "  model_control_settings key local_model_selection: $(sqlite3 "$DB" "SELECT COUNT(*) FROM model_control_settings WHERE key='local_model_selection';" 2>&1) (0 = absent)"
echo "  local models rows: $(sqlite3 "$DB" "SELECT GROUP_CONCAT(id || '=' || api_model_id, ', ') FROM models WHERE provider='local';")"
echo
echo "## LM Studio listing (one GET http://127.0.0.1:1234/api/v1/models at $(date '+%H:%M:%S'); a listing loads nothing)"
curl -s --max-time 10 http://127.0.0.1:1234/api/v1/models | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const rows=(j.models||j.data||[]);for(const m of rows){const li=m.loaded_instances||[];console.log(`${(m.type||"?").padEnd(9)} ${String(m.key||m.id).padEnd(38)} loaded_instances=${li.length}${li.length?" "+JSON.stringify(li.map(i=>i.id||i.identifier||i)):""}`);}console.log(`models listed: ${rows.length}; loaded: ${rows.filter(m=>(m.loaded_instances||[]).length).length}`);})'
echo
echo "## Live services: listener PID and start time now (compare live-services-before-browser-check.txt)"
for p in 1234 3000 4000 8100 54322; do
  pid=$(lsof -nP -iTCP:$p -sTCP:LISTEN -t 2>/dev/null | head -1)
  echo "port $p pid $pid started $(ps -o lstart= -p $pid 2>/dev/null)"
done
echo
echo "## Every model load and unload LM Studio logged today ($LMLOG/2026-11-24.*.log)"
cat "$LMLOG"/2026-11-24.*.log | grep -E "Endpoint=loadModel\] Loading model|due to TTL expiration|Unloading model" | cut -c1-170
echo
echo "## Who asked for each load: the live Praxis log's autoload lines today ($PXLOG, executor report echoes excluded)"
grep -E "^\[2026-11-2[45]T" "$PXLOG" | grep -v "Full body" | grep -E "\[LmAutoload\] lms load|\[LmAutoload\] \(.*\) LM Studio has no model loaded|loaded in [0-9]+s" | cut -c1-260
echo
echo "## The lane grants behind those loads (LocalLane lines in the same minutes)"
for t in $(grep -E "^\[2026-11-2[45]T" "$PXLOG" | grep -v "Full body" | grep -E "\[LmAutoload\] lms load" | sed -E 's/^\[([0-9T:-]{16}).*/\1/' | sort -u); do
  grep -E "^\[$t" "$PXLOG" | grep -v "Full body" | grep -E "\[LocalLane\]" | head -2 | cut -c1-300
done
