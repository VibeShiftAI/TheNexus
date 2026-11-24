#!/bin/bash
# Task fa032fc0, criterion 2: the ways TheNexus's live settings could pin a
# local model other than through the local_default alias, read from the live
# nexus.db opened mode=ro (plus two file checks). Read-only. From the TheNexus
# .env it prints only the PROJECT_ROOT path.
#  1. Task-type pins (site N6, server/services/ai-service.js resolveCallTarget,
#     "Local pins stay pinned"): a models row marked is_default_for_task
#     (db/index.js getDefaultModelForTask), else agent-config.json under
#     $PROJECT_ROOT/TheNexus (AGENT_CONFIG_PATH in ai-service.js).
#  2. Model Control roles whose assignment names a local model, directly or
#     through an alias.
#  3. Global aliases that target a local row, and project aliases and project
#     settings that name one (server/services/model-control.js resolveAlias
#     reads project aliases first).
DB="file:/Volumes/Projects/TheNexus/nexus.db?mode=ro"
echo "# Criterion 2 pins, $(date '+%Y-%m-%d %H:%M:%S %Z'), read-only"
echo
echo "## 1. Task-type pins"
echo "PROJECT_ROOT in /Volumes/Projects/TheNexus/.env: $(grep '^PROJECT_ROOT=' /Volumes/Projects/TheNexus/.env | cut -d= -f2-)"
for p in /Volumes/Projects/TheNexus/agent-config.json "$HOME/Projects/TheNexus/agent-config.json"; do
  if [ -e "$p" ]; then echo "$p: present"; else echo "$p: absent"; fi
done
echo "models rows with a task default (is_default_for_task set): $(sqlite3 "$DB" "SELECT COUNT(*) FROM models WHERE COALESCE(is_default_for_task, '') <> '';")"
echo "rows with a task default, and every local row:"
sqlite3 -header -column "$DB" "SELECT id, provider, api_model_id, is_active, is_default_for_task FROM models WHERE COALESCE(is_default_for_task, '') <> '' OR provider = 'local' ORDER BY provider, id;"
echo
echo "## 2. Model Control roles"
LOCAL_IDS="SELECT 'model:' || id FROM models WHERE provider = 'local'"
echo "roles in all: $(sqlite3 "$DB" "SELECT COUNT(*) FROM model_roles;")"
echo "roles whose assignment mentions local in any form: $(sqlite3 "$DB" "SELECT COUNT(*) FROM model_roles WHERE assignment LIKE '%local%';")"
echo "  of them, assignment exactly alias:local_default: $(sqlite3 "$DB" "SELECT COUNT(*) FROM model_roles WHERE assignment = 'alias:local_default';")"
echo "roles whose assignment names a local models row directly: $(sqlite3 "$DB" "SELECT COUNT(*) FROM model_roles r WHERE EXISTS (SELECT 1 FROM models m WHERE m.provider = 'local' AND instr(r.assignment, 'model:' || m.id) > 0);")"
echo "the roles that mention local:"
sqlite3 "$DB" "SELECT '  ' || role || ' = ' || assignment || ' (active ' || is_active || ')' FROM model_roles WHERE assignment LIKE '%local%' ORDER BY role;"
echo
echo "## 3. Aliases and project settings"
echo "global aliases that target a local row or whose name mentions local:"
sqlite3 "$DB" "SELECT '  ' || alias || ' -> ' || target || ' (active ' || is_active || ')' FROM model_aliases WHERE target IN ($LOCAL_IDS) OR alias LIKE '%local%' ORDER BY alias;"
echo "project aliases in all: $(sqlite3 "$DB" "SELECT COUNT(*) FROM project_model_aliases;"); naming local_default or a local row: $(sqlite3 "$DB" "SELECT COUNT(*) FROM project_model_aliases WHERE alias = 'local_default' OR target IN ($LOCAL_IDS) OR target LIKE '%local%';")"
echo "project Model Control settings whose value mentions local: $(sqlite3 "$DB" "SELECT COUNT(*) FROM project_model_control_settings WHERE value LIKE '%local%';")"
echo "# done"
