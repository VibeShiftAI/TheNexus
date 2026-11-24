#!/bin/bash
# Task fa032fc0, criterion 2: every place that chose the local model before this
# task, at the QA baselines, beside the line that does the work at the branch
# heads, then the sweep that found them. Read-only git queries (git grep, git
# ls-tree and git log on commits); it reads no working tree and no service. The
# README section "Where the local model was chosen before this task" explains
# each site and each sweep match that is not a site.
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
P=$W/Praxis; N=$W/TheNexus; C=$W/TheCortex
PB=1fcf4b59; PH=cad6afb2; NB=bd02642895fe; NH=6e14bc87; CB=5fdb76a; CH=e611edc
cut200() { cut -c1-200; }
at() { # repo rev pattern paths...
  local repo=$1 rev=$2 pat=$3; shift 3
  git -C "$repo" grep -n -E "$pat" "$rev" -- "$@" | sed "s#^$rev:#  $rev #" | cut200
}
site() { echo; echo "### $1"; }

echo "# Criterion 2 sites, $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "# Praxis $PB -> $PH, TheNexus ${NB:0:8} -> $NH, TheCortex $CB -> $CH"

echo; echo "## Praxis"
site "P1 the one source: config.localLlmModel"
at $P $PB 'localLlmModel: process\.env\.LOCAL_LLM_MODEL' src/config.ts
at $P $PH 'localLlmModelFromEnv: string =|process\.env\.LOCAL_LLM_MODEL \|\||get localLlmModel|runtimeLocalModel\(\) \?\?|set localLlmModel|setRuntimeLocalModel' src/config.ts
at $P $PH 'export function (initLocalModelSelection|syncLocalModelSelection)|setRuntimeLocalModel\(' src/llm/local-model-selection.ts
site "P2 readers of config.localLlmModel outside the manager (same lines at both; each reads the getter at the call)"
at $P $PB 'config\.localLlmModel' src ':!src/config.ts' ':!src/llm/manager.ts' ':!src/llm/local-model-selection.ts' ':!src/llm/local-model-state.ts'
echo "  at $PH:"
at $P $PH 'config\.localLlmModel' src ':!src/config.ts' ':!src/llm/manager.ts' ':!src/llm/local-model-selection.ts' ':!src/llm/local-model-state.ts'
site "P3 the LLM manager: the local provider, the local lanes and the local fallback"
at $P $PB 'config\.localLlmModel' src/llm/manager.ts
echo "  at $PH:"
at $P $PH 'config\.localLlmModel' src/llm/manager.ts
site "P4 an explicit local primary (LLM_PRIMARY_PROVIDER=local) ran LLM_PRIMARY_MODEL"
at $P $PB 'this\.activeModel = config\.llmPrimaryModel' src/llm/manager.ts
at $P $PH 'this\.activeModel = config\.llmPrimaryModel|private primaryModel\(\)|primaryModel\(\): string' src/llm/manager.ts
site "P5 switchModel(\"local/<name>\") set the model local calls ran"
at $P $PB 'this\.activeModel = modelName;' src/llm/manager.ts
at $P $PH 'this\.activeModel = modelName;|local calls run \$\{config\.localLlmModel\}' src/llm/manager.ts
site "P6 a role that resolves through local_default ran the alias target's fixed name"
at $P $PB 'const target: RoleTarget = \{ provider, model, minMaxTokens \}' src/llm/manager.ts
at $P $PH 'followsLocalModel' src/llm/manager.ts src/nexus/client.ts
site "P7 the swarm and council local client (unchanged; built from config per run)"
at $P $PB 'cfg\.localLlmModel \?\? cfg\.llmPrimaryModel|buildProviderClientsFromConfig\(config' src/swarm/engine.ts
at $P $PH 'cfg\.localLlmModel \?\? cfg\.llmPrimaryModel|buildProviderClientsFromConfig\(config|const clients = buildProviderClients\(\)' src/swarm/engine.ts src/council/moa.ts
site "P8 trading read LOCAL_LLM_MODEL itself (unchanged on the branch; Praxis main deleted src/trading)"
at $P $PB 'TRADING_LOCAL_MODEL \?\? env\.LOCAL_LLM_MODEL|"LOCAL_LLM_MODEL"' src/trading
at $P $PH 'TRADING_LOCAL_MODEL \?\? env\.LOCAL_LLM_MODEL|"LOCAL_LLM_MODEL"' src/trading
echo "  files under src/trading on main fbce5c26: $(git -C $P ls-tree -r --name-only fbce5c26 -- src/trading | wc -l | tr -d ' '); on main 519530a9: $(git -C $P ls-tree -r --name-only 519530a9 -- src/trading | wc -l | tr -d ' ')"
echo "  $(git -C $P log -1 --format='%h %ci %s' f8e444a2)"
echo "  $(git -C $P log -1 --format='%h %ci %s' ed8d0442 | cut -c1-160)"
yn() { "$@" && echo yes || echo no; }
echo "  f8e444a2 under ed8d0442: $(yn git -C $P merge-base --is-ancestor f8e444a2 ed8d0442); under its first parent: $(yn git -C $P merge-base --is-ancestor f8e444a2 ed8d0442^1); under the baseline $PB: $(yn git -C $P merge-base --is-ancestor f8e444a2 $PB); under the branch head $PH: $(yn git -C $P merge-base --is-ancestor f8e444a2 $PH)"
site "P9 eval and credit-failover routes: an optional named override, else config.localLlmModel"
at $P $PB 'PRAXIS_EVAL_LOCAL_MODEL \?\?|PRAXIS_CREDIT_FALLBACK_MODEL \?\?' src
at $P $PH 'PRAXIS_EVAL_LOCAL_MODEL \?\?|PRAXIS_CREDIT_FALLBACK_MODEL \?\?' src
site "P10 the teacher-convergence eval's teacher (a deliberate second model; its student is evalLocalRoute)"
at $P $PB 'DEFAULT_TEACHER_MODEL = |PRAXIS_EVAL_TEACHER_MODEL|opts\.student \?\? evalLocalRoute' src/evals/teacher-convergence.ts
at $P $PH 'DEFAULT_TEACHER_MODEL = |PRAXIS_EVAL_TEACHER_MODEL|opts\.student \?\? evalLocalRoute' src/evals/teacher-convergence.ts
site "P11 the home-hub edge classifier (its own server URL; off unless HOME_HUB_EDGE_LLM_URL or EDGE_LLM_URL is set)"
at $P $PB 'HOME_HUB_EDGE_LLM_URL|HOME_HUB_EDGE_LLM_MODEL|if \(!config\.baseUrl\) return undefined' src/home-hub/edge-llm.ts
at $P $PH 'HOME_HUB_EDGE_LLM_URL|HOME_HUB_EDGE_LLM_MODEL|if \(!config\.baseUrl\) return undefined' src/home-hub/edge-llm.ts

echo; echo "## TheNexus"
site "N1 Studio jobs (routes/studio.js)"
at $N $NB "LOCAL_STUDIO_MODEL" server/routes/studio.js
at $N $NH "localModelForWork\(\)|LOCAL_STUDIO_MODEL" server/routes/studio.js
site "N2 Studio ingestion (services/studio-ingestion.js)"
at $N $NB "LOCAL_STUDIO_MODEL" server/services/studio-ingestion.js
at $N $NH "localModelForWork\(\)|LOCAL_STUDIO_MODEL" server/services/studio-ingestion.js
site "N3 the local_default alias: seeded once, then edited by hand in the alias editor"
at $N $NB "\('local_default', 'model:local-gemma-4-31b'" db/index.js
at $N $NH "\('local_default', 'model:local-gemma-4-31b'" db/index.js
at $N $NH "async function setLocalDefault|async function apply\(|await setLocalDefault\(row\.id\)|router\.post\('/local-model/apply'|local_default_required|local_default_target|local_default_is_global" server/services/local-model-selection.js server/routes/model-control.js
site "N4 role resolution through local_default"
at $N $NB "localAlias\.provider === 'local'\) return localAlias" server/services/model-control.js
at $N $NH "resolved\.followsLocalModel = true|localAlias\.provider === 'local'\) return localAlias" server/services/model-control.js
site "N5 the start-up fallback, reported (the environment names, only until Nexus has a model in effect)"
at $N $NH "LOCAL_STUDIO_MODEL|LOCAL_LLM_MODEL" server/services/local-model-selection.js

echo; echo "## TheCortex (paths under TheCortex/python/cortex unless named)"
CP=TheCortex/python/cortex
site "C1 Graphiti's lmstudio route (memory/client.py)"
at $C $CB '"google/gemma-4-31b-qat", "lm-studio"|model_override = live_setting\("cortex_graphiti_model"\)' $CP/memory/client.py
at $C $CH 'def graphiti_local_model|model = await asyncio\.to_thread\(graphiti_local_model\)|_graphiti_lmstudio_fallback\(\)\[0\]|provider != "lmstudio"' $CP/memory/client.py
site "C2 the settings (config.py): CORTEX_TEACHER_MODEL and CORTEX_GRAPHITI_MODEL"
at $C $CB 'alias="CORTEX_TEACHER_MODEL"|alias="CORTEX_GRAPHITI_MODEL"' $CP/config.py
at $C $CH 'alias="CORTEX_TEACHER_MODEL"|alias="CORTEX_GRAPHITI_MODEL"' $CP/config.py
site "C3 the eval teacher (evals/harness.py teacher_model)"
at $C $CB 'def teacher_model|value = live_setting\("cortex_teacher_model"\)' $CP/evals/harness.py
at $C $CH 'def teacher_model|local_model_or\(' $CP/evals/harness.py
site "C4 eval defaults that named Gemma"
at $C $CB '^DEFAULT_(TEACHER_)?MODEL = "google|model: str = DEFAULT_|default=DEFAULT_JUDGE_MODEL' $CP/evals
echo "  at $CH:"
at $C $CH '^DEFAULT_(TEACHER_)?MODEL = "google|model: str = DEFAULT_|model = harness\.teacher_model\(|harness\.teacher_model\(DEFAULT' $CP/evals
site "C5 the reader every site above uses (new in local_model.py)"
at $C $CH 'def local_model_or|/api/model-control/local-model/current|_last_answer, _last_answer_read = model, read' $CP/local_model.py
site "C6 the model registry's direct-path rows (no role selects them; roles reach the local model through the Praxis gateway)"
at $C $CB 'gemma-local:|inkling-local:|model_name: "role:cortex' TheCortex/config/model_registry.yaml
at $C $CH 'gemma-local:|inkling-local:|model_name: "role:cortex' TheCortex/config/model_registry.yaml

# The sweep that found the sites: at each baseline, every code line (comment
# lines left out) naming a local model setting, the local provider or a local
# model by name. Each match is one of the sites above or is named in the README
# as something that does not choose the local model.
nc() { grep -vE '^[^:]+:[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*|#)'; }
sweep() { # repo rev label pattern grep-flag paths...
  local repo=$1 rev=$2 label=$3 pat=$4 flag=$5; shift 5
  echo; echo "### $label"
  git -C "$repo" grep -n $flag -E "$pat" "$rev" -- "$@" | nc | sed "s#^$rev:#  #" | cut200
}
echo; echo "## Sweep at the baselines"
sweep $P $PB "Praxis $PB: localLlmModel, LOCAL_LLM_MODEL, LLM_PRIMARY_MODEL, llmPrimaryModel (src)" \
  'localLlmModel|LOCAL_LLM_MODEL|LLM_PRIMARY_MODEL|llmPrimaryModel' -I src
sweep $P $PB "Praxis $PB: gemma, inkling, qwen in any case (src)" 'gemma|inkling|qwen' -i src
sweep $N $NB "TheNexus ${NB:0:8}: local model settings, names and local-provider branches (server, db, services, lib; no tests)" \
  "LOCAL_STUDIO_MODEL|LOCAL_LLM_MODEL|LMSTUDIO_MODEL|LM_STUDIO_MODEL|gemma-4|gemma4|inkling|provider: *'local'|provider === 'local'|LMSTUDIO_|OLLAMA_MODEL" -I \
  server db services lib ':!*__tests__*' ':!*.test.*'
sweep $N $NB "TheNexus ${NB:0:8}: gemma, inkling in any case (dashboard/src, services; no tests)" 'gemma|inkling' -i \
  dashboard/src services ':!*__tests__*' ':!*.test.*'
sweep $C $CB "TheCortex $CB: model settings and names in any case (python, config; no tests)" \
  'LM_STUDIO_MODEL|LMSTUDIO_MODEL|LOCAL_LLM_MODEL|CORTEX_TEACHER_MODEL|CORTEX_GRAPHITI_MODEL|GRAPHITI_LLM_MODEL|LOCAL_MODEL|gemma|inkling' -i \
  TheCortex/python TheCortex/config ':!*/tests/*' ':!*test_*'
echo; echo "# done"
