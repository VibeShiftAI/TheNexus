# Evidence: local model chosen under Model Control (task fa032fc0, 2026-11-24)

The review package in `../2026-11-23-local-model-control/` holds only the three
review screenshots (registered revision `5a481277`). Everything else that backs
the task is here. Test and log outputs are copied verbatim, so they can contain
the products' own wording (including dashes in their log messages). Five files
are extracts rather than whole logs, each cut verbatim by
`merged-main/praxis-full-suite-extract.sh` (the command, the "Running N of M"
line, then the runner's summary and every failure with its detail; the passing
output is left out, and each extract says which lines):
`merged-main/praxis-full-suite-summary-and-failures.txt` (from a 6.1 MB log),
the three `merged-main/praxis-tests-*519530a9*-extract.txt` (from logs of 1.5
to 1.6 MB) and `merged-main/praxis-tests-merged-59cacac6-extract.txt` (from a
2.0 MB log).

Three repositories changed, each on its own task branch:

| Repository | Baseline | Branch head | Main at the merged checks |
| --- | --- | --- | --- |
| TheNexus | `bd02642` | `6e14bc87`, plus evidence-only commits after it (`f8761e33`, `f011c4ee` and the one that adds this update) | `3189bb99`, `a2870083`, then `2a7952fc` |
| Praxis | `1fcf4b59` | `cad6afb2` | `24c1abaa`, `4d076f91`, `613f66b6`, `fbce5c26`, `519530a9`, then `59cacac6` |
| TheCortex | `5fdb76a` | `e611edc` | `3617672` |

Both mains kept moving while the task ran. The last merged checks are on
TheNexus `2a7952fc` (main since 15:51:16 EST) and Praxis `59cacac6` (main since
15:51:18; one task landed both), each pinned by its full hash and run from
16:09:15 to 16:11:34 EST. TheCortex main has been `3617672` since 09:01:33. The
times come from each shared checkout's reflog for `main`. At 16:20:01 EST
none of the three mains had moved since. A main that moves later is not covered
here.

The task's commits, oldest first:

| Repository | Commits |
| --- | --- |
| TheNexus | `fc23f07a`, `d93b3453`, `5d43f2c9`, `3770d86e`, `e1bfcc97` (round 1 and its evidence); `f2644c44`, `7f915704`, `09b75ae8` (the model row made at apply, the seed fix, the evidence update); `6e14bc87` (reasoning checked both ways) |
| Praxis | `766635bc`, `ac0b13e0`, `90d44073`; `6f9fb79b` (switch findings held, local primary follows Model Control); `cad6afb2` (round 4, below) |
| TheCortex | `42b67e2`, `ea37c44`, `0909b22`; `e611edc` (overlapping reads, below) |

## Precondition (criterion 1)

`criterion-1-precondition.sh` (output `criterion-1-precondition.txt`, 16:03:58
EST, read-only) finds the readiness task's commits by their trailer
(`git log main --grep=9227d9b6`). For each one it asks git whether the commit is
on main and under the task branch's head (`git merge-base --is-ancestor`). Then
it runs the brief's own check as the brief writes it.

| Repository | Readiness commits (task `9227d9b6`) | On main | Under the branch head |
| --- | --- | --- | --- |
| TheNexus | `9de7bed6` (its merge, 2026-11-23 22:47:28), `1104ec89`, `22d86d03` | all 3 (main `2a7952fc`) | no |
| Praxis | `1fcf4b59` (its merge, 2026-11-23 22:48:04), `de1c5916`, `884135de`, `1a82f9e8`, `694c867a`, `0bc2c8fb` | all 6 (main `59cacac6`) | yes (`cad6afb2`) |
| TheCortex | `5fdb76a`, `2d7c015` | both (main `36176727`) | yes (`e611edc`) |

The brief's check, `git -C /Volumes/Projects/Praxis grep -c
'thinkingmachines/inkling-2-mini' main -- src/llm/local-model-capabilities.ts`,
prints `main:src/llm/local-model-capabilities.ts:2` (exit 0).

The precondition holds: every commit of the readiness task is on main in all
three repositories.

This run started twice. The first start, at 21:39:35 EST on 2026-11-23, came
before the readiness task landed. The same check printed nothing then: Praxis
main was at `9a49acc9`, and `0bc2c8fb` and `694c867a` were only on the readiness
branch. So the run stopped at 21:40:38 with `PRAXIS_CLAUDE_STATUS: needs_input`
and changed nothing in any repository. The readiness merge `1fcf4b59` is dated
22:48:04, and the run resumed at 07:42:09 EST on 2026-11-24. These times come
from this run's session transcript; `criterion-9-lmstudio-contact.txt` prints
its first entry and the pause between the two starts.

In TheNexus the branch was cut from `bd02642` (2026-11-23 20:16:56), before the
readiness merge reached main, so its head does not contain those three commits.
The merged checks below put the branch diff on mains that do contain them:
`3189bb99` (270/270), `a2870083` (393/393) and `2a7952fc` (401/401). The
combination broke one test, because main's seed adds an Inkling row;
`7f915704` fixed it.

## Where the local model was chosen before this task (criterion 2)

`criterion-2-sites.sh` (output `criterion-2-sites.txt`) uses read-only
`git grep` on commits. It prints each site below as it was at the QA baseline,
beside the line that does the work at the branch head, then the sweep that
found the sites. Line numbers are the baselines' (`1fcf4b59`, `bd02642`,
`5fdb76a`) under "Before" and the branch heads' (`cad6afb2`, `6e14bc87`,
`e611edc`) under "Now".

Two read-only checks of this machine back the claims about settings:
- `criterion-2-env-names.sh` (output `criterion-2-env-names.txt`) counts, in the
  four env files the services read and in the six launch agents, every
  environment name below that names or picks a local model. It prints counts
  only. The Praxis `.env` sets `LOCAL_LLM_MODEL` (it names Gemma),
  `LLM_PRIMARY_MODEL`, `LLM_PRIMARY_PROVIDER` (not `local`) and
  `PRAXIS_EVAL_FALLBACK_MODEL` (a subscription CLI route, not a local one).
  No other name is set anywhere.
- `criterion-2-pins.sh` (output `criterion-2-pins.txt`) reads the live nexus.db
  opened `mode=ro`. 19 of the 37 Model Control roles reach a local model, all 19
  through `alias:local_default`. No role, global alias, project alias or project
  setting names a local row directly, and there are no task-type pins (N6).

### Praxis

Before this task Praxis read the local model once, from the environment, when it
started. Now `config.localLlmModel` is a getter over the model Praxis last
applied from Nexus's setting, and everything that read the old value reads the
getter each time it runs.

- **P1, the one value, `config.localLlmModel`.**
  - Before: `src/config.ts:323` took `LOCAL_LLM_MODEL`, else
    `LLM_PRIMARY_MODEL`, else `"default"`, once at start-up.
  - Now: a getter, `src/config.ts:336-337` (`runtimeLocalModel() ??
    localLlmModelFromEnv`).
    - `switchTo` (`src/llm/local-model-selection.ts:260-262`) sets it from
      Nexus's setting. Praxis reads the setting at start-up
      (`initLocalModelSelection`, `:450`) and again on every resync
      (`startLocalModelResync`, `:459`). A switch takes effect only when no
      local call is running.
    - The environment value stays at `src/config.ts:299-300`. It is used only
      while Nexus cannot be reached or names no model, and `useEnvFallback`
      (`:245-258`) logs that it is in use (criterion 4).
- **P2, readers of `config.localLlmModel` outside the manager.**
  - Where (all under `src/`): `council/member-profile-updates.ts:206`;
    `evals/inference-policy.ts:53`, `:132`; `groundrules/runner.ts:106`;
    `ingestion/salience-triage.ts:250`; `llm/context-window.ts:216`;
    `llm/credit-exhaustion-preflight.ts:147` (a log line);
    `llm/credit-failover.ts:83`; `llm/lmstudio-autoload.ts:621`;
    `maintenance/fleet-preflight.ts:1416`; `orchestrator/qa-lessons.ts:1838`,
    `:1972`; `voice/spoken-prose.ts:114`.
  - These are the same lines at both commits, except autoload's, which is now
    `llm/lmstudio-autoload.ts:677`.
  - Each reads the getter when it runs, so its next use after a switch gets the
    new model.
  - Autoload's load target and the slot check (`claimLocalSlot`, `:1494`) both
    take the model from `expectedLocalModel()` (`:676-677`).
- **P3, the LLM manager's local provider, local lanes and local fallback**
  (`src/llm/manager.ts`).
  - Before: `:294` gave the local provider the model as a value when the
    manager was built. `:764`, `:809`, `:915`, `:1097`, `:1168`, `:1323-1324`
    and `:1338` read `config.localLlmModel`.
  - Now: the provider gets a function, `:317` (`() => config.localLlmModel`),
    so it reads the model at each call. The other reads are now at `:831`,
    `:876`, `:982`, `:1168`, `:1241`, `:1414-1415` and `:1429`.
- **P4, a local primary (`LLM_PRIMARY_PROVIDER=local`).**
  - Before: `manager.ts:302-308` set the primary's model to `LLM_PRIMARY_MODEL`.
  - Now: `primaryModel()` (`:365-366`) returns `config.localLlmModel` when the
    primary provider is local. `:332` still records `LLM_PRIMARY_MODEL` for any
    other provider.
  - On this machine the primary provider is not local.
- **P5, `switchModel("local/<name>")`.**
  - Before: `manager.ts:693` set `activeModel` to the name, and local calls ran
    it.
  - Now: `:760` still records the name, but local calls run
    `config.localLlmModel`. The reply says so (`:750-751`: "local calls run
    ..., the local model chosen under Model Control, not ...").
- **P6, a role that resolves through `local_default`.**
  - Before: `manager.ts:1139` built the role's target from the name Nexus sent,
    the alias target's fixed model name.
  - Now: Nexus marks such a role `followsLocalModel` (TheNexus
    `server/services/model-control.js:373`). Praxis keeps the mark
    (`manager.ts:1211-1212`) and runs `config.localLlmModel` for that role
    (`:1164`). A streamed local primary does the same (`:1622`, `:1676`).
  - The live board has 19 such roles (`criterion-2-pins.txt`).
- **P7, the swarm and council local client (unchanged by this task).**
  - `src/swarm/engine.ts:148` takes `cfg.localLlmModel ?? cfg.llmPrimaryModel`
    each time the clients are built from `config` (`buildProviderClients`,
    `:80`): once per swarm run (`:647`) and once per council aggregator call
    (`src/council/moa.ts:374`).
  - Each seat call is counted as a local call and claims the slot first
    (`localLaneChatClient`, `:187-204`, counted at `:196`).
    - A switch waits for a seat call that is in flight.
    - A seat call that still names the replaced model, after a switch that took
      effect while it waited, is refused (`switched_away`,
      `llm/lmstudio-autoload.ts:1515-1517`).
  - No preset in `src/` seats a local model: `council/moa.ts:179-194` and
    `council/problem-council.ts:69-70` seat CLI and free models.
- **P8, trading read the environment itself.**
  - It took `TRADING_LOCAL_MODEL`, else `LOCAL_LLM_MODEL`, else
    `LLM_PRIMARY_MODEL` (`src/trading/reflections.ts:65`; the council's env type
    is at `src/trading/council/personas.ts:74`).
  - These lines are the same at both commits: the branch leaves `src/trading`
    untouched.
  - Main deleted `src/trading` in `f8e444a2` (2026-11-23 22:22:54), which the
    merge `ed8d0442` brought to main at 2026-11-24 08:28:32, during this task.
    - Neither the baseline nor the branch head contains it, so landing takes
      the deletion.
    - `fbce5c26` and `519530a9` have no file under `src/trading`.
  - `TRADING_LOCAL_MODEL` is set nowhere on this machine.
- **P9, the eval and credit-failover routes: an optional override, else the
  local model.**
  - `src/evals/inference-policy.ts:53` takes `PRAXIS_EVAL_LOCAL_MODEL`, else
    `config.localLlmModel`. `src/llm/credit-failover.ts:83` takes
    `PRAXIS_CREDIT_FALLBACK_MODEL`, else `config.localLlmModel`. Both lines are
    the same at both commits.
  - Neither override is set on this machine, so both routes follow the getter.
  - `PRAXIS_EVAL_FALLBACK_MODEL` (`inference-policy.ts:63`) and
    `PRAXIS_EVAL_JUDGE_MODEL` (`:78`) add a route only when set.
    - The first is set to a subscription CLI route, not a local one.
    - The second is unset.
- **P10, the teacher-convergence eval's teacher.**
  - `src/evals/teacher-convergence.ts:58` sets `DEFAULT_TEACHER_MODEL =
    "google/gemma-4-31b"`, and `PRAXIS_EVAL_TEACHER_MODEL` can override it
    (`:63`). Both lines are the same at both commits.
  - The teacher is a deliberate second model that judges the student. The
    student is `evalLocalRoute()` (`:321`, P9), so the student follows the
    setting.
  - Robert's 2026-11-03 ruling keeps Gemma out of evaluations
    (`src/llm/eval-model-policy.ts:3-4`), and `assertLocal` (`:263-264`)
    refuses the default teacher.
    - The eval runs only with `--teacher` (`scripts/run-teacher-convergence.ts:84-85`)
      or with `PRAXIS_EVAL_TEACHER_MODEL` naming another model.
    - `PRAXIS_EVAL_TEACHER_MODEL` is unset here.
- **P11, the home-hub edge classifier.**
  - `src/home-hub/edge-llm.ts:67` takes `HOME_HUB_EDGE_LLM_MODEL`, else
    `EDGE_LLM_MODEL`, else `"gemma"`; `:14` has the same default. Both lines
    are the same at both commits.
  - It calls its own server, `HOME_HUB_EDGE_LLM_URL` or `EDGE_LLM_URL` (`:66`),
    and is off when neither is set (`:11`). Neither is set on this machine, so
    it names no model that runs here.

### TheNexus

- **N1, Studio jobs** (`server/routes/studio.js`).
  - Before: `:710` took `LOCAL_STUDIO_MODEL`, else `'llama3.2'`.
  - Now: `:719` takes `await local.localModelForWork()`. That is the model in
    effect, or, inside a counted local job, the model that job started with
    (`server/services/local-model-selection.js:595-600`).
- **N2, Studio ingestion** (`server/services/studio-ingestion.js`).
  - Before: `:37` took `LOCAL_STUDIO_MODEL`, else `'gemma4'`.
  - Now: `:42` takes the same `localModelForWork()`.
- **N3, the `local_default` alias and the Gemma row.**
  - Before: both were seeded once (`db/index.js:599`, the alias; `:568`, the
    row). After that, the alias was edited by hand in the alias editor.
  - Now: the seeds are unchanged (`:621`, `:590`).
    - Only `setLocalDefault` (`server/services/local-model-selection.js:325`)
      writes the alias's target.
    - `apply` (`:495`, `:511`) calls it, through the loopback-only
      `POST /api/model-control/local-model/apply`
      (`server/routes/model-control.js:841`). Praxis calls that route when no
      local job is running.
    - The alias editor refuses to switch the alias off or retarget it
      (`model-control.js:867`, `:871`, `:878`). A project cannot shadow it
      (`:975`, `local_default_is_global`).
- **N4, role resolution through `local_default`**
  (`server/services/model-control.js`).
  - Before: `:456` returned the alias's model name.
  - Now: `:464` is unchanged, and `resolveAlias` marks the result
    `followsLocalModel` (`:373`), so Praxis runs its model in effect (P6).
- **N5, the start-up fallback (new).**
  - `modelInEffectOrFallback` (`server/services/local-model-selection.js:540-560`)
    takes `LOCAL_STUDIO_MODEL`, else `LOCAL_LLM_MODEL`, else `'gemma4'`
    (`:552-554`).
  - It does so only while no local model is in effect, and logs that it does.
  - `:677` is the stand-in for a Studio router built without the setting, which
    only tests do. `server/server.js:163` and `:201` always pass the real one.
- **N6, task-type pins** (`server/services/ai-service.js:221`, unchanged:
  "Local pins stay pinned").
  - A task type would reach a local model only through a models row marked
    `is_default_for_task`, or through `agent-config.json`.
  - The live database has no row with a task default, and the file is absent
    (`criterion-2-pins.txt`).
  - No route or panel writes the column: it appears only in `db/` and in the
    migration that made it.
  - So nothing chooses a local model this way.

### TheCortex

Paths are under `TheCortex/python/cortex/` unless named.

- **C1, Graphiti's lmstudio route** (`memory/client.py`).
  - Before: `:109` named `"google/gemma-4-31b-qat"`, and the
    `cortex_graphiti_model` setting could override it (`:127`).
  - Now: each call reads the local model chosen under Model Control
    (`graphiti_local_model`, `:155`, read per call at `:182`) through
    `local_model_or` (C5).
    - Until Nexus has answered, the route uses `_graphiti_lmstudio_fallback()`
      (`:113`, `:145-152`), which takes `CORTEX_GRAPHITI_MODEL`, else the
      built-in Gemma name, and logs that it does.
    - The override no longer applies to this route (`:134`).
- **C2, the settings** (`config.py`): `CORTEX_GRAPHITI_MODEL` (`:286`, now
  `:288`) and `CORTEX_TEACHER_MODEL` (default Gemma, `:315`, now `:320`).
  - Both are unchanged, and both are now only the start-up fallback for C1 and
    C3.
  - Neither is set on this machine.
- **C3, the eval teacher** (`evals/harness.py`, `teacher_model`).
  - Before: `:128-130` read the `cortex_teacher_model` setting.
  - Now: `:146` returns `local_model_or(fallback, purpose="the eval teacher",
    ...)`: the model Nexus names, else the fallback, logged.
- **C4, eval defaults that named Gemma** (`evals/`).
  - Before:
    - `acted_on_retrieval.py:91`, `curation_replay.py:80` and `referee.py:102`
      set Gemma as the default. `relevance_labels.py:71` takes `referee.py`'s
      default.
    - The eval classes took that default as a parameter default:
      `acted_on_retrieval.py:486`, `citation_recovery.py:384`,
      `curation_replay.py:600`, `packet_format.py:177`, `referee.py:677`, and
      `relevance_labels.py:291`, `:353`, `:421`, `:747`.
  - Now: each resolves `harness.teacher_model(DEFAULT_...)` when it runs (C3),
    with the constant as the fallback:
    - `acted_on_retrieval.py:494`, `:893`;
    - `citation_recovery.py:390`, `:848`;
    - `curation_replay.py:609`, `:1036`;
    - `packet_format.py:184`, `:783`;
    - `referee.py:689`, `:708`, `:1167`;
    - `relevance_labels.py:302`, `:373`, `:449`, `:783`.
- **C5, the reader (new, `local_model.py`).**
  - `local_model_or` (`:94`) reads `GET /api/model-control/local-model/current`.
  - It keeps the newest answer it got (`:112`), for use during an outage.
- **C6, the model registry's direct rows.**
  - `TheCortex/config/model_registry.yaml:159` (`gemma-local`) and `:173`
    (`inkling-local`) use provider `lm_studio`. They are unchanged and unused:
    no role selects them (`llm_factory.py:285-289`).
  - The roles reach the local model through the Praxis gateway
    (`model_name: "role:cortex.*"`, `model_registry.yaml:99`, `:108`, `:126`,
    `:135`, `:144`), which resolves them as in N4 and P6.

### The sweep

The sweep at the end of `criterion-2-sites.txt` is what found these sites. At
each baseline it lists every code line (comment lines left out) that names a
local model setting, the local provider or a local model by name. The patterns
are in the script.

Each of its 127 matches is one of the sites above or falls in one of these
groups, none of which chooses the local model:
- **Praxis, types and the generic primary.**
  - Types: `src/config.ts:33`, `:39`; `src/swarm/engine.ts:56-57`.
  - `src/config.ts:325`: `LLM_PRIMARY_MODEL` for any provider.
  - `src/llm/manager.ts:304`: part of P4's condition.
  - `src/llm/manager.ts:614`, `:619`: these keep an explicit primary after a
    fallback.
- **Praxis, the local speech model** (Qwen text to speech, not LM Studio):
  - `src/chat-cli-session.ts:1675`;
  - `src/morning/newsletter.ts:40`, `:520`;
  - `src/prompt.ts:129`;
  - `src/reports/status-report.ts:1346`;
  - `src/voice/local-qwen.ts:101`, `:105`, `:108`, `:131`, `:139`, `:159-162`;
  - `src/voice/tts-budget.ts:143`, `:177`;
  - `src/voice/tts-health.ts:27`, `:349`, `:361`, `:429`;
  - `src/voice/tts-provider.ts:2`, `:7`, `:11`;
  - `src/voice/tts-settings.ts:2`, `:5`, `:6`.
- **Praxis, model names as data.**
  - Keyword lists: `src/council/reputation.ts:88`,
    `src/skills/typed-skill-graph.ts:96`.
  - Provider inference from a name: `src/groundrules/providers.ts:23`, `:25`.
  - The capability table: `src/llm/local-model-capabilities.ts:41`, `:52`,
    `:59-61`, `:69`, `:134`.
  - OpenRouter's free models: `src/llm/free-model-ranking.ts:110`, `:121`,
    `:158`; `src/llm/openrouter-free.ts:230`.
  - The eval policy that excludes Gemma: `src/llm/eval-model-policy.ts:3-4`.
- **Praxis, text in logs, reports, prompts and tool descriptions:**
  - `src/ingestion/engine.ts:408`;
  - `src/ingestion/processing/comparison-report.ts:144`, `:157`, `:286`;
  - `src/morning/knowledge-council.ts:354`;
  - `src/trading/tools.ts:173`;
  - `src/trading/us-trend-radar.ts:79`. Its summary is a manager call by role,
    at `:439` and `:453`.
- **TheNexus:**
  - display text on the Codex page, `dashboard/src/app/codex/page.tsx:181`,
    `:184`;
  - the brain tool's description, `services/praxis-mind-mcp/tools/brain.js:77`.
- **TheCortex:**
  - docstrings: `evals/referee.py:58`, `evals/relevance_labels.py:20`,
    `llm_factory.py:68`, `:70`, `memory/entity_resolver.py:106`, `:135`,
    `:281`, `memory/neo4j_layer.py:9`, `:252`, `memory/query_expander.py:5`,
    and `evals/harness.py:129` (C3's);
  - the fields of the C6 rows: `model_registry.yaml:161-163`, `:175-177`;
  - the field lines of the C2 settings: `config.py:285`, `:314`.

## Changes since the 13:06 evidence update (`09b75ae8`)

### TheNexus `6e14bc87` (test only)

Code review of `f2644c44` and `7f915704` noted that "reasoning is carried onto
the row" was proven one way only: a reasoning model's row was checked for
reasoning, but no row was checked for its absence. The test now also checks
that the row made for Gemma 4 31B, whose listing names no reasoning, claims none
(`capabilities: { chat: true, local: true }`).

- `nexus-round3-checks.sh`, output in `nexus-round3-checks-output.txt`:
  - `local-model-selection.test.js` on the working tree that became `6e14bc87`:
    17/17 (`nexus-local-model-selection-tests.txt`).
  - Mutation X, in a scratch copy: every made row claims reasoning. Only the
    test with the new assertion fails, 1 failed and 16 passed
    (`mutations/nexus-mutation-x.txt`).
  - The 23 related server suites: 268/268 (`nexus-related-server-tests.txt`).
  - The network guard refused nothing in any of the three.

### TheCortex `e611edc`

Code review of `0909b22` found that the last model Nexus named was written by
whichever read reached the lock last. Graphiti runs its LLM calls at the same
time, each reading Nexus in its own thread, so a read served just before Praxis
applied a switch could come back after one served just after it, and put the
replaced model back as the last answer. A Nexus outage right after that would
have sent every call to the replaced model.

- Reads are now numbered as they start. The last answer changes only for a read
  newer than the one it came from, as Praxis already does
  (`src/llm/local-model-selection.ts`, `newestReadActedOn`). Each call still
  sends what its own read returned.
- `cortex-local-model-tests.txt`: `tests/test_local_model_setting.py`, 23
  passed. The new test makes two overlapping reads, the older one coming back
  last, then an outage: Graphiti and the eval teacher keep the newer model.
- `cortex-offline-tests.txt`: the 11 offline test files, 293 passed.
- Mutation Y, in a scratch copy, removes the read-order guard. Only the new test
  fails, 1 failed and 22 passed (`mutations/cortex-mutation-y.txt`, script and
  summary beside it).
- This memory lasts one process. An eval run that starts while Nexus is down has
  had no answer yet, so it takes its environment fallback and logs it (the
  start-up rule).

### Praxis `cad6afb2` (round 4)

The review of `6f9fb79b` found three defects in the local model switch.

1. A call that waited out a switch being recorded was refused as
   `switched_away` whenever an earlier switch had replaced the model it names,
   even when the wait took nothing into effect (busy, superseded, failed). Each
   switch now carries its number (`localModelSwitchCount`), and the slot claim
   refuses only for a switch that took effect during the call's own wait.
2. Only the last switch was remembered. After two switches with no local call
   between them, the first replaced model still had to wait out its idle
   period, and a new spelling of the model in effect was recorded as a switch.
   `src/llm/local-model-state.ts` now keeps one entry per replaced model,
   dropped by model key when that model is chosen again; a new spelling
   replaces nothing.
3. `chat()` on a local primary counted each attempt on its own, so a switch
   could take effect between the empty-slot reload and its retry, and between a
   cut answer and the output-room retry. The primary's attempts now run as one
   counted local call (`tryPrimary` inside `trackLocalCall`). The local provider
   is registered with its count outside the output-room wrapper
   (`countedLocalProvider`). `chatStream` reads the local primary's model when
   that candidate is tried.

Tests:
- Eight new cases in `tests/local_model_selection.test.ts` and
  `tests/local_model_primary.test.ts` (33 cases before, 41 now). The commit
  message says seven: the eighth is the unit case for the idle judgement ("each
  model a switch replaced may go without the idle period, judged by the latest
  switch away from it"), which mutation s2 fails together with its integration
  case.
- Mutations s1 to s7 each undo one part of these fixes, and each fails only the
  cases that cover that part (`mutations/praxis-mutations-s.sh`, summary in
  `mutations/praxis-mutations-s-output.txt`, runs in
  `mutations/praxis-mutation-s1.txt` to `s7.txt`).
- `tests/quantized_tool_gate.test.ts` changed too. Its test "chat skips a
  breached local primary and succeeds through the online fallback" set the
  breached model through `manager.activeModel`. Since `6f9fb79b` a local primary
  runs the local model chosen under Model Control (`primaryModel()` in
  `src/llm/manager.ts`), so that model was never used and the test failed (the
  wider run before the fix, `praxis-wider-tests-before-fixture-fix.txt`,
  472/473).
  - The fixture now makes the breached model the local model in effect
    (`config.localLlmModel = "gemma-q4"`, restored afterwards). The assertion,
    `{ localCalls: 0, googleCalls: 1 }`, is unchanged.
  - Mutation Z removes the quantized gate from `chat()`'s primary attempts in a
    scratch copy of `cad6afb2`: the test fails, 10/11. Restored: 11/11
    (`mutations/praxis-mutation-z.sh`, `praxis-mutation-z-output.txt`,
    `praxis-mutation-z.txt`, `praxis-mutation-z-restored.txt`).

The round-4 test runs on the branch below (the selection, nine-file, related and
wider runs; first log lines 14:05:12 to 14:07:43 EST) started after the last
edit to the seven committed files (14:04:38) and before the commit (14:09:43),
so each ran exactly the committed code. The exceptions are named:
`praxis-wider-tests-before-fixture-fix.txt` ran at 14:00, before the fixture
change; both `tsc` runs and the encoding check ran at the end, on the clean
branch heads; the merged-tree runs used the committed diff. Mutations s1 to s7
ran at 13:54 on `6f9fb79b` plus a patch of six files
(the four source files and the two test files), identical to
`6f9fb79b..cad6afb2` for those files; the seventh file,
`tests/quantized_tool_gate.test.ts`, is not part of their runs.

## Final results on the branch heads

Every run used guards, kept in `guards/`:
- `net-guard.mjs` refuses anything leaving the machine and every live local port
  (1234, 3000, 3777, 4000, 4199, 8100, 54322).
- `lmstudio-guard.mjs` refuses fetches to LM Studio (port 1234) and to the dead
  test port 1.
- `fake-lms` is a refusing `lms`, passed as `PRAXIS_LMS_BIN`.
- `live-port-guard.mjs` (round 4) works at `net.Socket.prototype.connect`,
  which http, https, fetch and database drivers all go through. It refuses every
  connection to a host off this machine, and every loopback connection to a port
  that was listening when the run started. A test's own server binds after that
  snapshot, so its traffic passes. Its self-test (`live-port-guard-selftest.txt`,
  63 listening ports) reaches its own server and is refused at :4000 and at
  example.com.
- `cli-shims/` (round 4) are stand-ins for `claude`, `codex`, `agy`, `lms`,
  `ollama`, `say`, `afplay` and `osascript`, first on `PATH` and named in
  `CLAUDE_CODE_BIN`, `CODEX_BIN` and `AGY_BIN`. Each records the call and exits
  1.
- `praxis-files-guarded.sh` (round 4) runs named Praxis suites under all of the
  above, keyless (`GOOGLE_API_KEY`, `YOUTUBE_API_KEY` and `PRAXIS_DATA_DIR`
  unset), with `LOCAL_LLM_URL` on port 1.
- `cortex-tests.sh` runs TheCortex's pytest with every service URL on port 1 and
  `-p offline_network_guard`; TheCortex's conftest installs `cortex_test_guard`
  as well.

The guards log to the scratch folder named in each script, deleted at the end of
the task; the logs cited below are copied here as `.txt`. Before the folder was
deleted, `guards/guard-logs-scan.py` listed every guard log in it, with its line
count and any line naming port 1234: 153 logs, no such line
(`guards/guard-logs-scan.txt`). The files in `guards/` are byte-identical to the
ones the scripts ran from that folder (checked with `cmp` before it was
deleted). To rerun a script, first copy the contents of `guards/` into the
scratch folder it names (`/Volumes/Projects/.scratch-fa032fc0`).

| File | What ran | Result |
| --- | --- | --- |
| `nexus-local-model-selection-tests.txt` | TheNexus `server/__tests__/local-model-selection.test.js` | 17/17 |
| `nexus-related-server-tests.txt` | 23 TheNexus server suites around model control, model rows, Studio, astro and the auth mounts, keyless | 268/268 |
| `dashboard-tsc.txt` | `npx tsc --noEmit` in `dashboard/`, at the end on the clean head `6e14bc87` (14:49 EST) | exit 0 |
| `dashboard-local-model-tests.txt` | `local-model-chooser`, `chat-model-control`, `fast-refresh-boundaries` | 23/23 |
| `dashboard-full-suite.txt` | dashboard `npm test` | 1460/1463 (see the failures below) |
| `dashboard-document-review-rerun.txt` | `document-review.test.mjs` alone | 21/21 |
| `dashboard-baseline-failing-tests.txt` | the two pre-existing failures on baseline `bd02642` | both fail there too |
| `praxis-local-model-selection-tests.txt` | Praxis `local_model_selection`, `local_model_primary` and `quantized_tool_gate` | 52/52 |
| `praxis-related-tests.txt` | 40 Praxis test files around the local lane, the LLM manager, autoload, the local worker, the ops routes and the route inventory | 527/527 |
| `praxis-more-related-tests.txt` | the 9 other Praxis test files that name a changed symbol (`cli-concurrency`, `LOCAL_LLM_MODEL` and the like) | 111/111 |
| `praxis-wider-tests.txt` | the 40 other Praxis test files that import the LLM manager, the local model state or the output-room wrapper (`praxis-wider-test-list.txt`, less `maintenance_review_regressions`, which makes its data dir in a shared folder); runner `praxis-wider-run.sh` | 473/473 |
| `praxis-tsc.txt` | `npx tsc --noEmit` in Praxis, at the end on the clean head `cad6afb2` (14:49 EST) | exit 0 |
| `praxis-lmstudio-guard.txt`, `praxis-fake-lms-calls.txt`, `praxis-cli-shims-related.txt` | what the guards caught in the 40-file run | 1 POST to port 1 from `member_profile_updates.test.ts` (its own dead URL, pre-existing); no call to the fake `lms` (the file is empty); 3 `--version` calls (`claude`, `codex`, `agy`); the network and live-port guards refused nothing |
| `praxis-encoding-scan.txt` | `npm run check:encoding` over the Praxis files changed | see `encoding-and-dash-scans.txt` |
| `cortex-offline-tests.txt` | 11 TheCortex test files (listed in `merged-main/merged-main-check.sh`) | 293 passed |
| `cortex-local-model-tests.txt` | TheCortex `tests/test_local_model_setting.py`, verbose | 23 passed |
| `encoding-and-dash-scans.txt`, made by `final-scans.sh` | UTF-8 scans of every file changed in each repository, and em dashes in added lines | see the file; summary at the end of this README |

In the runs behind `praxis-local-model-selection-tests.txt` (3 files, 52 tests)
and `praxis-more-related-tests.txt` (9 files, 111 tests) every guard log is
empty. In the wider run the guards caught only the pre-existing
`chat_turn_steps_legacy` calls described below (`praxis-cli-shims-wider.txt`,
`praxis-net-guard-wider.txt`).

Praxis's own test bootstrap also refuses live requests, and prints `[tests/bootstrap]
refused live fleet request` when it does:
- 20 times in `praxis-related-tests.txt`: 18 `POST :4000/api/ai/usage` and 2
  `GET :8100/api/status`. The round-3 run of the same files (519 tests, at
  `09b75ae8`) shows the same 20, so they come from suites that do not stub the
  usage report, not from this round.
- 3 times in `praxis-more-related-tests.txt` (`GET :4000/api/model-control/fable-availability`).
- 11 times in `praxis-wider-tests.txt` (`GET :8100/api/status`, `POST :4000/api/ai/usage`,
  `GET :4000/api/projects`, `GET :4000/api/model-control/claude-default`).

Nothing reached Nexus or TheCortex.

`chat_turn_steps_legacy.test.ts`, in the wider set and unchanged by this task,
spawns the `agy`, `claude` and `codex` CLIs and posts to openrouter.ai. The shims
and the network guard refused all of it: 6 CLI runs and 6 requests in the wider
run. On plain main `4d076f91` it does the same, 6 and 6, and passes there with
`quantized_tool_gate`, 13/13 (`merged-main/praxis-chat-turn-steps-and-quantized-plain-main.txt`
and its two logs). The related runs of earlier rounds had no CLI shims. The same
40 files under the shims made only the three `--version` calls listed above, so
those earlier runs started no CLI chat either; `--version` runs on this machine
and starts nothing.

## Merged with current main (`merged-main/`)

Each repository's branch diff against its baseline was applied to `git archive
main` in a scratch directory outside every repository, with the same guards. No
worktree, branch or clone was made.

### TheNexus and TheCortex

- Earlier checks, TheNexus at `f2644c44` and then `7f915704`, TheCortex at
  `0909b22`: `merged-main-check.sh` and `nexus-seed-fix-check.sh`, outputs
  beside them.
  - TheNexus first run: 269/270 (`nexus-server-tests-first-run.txt`). The
    failing test, "with no model in effect a choice is answered as waiting until
    Praxis applies it, and choosing makes no models row; the switch does",
    asserts at line 416 that no models row names Inkling 2 Mini. Main's seed,
    from the readiness task `9227d9b6`, adds that row, so the test's starting
    condition was false.
  - Fix, commit `7f915704`: the test uses a model that no seed lists
    (`acme/reasoner-12b`) and keeps every assertion. The test after it now also
    checks that a new row takes a free id (`local-gemma-4-31b-2`) when
    `local-gemma-4-31b` names another model. Mutations H2, V and W fail as they
    should (see below).
  - Dashboard: `tsc` exit 0 (`dashboard-tsc.txt`); 23/23
    (`dashboard-local-model-tests.txt`).
- After round 3, `merged-main-check-round3.sh` (output
  `merged-main-check-round3-output.txt`):
  - TheNexus main `3189bb99` plus the branch diff at `6e14bc87`, 124 files: the
    23 related server suites, 270/270 (`nexus-server-tests.txt`).
  - TheCortex main `3617672` plus the diff at `e611edc`, 12 files: 293 passed
    (`cortex-offline-tests.txt`).
  - The guards refused nothing.
- TheNexus main `a2870083` (moved at 14:58:26, retiring a review):
  `nexus-merged-main-a2870083.sh`, output in
  `nexus-merged-main-a2870083-output.txt`.
  - Main is pinned by its full hash and merged with the branch's last code
    commit `6e14bc87`. The commits after it change no file outside this
    evidence folder (the output counts 0).
  - `git merge-tree` merges without conflict (tree `3f593232`).
    - Since the base, both sides change `db/index.js`, `db/schema-sqlite.sql`
      and `server/server.js`.
    - Main changed 14 files since `3189bb99`. Of those, only `db/index.js` is
      one the branch also changes.
  - The merged copy is `git archive` of main plus the branch diff (124 files).
    It matches the merge-tree's tree file for file: 3933 files, 0 differ,
    0 extra.
  - Server suites: 27, the 23 of the earlier checks plus the four that main
    changed (`document-chat-retirement`, `document-retirement-grounds-store`,
    `document-retirements`, `document-revision-cancellation`). Result 393/393
    (`nexus-server-tests-main-a2870083.txt`).
  - Dashboard: `tsc` exit 0 (`dashboard-tsc-main-a2870083.txt`). The three
    dashboard suites of the first merged check, plus `document-retirements`,
    which main changed: 30/30 (`dashboard-tests-main-a2870083.txt`).
  - The guards refused nothing. 60 ports were listening before each run.
- TheNexus main `2a7952fc` (moved at 15:51:16; moving a document's registration
  to its landed file when the run that wrote it lands):
  `nexus-merged-main-2a7952fc.sh`, output in
  `nexus-merged-main-2a7952fc-output.txt`, 16:09:15 to 16:09:37 EST. The same
  steps as for `a2870083`:
  - `git merge-tree` merges without conflict (tree `fbea1f17`). Main changed 6
    files since `a2870083` (two db modules, the documents route, a new service,
    its new test and a contract doc), none of them one the branch changes.
  - The merged copy matches the merge-tree's tree file for file: 3936 files,
    0 differ, 0 extra.
  - Server suites: 28, the 27 above plus `document-relocations`, which main
    added. Result 401/401 (`nexus-server-tests-main-2a7952fc.txt`).
  - Dashboard: `tsc` exit 0 (`dashboard-tsc-main-2a7952fc.txt`). The same four
    dashboard suites (main changed no dashboard file): 30/30
    (`dashboard-tests-main-2a7952fc.txt`).
  - The guards refused nothing. 60 ports were listening before each run.

### Praxis, earlier rounds

- Main `24c1abaa`, at `6f9fb79b` (`merged-main-check.sh`): `tsc` exit 0
  (`praxis-tsc.txt`).
  38 of the 40 related test files exist on main (main deleted
  `trading_reflection_local_model` and `trading_reflections` in `f8e444a2`).
  Result 507/509 (`praxis-related-tests.txt`). The two failures read git (`git
  rev-parse HEAD`, `git show 1cac649:src/webhook.ts`), and the merged tree is a
  plain directory.
  - On plain main archived the same way they fail the same way: 48/50, with 8
    "not a git repository" lines (`praxis-git-reading-tests-plain-main.txt`). On
    the branch checkout they pass, 50/50
    (`praxis-git-reading-tests-branch.txt`).
  - The route inventory test passes on the merged tree with a read-only git shim
    (`praxis-git-shim.sh`) that forwards only `git show 1cac649:src/webhook.ts`,
    4/4 (`praxis-route-inventory.txt`, shim log `praxis-git-shim-log.txt`). The
    freshness test was not shimmed: it runs many git commands against its own
    repository state, so pointing it at another repository would make its
    result meaningless.
- Main `4d076f91`, at `6f9fb79b` (`praxis-merged-main-4d076f91.sh`, output
  beside it): merge-tree clean; `tsc` exit 0; 39 files, 509/511
  (`praxis-related-tests-main-4d076f91.txt`), the same two git-reading
  failures; the route inventory passes with the shim; plain `4d076f91` fails the
  same two tests (`praxis-git-reading-tests-plain-main-4d076f91.txt`, script
  `praxis-git-checks-main-4d076f91.sh`).

### Praxis after round 4 (`cad6afb2`)

Main `4d076f91`:
- `praxis-merged-main-cad6afb2.sh` (output beside it): `git merge-tree` merges
  without conflict, 17 files applied, `tsc` exit 0
  (`praxis-tsc-main-4d076f91-cad6afb2.txt`).
- The whole suite on that merged tree: `praxis-full-suite.sh`, summary in
  `praxis-full-suite-output.txt`, extract in
  `praxis-full-suite-summary-and-failures.txt`.
  - 895 of 901 suites. Left out: the six `maintenance_*` suites, which make
    their data dir under `/Volumes/Projects/maintenance-mode-worktrees` (a
    shared folder) instead of a temp dir.
  - 10,649 tests: 10,586 pass, 47 fail, 16 skipped. 31 suites have failures
    (`praxis-full-suite-failing-suites.txt`).
- The same 31 suites on plain main `4d076f91`, and again on the merged tree:
  503 tests, 457 pass, 46 fail on each (`praxis-failing-suites-plain-main.txt`,
  `praxis-failing-suites-merged.txt`).
  - The failing test lists are identical (`praxis-failing-tests-plain-main.txt`
    and `praxis-failing-tests-merged.txt`; `diff` finds no difference).
  - The guards refused the same calls on both sides: 1 POST to this machine's
    LAN address (192.168.86.205) from a callback test, `imap.gmail.com` from
    `mail_network`, `mixed.test` from `research_web_retrieval`, one connection
    to port 54322, and 6 CLI `--version` calls. Logs:
    `praxis-failing-suites-merged-*.txt` and
    `praxis-failing-suites-plain-main-*.txt`.
  - Each of the 46 is listed under "Failures that are not this task's".
- The 47th failure of the full run is `tts_provider.test.ts` "local deadline
  covers both waiting for headers and stalled response bodies"
  (`praxis-failing-tests-full-run.txt`). It passed in the 31-suite run on the
  merged tree, and alone, 35/35 (`praxis-tts-provider-alone-merged.txt`). It is
  a timing test, and it failed under the load of the full run.
- The full run's guards also refused requests from suites outside those 31
  (`praxis-full-suite-net-guard.txt`, `-live-port-guard.txt`,
  `-lmstudio-guard.txt`, `-cli-shims.txt`):
  - 2 `GET :4000/api/tasks/background-test-19`;
  - 2 `GET openrouter.ai/api/v1/models`;
  - 1 `POST vibeshiftai.com/api/reports`;
  - 3 openrouter chat requests and 3 CLI runs from `chat_turn_steps_legacy`;
  - 4 more CLI `--version` calls;
  - 2 requests to the dead port 1 (`member_profile_updates`,
    `run_model_dispatch_state`).

  The five suites behind the network requests (`background_obligations`,
  `model_prices`, `openrouter_roster`, `stakeholders`, `chat_turn_steps_legacy`)
  make the same requests on plain main `4d076f91`: 95 pass, 2 skipped, 0 fail,
  with 2 + 2 + 1 + 6 requests and 6 CLI runs refused
  (`praxis-network-hazard-suites-plain-main.txt` and its two logs).
- `praxis-copy-identity-check.sh` (output `praxis-copy-identity-check-output.txt`)
  hashes every tracked file under `src`, `tests` and `scripts`, and
  `package.json`, in each scratch copy and compares it with the git tree the
  copy stands for:
  - the plain copies with `4d076f91` and `613f66b6`;
  - the merged copies with the tree that `git merge-tree --write-tree` writes for
    the real merge of that main with `cad6afb2`.

  All four match file for file (2213, 2217, 2227 and 2231 files), with no extra
  files.

Main `613f66b6` (moved at 14:25:54, the proof-baseline lifecycle; since
`4d076f91` the only file both it and the branch change is `src/index.ts`, in
separate hunks):
- `praxis-merged-main-613f66b6.sh` (output beside it): merge-tree clean, `tsc`
  exit 0 (`praxis-tsc-main-613f66b6.txt`).
- 92 suites: the 38 related ones that exist on main (main deleted the two
  trading suites), the nine, the 40 wider ones (`quantized_tool_gate` among
  them) and the five that main added. 1134 tests, 1132 pass
  (`praxis-tests-merged-613f66b6.txt`). The two failures are the git-reading
  tests (`code_freshness_recovery`, `webhook_routes_inventory`). The guards
  caught the known calls only: `member_profile_updates`'s POST to port 1, 6
  openrouter requests and 6 CLI runs from `chat_turn_steps_legacy`, and 3
  `--version` calls (`praxis-tests-merged-613f66b6-*.txt`).
- That script archived `main` twice, and main fast-forwarded to `3b431d2b` at
  14:31:18 between the two calls. Its plain copy was therefore `3b431d2b`, which
  changes two files the branch does not touch (`src/telemetry/step-redaction.ts`,
  `tests/run_record_redaction.test.ts`); see
  `praxis-copy-identity-check-output-before-rebuild.txt`.
  `praxis-plain-main-613f66b6-rerun.sh` (output beside it) rebuilt the plain
  copy from `613f66b6` by its full hash and checked it file by file, 0 differ.
  The two git-reading suites fail there the same way, 48/50
  (`praxis-git-reading-tests-plain-main-613f66b6.txt`).

Main `fbce5c26` (moved at 14:36:24, the research-tool fixes). Its seven changed
files since `613f66b6` (the research worker and the run-record redaction) share
none with the branch, but two modules meet across the merge: the branch's
`src/nexus/client.ts` imports `src/telemetry/step-redaction.ts`, which main
changed, and main's `src/research/deep-research-worker.ts` imports
`src/llm/manager.ts`, which the branch changed.
- `praxis-merged-main-fbce5c26.sh` (output beside it) resolves main to its full
  hash once and archives that, so a later move of main cannot change the copies.
  Merge-tree clean; the merged copy matches the merge-tree's tree file for file
  (2231 files, 0 differ, 0 extra); `tsc` exit 0 (`praxis-tsc-main-fbce5c26.txt`).
- 96 suites: the 92 of the `613f66b6` check plus the four suites that import the
  research worker or the step redaction and were not already among them
  (`executor_trace_redaction`, `model_inputs_whole`, `research_worker_outcomes`,
  `run_record_redaction`). 1179 tests, 1177 pass
  (`praxis-tests-merged-fbce5c26.txt`). The two failures are the git-reading
  tests again. They fail the same way on a plain copy of `fbce5c26` (checked
  file by file: 2227 files, 0 differ), 48/50
  (`praxis-git-reading-tests-plain-main-fbce5c26.txt`).
- The guards caught the known calls only: `member_profile_updates`'s POST to
  port 1, 6 openrouter requests and 6 CLI runs from `chat_turn_steps_legacy`, and
  3 `--version` calls. The live-port guard refused nothing
  (`praxis-tests-merged-fbce5c26-*.txt`).

Main `519530a9` (moved at 15:06:11, the research tool's official sources). On
the way it passed through `e0dfe4ec` (15:01:16, document delivery records and
the document retire route). Main changed 54 files since `fbce5c26`. The only one
the branch also changes is `src/nexus/client.ts`, where the branch adds
`nexusLocalModelCurrent` and `nexusLocalModelApply`.
- `praxis-merged-main-519530a9.sh` (output beside it) pins main by its full
  hash.
  - Merge-tree clean (tree `1f7a90f8`). Since the base, both sides change
    `src/config.ts`, `src/index.ts`, `src/llm/lmstudio-autoload.ts`,
    `src/local-llm/worker.ts`, `src/nexus/client.ts` and `src/routes/ops.ts`.
  - The merged copy matches the merge-tree's tree file for file (2238 files,
    0 differ, 0 extra). The plain copy matches `519530a9` (2234 files).
  - `tsc` exit 0 (`praxis-tsc-main-519530a9.txt`).
- The suites, 144 on the merged tree (`praxis-suites144-519530a9.txt`), each
  counted once:
  - the 96 of the `fbce5c26` check;
  - every suite main changed since `613f66b6`;
  - the 56 that import `src/nexus/client.ts` or a module main changed since
    `fbce5c26`.

  The two trading suites of the earlier lists are not on main, so they were
  left out.
- First run: 1996 tests, 1984 pass, 12 fail
  (`praxis-tests-merged-519530a9-extract.txt`).
  - Ten of the twelve fail the same way on unchanged main (below, and under
    "Failures that are not this task's").
  - The other two failed in that run only. Both are in
    `document_revision_lifecycle`: "the saved whole-scope reply retires the
    three prose decisions in the podcast scope" (`'needs_review'` where
    `'reference'` was expected, line 1581) and its parent, "document change
    requests travel the shipped Nexus version lifecycle end to end".
  - That suite passed alone, 42/42, on the merged tree and on plain main
    (`praxis-lifecycle-alone-merged-519530a9.txt`,
    `praxis-lifecycle-alone-plain-main-519530a9.txt`). It also passed in the
    seven-suite run on the merged tree
    (`praxis-failing-suites-merged-519530a9.txt`) and in the 144-suite rerun.
  - It tests document code. The branch changes no document code in either
    repository, and the TheNexus checkout it loads stayed on one commit
    through every run (the last bullet below).
- The seven suites with failures, on plain `519530a9` and then on the merged
  tree (`praxis-failing-suites-plain-main-519530a9.txt`,
  `praxis-failing-suites-merged-519530a9.txt`, guard logs beside them):
  - 254 tests each. Plain main: 244 pass, 10 fail. Merged: 245 pass, 9 fail.
  - The difference is `qa_state_persistence`'s "accepted pass survives a failed
    finalization and periodic recovery retries completion only". It failed on
    plain main in both runs there and in both 144-suite runs on the merged
    tree, and passed in this one merged run.
- The 144 suites under the same load, one after the other
  (`praxis-144-load-compare-519530a9.sh`, output beside it, 15:21:21 to
  15:23:39):
  - on the merged tree: 1996 tests, 1986 pass, 10 fail
    (`praxis-tests-merged-519530a9-rerun-extract.txt`);
  - on plain `519530a9`: 142 suites, because the branch's
    `local_model_primary` and `local_model_selection` are not on main. 1955
    tests, 1945 pass, 10 fail (`praxis-tests-plain-main-519530a9-extract.txt`).

  The ten failing tests are the same on both sides. The guards caught the same
  calls in all three runs:
  - 1 POST to the dead port 1 from `member_profile_updates`;
  - 6 openrouter chat requests;
  - 1 connection to `mixed.test` from `research_web_retrieval`;
  - 9 CLI shim calls: 2 each for `agy`, `claude` and `codex`, and their 3
    `--version` calls.

  Guard logs: `praxis-tests-*-519530a9*-{net-guard,lmstudio-guard,live-port-guard,cli-shims}.txt`.
- Praxis suites reach TheNexus code through `tests/fixtures/nexus-require.ts`:
  `NEXUS_TEST_ROOT`, else a sibling `../TheNexus`, else
  `/Volumes/Projects/TheNexus`. A scratch copy has no sibling. So in every
  merged and plain-main Praxis check of this task up to `519530a9` (the
  `59cacac6` check below sets `NEXUS_TEST_ROOT`), five suites loaded TheNexus
  code from the shared checkout `/Volumes/Projects/TheNexus`. Its reflog shows
  it on main at `a2870083` from 14:58:26 on, through all the `519530a9` runs,
  and at 15:50 EST it had no tracked change (read with
  `git --no-optional-locks`, which writes nothing).
  - `praxis-nexus-root-check.sh` (output beside it, run logs
    `praxis-nexus-root-today-run.txt` and `praxis-nexus-root-round4-run.txt`)
    shows the fallback: without `NEXUS_TEST_ROOT`, a scratch copy resolves
    TheNexus's `db` to `/Volumes/Projects/TheNexus/db/index.js`.
  - Three of the suites (`document_delivery_contract`,
    `document_revision_lifecycle`, `stakeholder-living-report`) set
    `NEXUS_DB_PATH` to a temp file before they load TheNexus's `db`. The other
    two (`document_replacement_retirement`, `scope_change_gate`) do not set it,
    and TheNexus's `db/index.js` opens its own `nexus.db` when loaded without
    it.
  - Three of them also leave `NEXUS_REVIEW_BLOB_DIR` unset, and TheNexus keeps
    review blobs under its own `data/review-blobs` when it is unset
    (`server/services/review-media.js:89-91`).
  - `praxis-nexus-root-check-five.sh` (output beside it, run logs
    `praxis-nexus-root-five-today-run.txt` and
    `praxis-nexus-root-five-round4-run.txt`) runs all five suites with
    `NEXUS_TEST_ROOT` pointed at a scratch TheNexus copy that has no
    `nexus.db`. It ran with today's code and with the code of the round-4
    runs:
    - today's code: 83 tests, 82 pass, 1 skipped, 0 fail;
    - round-4 code: 76 tests, 75 pass, 1 skipped, 0 fail;
    - each time no file at all was written in the TheNexus copy (no
      `nexus.db`, no blob).

    So these runs wrote nothing into the shared checkout and never opened the
    live database.
  - The skipped test is `scope_change_gate`'s test against TheNexus's real
    policy module. It looks for `../TheNexus` itself, finds none beside a
    scratch copy, and skips. When it runs, it uses an in-memory database.

Main `59cacac6` (moved at 15:51:18, two seconds after TheNexus `2a7952fc`, by
the same task: keep review documents approvable after the run that wrote them
lands). Since `519530a9` main changed 197 files: five source modules
(`src/executors/run-worktree.ts`, `src/nexus/client.ts` and
`src/orchestrator/run-documents.ts`, `run-landing.ts` and `run-merge.ts`), two
tests, one script, one doc and 188 data records. The only one the branch also
changes is `src/nexus/client.ts`, where both sides only add lines.
- `praxis-merged-main-59cacac6.sh` (output beside it, 16:09:37 to 16:11:34 EST)
  pins main by its full hash.
  - Merge-tree clean (tree `aec51fdc`). The files both sides change since the
    base are the same six as for `519530a9`.
  - The merged copy matches the merge-tree's tree file for file (2241 files,
    0 differ, 0 extra). The plain copy matches `59cacac6` (2237 files).
  - `tsc` exit 0 (`praxis-tsc-main-59cacac6.txt`).
- The suites, 152 on the merged tree (`praxis-suites152-59cacac6.txt`): the 144
  of the `519530a9` check, plus the 8 among the 60 suites that import a module
  main changed since `519530a9` which were not already in it: `run_merge_documents`
  and `run_worktree` (both changed by main), `eod_commit_run_worktrees`,
  `run_merge`, `run_multi_repo`, `run_worktree_qa_diff`, `run_worktree_repoint`
  and `run_worktree_report`.
  - Each of the eight was read before it ran. They build their repositories
    under the system temp folder (`tests/fixtures/run-worktree-project.ts`) and
    serve TheNexus on local test servers. None names a path under
    `/Volumes/Projects`. The only live port any of them names is
    `127.0.0.1:3000`, inside a made-up error message in `run_worktree_report`;
    nothing connects to it. None of the run-worktree environment names they read
    (`PRAXIS_RUN_WORKTREES`, `PRAXIS_RUN_WORKTREE_ROOT`,
    `PRAXIS_RUN_WORKTREE_LINKS`) was set in the environment the runs inherited.
- This check set `NEXUS_TEST_ROOT` (see `nexus-require.ts` above), because
  `run_merge_documents` loads TheNexus's `db` module and documents router. The
  merged run used a scratch copy of TheNexus `2a7952fc` plus the TheNexus branch
  diff, which is what lands with it. The plain-main run used TheNexus
  `2a7952fc` alone. Neither copy had a `nexus.db`, and neither run wrote a file
  in it.
- Merged: 2158 tests, 2149 pass, 9 fail
  (`praxis-tests-merged-59cacac6-extract.txt`). The nine are nine of the ten
  `519530a9` failures under "Failures that are not this task's". The tenth,
  `email_intake_runtime`, passed in this run, and so did
  `document_revision_lifecycle`.
- The five suites with failures, run on plain `59cacac6`
  (`praxis-failing-suites-plain-main-59cacac6.txt`): 211 tests, 202 pass, and
  the same nine fail.
- The eight new suites pass on the merged tree.
- The guards caught the same calls as in the `519530a9` runs: on the merged tree
  1 POST to the dead port 1 from `member_profile_updates`, 6 openrouter chat
  requests, 1 connection to `mixed.test` from `research_web_retrieval` and 9 CLI
  shim calls (`praxis-tests-merged-59cacac6-*.txt`); on plain main the
  `mixed.test` connection only
  (`praxis-failing-suites-plain-main-59cacac6-live-port-guard.txt`).

## Mutations (`mutations/`)

Each mutation was applied in a scratch copy, never in a worktree, one at a time,
and restored before the next. The guards were on. In each run, the only failures
are the tests named in that run's output file, and each of those tests covers
the behaviour the mutation breaks.

| Mutation | What it breaks | Failing tests |
| --- | --- | --- |
| Praxis E | autoload's switched-away branch never releases the replaced model | 2 |
| Praxis F | the switch moment is not compared, so a request after the switch does not count | 2 |
| Praxis G | `planFrom` ignores Nexus's waiting flag, the condition before the round-1 fix | 1 |
| Praxis G2 | `planFrom` ignores the waiting flag altogether | 2 |
| Praxis T | `planFrom` goes back to "flag or differing names" | 1 |
| Praxis J | the primary keeps `LLM_PRIMARY_MODEL` instead of the Model Control setting | 3 |
| Praxis K | the worker writes the calendar entry before the job is counted | 1 |
| Praxis L | `chatVia` counts a pinned local call only while LM Studio answers | 2 |
| Praxis L2 | no counting in `chatVia`; only the provider wrapper counts | 2 |
| Praxis M | a call made inside a counted call is counted again | 1 |
| Praxis N | a call naming the waiting model reloads the model in effect on an empty slot | 1 |
| Praxis O | a call that waited for the apply and names the replaced model is sent anyway | 1 |
| Praxis P | the busy answer is logged every time Praxis asks | 1 |
| Praxis Q | an older answer from Nexus is acted on after a newer one | 1 |
| Praxis R | the read-back takes Praxis's spelling of the model, not Nexus's | 1 |
| Praxis R2 | the read-back compares names exactly | 1 |
| Praxis U | counting starts at `chatVia`'s entry, before the lane decision | 1 |
| Praxis s1 | a call that waited is refused whenever any earlier switch replaced the model it names | 1 |
| Praxis s2 | only the most recent switch away is judged for the idle period | 2 |
| Praxis s3 | a new spelling of the model in effect is recorded as a switch | 1 |
| Praxis s4 | a replaced model chosen again under another spelling stays recorded | 1 |
| Praxis s5 | `chat()` on a local primary is not counted as one local call | 1 |
| Praxis s6 | the count sits inside the output-room wrapper, so its retry is a second call | 1 |
| Praxis s7 | the streamed local primary uses the model listed when the call began | 1 |
| Praxis Z | `chat()` skips the quantized tool gate on its primary attempts | 1 |
| TheNexus H | choosing makes or reactivates the models row (round-1 behaviour) | 2 |
| TheNexus H2 | H again, on the test after the seed fix | 2 |
| TheNexus I | the alias editor's old `local_default` guard | 1 |
| TheNexus V | a new row takes the derived id even when another row has it | 1 |
| TheNexus W | the new row drops LM Studio's reasoning flag | 1 |
| TheNexus X | every made row claims reasoning | 1 |
| TheCortex A | `_generate_response` (`memory/client.py:181-185`) awaits between taking the model and sending it | 1 |
| TheCortex B | that per-call override is removed | 1 |
| TheCortex C | `local_model.py:109` `if _last_answer:` becomes `if False and _last_answer:`, so the last model Nexus named is not kept | 4 |
| TheCortex D | `memory/client.py:113` builds the client from `graphiti_local_model()`, a Nexus read, instead of the static fallback | 1 |
| TheCortex Y | the read-order guard in `local_model.py` is removed, so an older read that answers last replaces a newer answer | 1 |

Scripts: `praxis-mutations-ef.sh`, `praxis-mutation-g.sh`,
`praxis-mutations-jt.sh` (J to T and G2), `praxis-mutations-u.sh` (U and L2),
`praxis-mutations-s.sh` (s1 to s7), `praxis-mutation-z.sh`,
`nexus-mutations-hi.sh`, `../merged-main/nexus-seed-fix-check.sh` (H2, V, W),
`../nexus-round3-checks.sh` (X) and `cortex-mutation-y.sh`. The four TheCortex
edits A to D are described in the table, each a single replacement asserted to
match exactly once.

## Real-browser check (isolated stack)

- `local-model-browser-check.mjs`: the check. One process owns the whole stack:
  - a fake LM Studio;
  - saved load profiles in a temporary LMSTUDIO_HOME;
  - a Praxis stand-in with Praxis's switch rule;
  - a throwaway Nexus API on an empty temporary database;
  - `next dev` and headless Chrome.

  It never touches the live board, nexus.db, LM Studio or Praxis.
- `api-network-guard.mjs`: preloaded into the throwaway API. It refuses and logs
  every connection that would leave the machine or reach a live local port.
- Run the check in a copy of the tree, as `browser-check-final-tree-rerun.sh`
  does. It writes its screenshots into the tree it runs in, so a run in the
  worktree would rewrite the three registered screenshots (their clock times
  change). They would then no longer match registered revision `5a481277`.
- `browser-check-output.txt` and `report.json`: the round-1 run that made the
  registered screenshots. 61 CHECK_OK, 0 CHECK_FAIL, exit 0.
- `browser-check-final-tree-rerun.txt` and `report-final-tree-rerun.json`: the
  rerun on `7f915704`, in a scratch copy.
  - 61 CHECK_OK, 0 CHECK_FAIL, exit 0.
  - The fake LM Studio received 17 requests, all `GET /api/v1/models`.
  - The guard refused 2 read-only Cypher POSTs to :8100 from the existing
    knowledge-activity widget (`server/services/topic-access.js:23`).
  - There were no page exceptions.
  - The API logged two switches, each with "nothing was loaded".
- Since `7f915704`, TheNexus changed only its evidence and one test assertion
  (`6e14bc87`), and the dashboard has not changed since `e1bfcc97`, so that rerun
  still shows the final panel and API. Round 4 changed how Praxis counts local
  calls and which waits it refuses, which the panel does not show; Praxis's own
  tests cover it.
- `review-screenshots-vs-final-tree.txt`, made by `review-shots-compare.py`,
  compares the registered screenshots with the rerun's:
  - desktop list: byte-identical;
  - waiting shot: differs in three text lines only, the clock times of each run
    (10:45 AM and 10:41 AM against 12:39 PM and 12:35 PM). See
    `waiting-shot-differences-registered-above-rerun.png`;
  - phone shot: same size and same text. Its elements sit up to 1 device pixel
    (half a CSS pixel) higher or lower.
- `browser-check-run1-failed.txt` and `browser-check-run2-failed.txt`: earlier
  round-1 runs, kept for the record.
  - Run 1 (11 failures) expected LM Studio's names where the panel shows the
    registry names ending in " (local)". The check was corrected to the
    documented names. Run 1's screenshot also showed the tall alias card
    stretching the Global Local Only box, which led to the layout fix in
    `dashboard/src/app/model-control/page.tsx`.
  - Run 2 (22 failures) clicked with CDP mouse events after a separate hit test.
    The layout moved between the two, so the click missed and later steps
    failed. The check now hit-tests and clicks in one page task.
- Screenshots that are not review subjects (round 1):
  - `phone-switch-waiting.png`: the waiting state at phone width.
  - `desktop-switch-applied-after-job.png`: after the local job ended, Inkling is
    in effect, with no reload.
  - `desktop-restored-in-one-action.png`: Restore brings Gemma back and records
    it as its own switch.
  - `desktop-new-download-listed.png`: a newly downloaded model appears in the
    list.
- `document-readiness-final.json`: one read-only
  `GET /api/documents/23c8a260-f109-4585-883d-8b64b9937a0b/readiness?revision=5a481277-a8eb-43eb-b35d-f11bd9b2e508`
  at 13:19 EST (18:19:40Z). It reports ready, 3 of 3 required screens servable.
  The content hash of each screen in the response matches the file in the
  package folder (`shasum -a 256`), and that folder has no uncommitted change.

## Live state (criterion 9)

- `live-services-before-browser-check.txt`: listener PIDs and start times of LM
  Studio, the dashboard, the Nexus API, TheCortex and Praxis, taken in round 1
  before the browser check.
- `criterion-9-live-readback.txt`: the round-1 read-back (10:59 EST).
- `criterion-9-final-readback.txt`, made by `criterion-9-readback.sh`: the
  read-only read-back at the end of the task, 16:14:39 EST, after the last test
  run. Apart from its clock times it is line for line the same as the 13:00,
  14:39, 14:51 and 15:52 read-backs before it.
  - The live `local_default` alias is still Gemma 4 31B QAT
    (`google/gemma-4-31b-qat`); the alias row was last updated 2026-06-03.
  - The live database has no `local_model_switches` table and no
    `local_model_selection` setting, since the change has not landed.
  - LM Studio's listing: no chat model is loaded. Only the embedding model is
    loaded.
  - The PIDs for LM Studio, the dashboard, the Nexus API and Praxis are the same
    as before. TheCortex has a new PID (8089, started 11:50:22 EST).
  - LM Studio logged four loads today: 04:48, 05:08, 05:27 and 10:25 EST. Each
    matches a Praxis autoload line, logged when a local call found no model
    loaded.
    - The first three fall inside the 22:00-06:00 ET local-lane window.
    - The 10:25 load is outside it. The read-back's LocalLane line names its
      grant: TheCortex's Graphiti ingestion, under Robert's standing grant with
      on-demand reload (2026-11-07).
- `criterion-9-attribution.txt`, made by `criterion-9-attribution.sh`: who
  restarted TheCortex and who unloaded Gemma.
  - At 16:46:29Z Robert asked his live Praxis chat session whether TheCortex's
    daytime graph ingestion should be stopped. At 16:49:17Z he said "stop it".
  - That session sent SIGTERM to TheCortex at 16:49:36Z. The supervisor's
    heartbeat restart then SIGKILLed and respawned TheCortex at 16:50:22Z.
  - At 16:51:58Z the same session ran `lms ps` and
    `lms unload google/gemma-4-31b-qat`. LM Studio logged the matching lms-cli
    clients at 11:51:58 and 11:51:59 EST.
  - Bridge tokens are redacted, and the agent's replies are quoted only up to
    their first findings heading.

This task loaded no model, unloaded none, called no local chat model and
restarted no service. Its only contact with LM Studio was nine listing requests
(`GET /api/v1/models`), and a listing loads nothing:
- 07:54 and 08:26 EST, to read the real listing's shape before writing the fake;
- one in each read-back, at 11:00, 12:46, 13:00, 14:39, 14:51, 15:52 and 16:14
  EST.

`criterion-9-lmstudio-contact.sh` (output `criterion-9-lmstudio-contact.txt`,
16:14:45 EST, read-only) checks this from both sides, from this run's first
start (21:39:35 EST on 2026-11-23) on:
- LM Studio's own server log has ten `GET /api/v1/models` requests in that time.
  Nine are the ones above, each within a second of the tool call that sent it.
  The tenth, at 21:47:18 EST on 2026-11-23, came while this run's session was
  idle (its longest pause, 21:40:38 to 07:42:09), so another client sent it.
  The six `GET /v1/models` requests fall in the same pause.
- In the session transcript and its six subagents' transcripts, 9 Bash calls
  send to LM Studio: the nine above. The 17 other Bash calls whose text names
  port 1234 are search patterns and scans; the file lists each one.
- The `GET /api/v0/models` polls and every `POST` (chat completions and
  embeddings) come from other clients. No Bash call of this run sends one, and
  its test runs could not reach port 1234 (next paragraph).

In every test run the guards refused LM Studio's port, 1234: the network guard
and the LM Studio guard in the Praxis and TheNexus runs, the live-port guard as
well in round 4, and TheCortex's offline guards with every service URL on port
1. The 153 guard logs in the scratch folder, scanned before it was deleted, show
no request to port 1234 (`guards/guard-logs-scan.txt`).

## Failures that are not this task's

- Dashboard `daily-journal-tabs.test.ts:6` fails with ENOENT. It reads
  `../../nexus-shared/src/notes.ts`, the sibling repo that sits beside the main
  checkout but not beside a worktree.
- Dashboard `routing-economics.test.mjs:16` fails on a cost figure ($1.820 shown
  where it expects $2.525). This one and the ENOENT failure above also fail on
  baseline `bd02642` (`dashboard-baseline-failing-tests.txt`).
- Dashboard `document-review.test.mjs:181` failed once in the full run. It waits
  a fixed real-time interval for a delivery poll and timed out under load. It
  passed in the earlier full run and passes alone.
- Praxis `voice_prose_deadline.test.ts:29` failed once in round 1. It checks the
  HTTP close 20 ms after a rejection. It passes alone and in the final related
  run (`praxis-related-tests.txt`, 40 files, 527/527).
- Praxis `tts_provider.test.ts` "local deadline covers both waiting for headers
  and stalled response bodies" failed once in the full run, under load, and
  passes alone (35/35).
- TheNexus `studio-route.test.js` has an enrich test that fails whenever a
  GOOGLE_API_KEY is present, on baseline `bd02642` too. See
  `nexus-studio-route-dummy-key-this-branch.txt`,
  `nexus-studio-route-dummy-key-baseline.txt` and the guard logs
  `nexus-net-guard-studio-*.txt`, where YouTube requests were refused. The final
  runs are keyless.
- On the merged trees, two Praxis tests that read git cannot pass in a plain
  directory (`code_freshness_recovery`, `webhook_routes_inventory`; see the
  merged section).
- The 46 failures of the full Praxis run that fail the same way on plain main
  `4d076f91` (above). Each suite below, with the first error it shows. The
  copies have no `.git` and sit in a scratch folder with no sibling `TheNexus`,
  and the guards withhold the CLIs, hosts and ports some of these tests expect;
  whatever the cause, each fails identically on unchanged main.

| Suite | Failures | First error shown |
| --- | --- | --- |
| `agent_tool_results_whole` | 1 | `(Claude Code returned empty output)` where a completed result is expected |
| `alert_investigation` (with its `alert-investigation-audit-cases.ts`) | 3 | `inconclusive` where `reported` is expected; `undefined == true` |
| `checkpoint_end_to_end` | 1 | temp log dir must be removed after the run |
| `cli_seat_agy_startup` | 1 | temp log dir must be removed after the run |
| `cli_seat_unlimited` | 2 | `null !== 'reviewed'` |
| `code_freshness_recovery` | 1 | not a git repository |
| `consultation_memory` | 1 | Cannot find module `../../TheNexus/db/member-memory.js` |
| `dashboard_record_header` | 3 | Maximum call stack size exceeded in `src/telemetry/step-redaction.ts` |
| `email_intake_council` | 1 | `[redacted]` where a run id is expected |
| `email_intake_runtime` | 1 | `[redacted]` where a run id is expected |
| `evidence_bundle` | 1 | `[redacted]` where a run id is expected |
| `executor_discovery` | 1 | `[]` where `['process 101']` is expected |
| `followup_evidence` | 1 | the catalog check is falsy |
| `followup_evidence_review` | 1 | a finding kept for focused investigation |
| `long_task_executors` | 5 | empty output where `work completed` is expected |
| `mail_network` | 1 | the live-port guard refused `imap.gmail.com` |
| `member_conversation_eval` | 1 | a child `node` command failed |
| `member_profile_pilot` | 1 | Cannot find module |
| `model_inputs_whole` | 3 | assertions on whole sessions and few-shot blocks (main fixed these at 14:31, `289f675c`) |
| `quota_yellow_alert` | 4 | `undefined` where `acknowledged`, `claude-code` or `unknown` is expected |
| `report_intake_questions` | 1 | a child run's output does not match |
| `report_intake_slot_failure` | 1 | a child run's output does not match |
| `research_web_retrieval` | 1 | `[]` where `['mixed...']` is expected (the guard refused `mixed.test`) |
| `stakeholder-living-report` | 1 | Cannot find module |
| `tool_schema_honesty` | 2 | undeclared tool argument `search_conversations` |
| `upgrade_preflight` | 1 | HEAD must be recorded as the rollback target |
| `vault_source_delivery` | 2 | `'full' !== 'focused'` |
| `verification_protocol` | 1 | a record differs from the expected one |
| `webhook_callback_route` | 1 | `git show 1cac649:src/webhook...` failed |
| `webhook_routes_inventory` | 1 | not a git repository |

On main `519530a9` the 144 suites of that merged check fail ten tests. Each
also fails on a plain copy of `519530a9`
(`praxis-tests-plain-main-519530a9-extract.txt`,
`praxis-failing-suites-plain-main-519530a9.txt`):
- `alert_investigation`, the three of the table:
  - "3: callback records execution-scoped usage already captured from the
    native CLI stream" (line 671);
  - "5: real registry recovery reads full completed findings instead of the
    truncated preview" (line 607);
  - "real Antigravity completion reaches the shared audit and retains findings
    with explicit unsupported evidence", in `alert-investigation-audit-cases.ts`
    (`undefined == true`).
- `code_freshness_recovery`, `email_intake_runtime` (the whole file),
  `research_web_retrieval` and `webhook_routes_inventory`, one each, as in the
  table.
- `qa_state_persistence`, three tests. They are not in the table: the suite
  passed in the round-4 full run.
  - The tests: "3c: a reviewer that died with the daemon is retried on a
    different executor with NO strike" (`1 !== 2` at line 578); "B′: after a
    restart, the reviewer's callback with the RIGHT qaReviewId is 200 and
    finalizes" (a falsy check at line 739); "accepted pass survives a failed
    finalization and periodic recovery retries completion only" (`2 !== 1` at
    line 887).
  - Alone, the suite fails those three on plain `519530a9` and on the merged
    tree alike, 12/15, and passes on plain `4d076f91`, 15/15. Logs:
    `praxis-qa-state-alone-plain-main-519530a9.txt`,
    `praxis-qa-state-alone-merged-519530a9.txt` and
    `praxis-qa-state-alone-plain-main-4d076f91.txt`, each run with
    `guards/praxis-files-guarded.sh <copy> <tag> qa_state_persistence`. The
    guards caught nothing.
  - The test file is the same at both commits. Between them, main changed
    three modules it imports: `src/executors/detached-run.ts`,
    `src/executors/executor-callback.ts` and `src/orchestrator/qa-dispatch.ts`.
    The branch changes none of them.

`document_revision_lifecycle` failed two tests in the first merged run on
`519530a9` only. They passed in every later run, alone on both trees as well
(see the merged section).

On main `59cacac6` the 152 suites of the last merged check fail nine of these
ten tests on the merged tree (`email_intake_runtime` passed in that run). The
five suites behind the nine fail the same nine on plain `59cacac6`
(`praxis-failing-suites-plain-main-59cacac6.txt`).

## Round-1 records kept

- `praxis-related-tests-earlier-run.txt`: 35 files, 470/470 at 09:18.
- `praxis-voice-deadline-rerun.txt`: `voice_prose_deadline.test.ts` alone, 5/5.
- `nexus-net-guard-studio-first-dummy-key-run.txt`.
- The two failed browser runs and the non-subject screenshots listed above.

## Scans

`final-scans.sh` writes `encoding-and-dash-scans.txt` and
`praxis-encoding-scan.txt`. At the end of the task:
- UTF-8 (fatal decoder, BOM, U+FFFD): no problems in 290 TheNexus files (298
  changed or added against `bd02642`, 8 PNGs skipped), 12 TheCortex files and 17
  Praxis files. Praxis's own `npm run check:encoding` passes on the same 17.
- Em dashes in added lines: 0 in Praxis, 0 in TheCortex, 0 in the TheNexus code,
  docs and scripts this task wrote. The verbatim outputs in this folder carry
  the products' own log wording.
- The dashboard has no change since `e1bfcc97`.
- The registered package: the three PNGs hash to the registered values, the
  folder has no uncommitted change, and it holds the three PNGs and
  `local-model-control.design.json`.
