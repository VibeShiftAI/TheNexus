# Evidence: local model chosen under Model Control (task fa032fc0, 2026-11-24)

The review package in `../2026-11-23-local-model-control/` holds only the three
review screenshots (registered revision `5a481277`). Everything else that backs
the task is here. Test and log outputs are copied verbatim, so they can contain
the products' own wording (including dashes in their log messages). Nine files
are extracts rather than whole logs, each cut verbatim by
`merged-main/praxis-full-suite-extract.sh` (the command, the "Running N of M"
line, then the runner's summary and every failure with its detail; the passing
output is left out, and each extract says which lines):
`merged-main/praxis-full-suite-summary-and-failures.txt` (from a 6.1 MB log),
the three `merged-main/praxis-tests-*519530a9*-extract.txt` (from logs of 1.5
to 1.6 MB), `merged-main/praxis-tests-merged-59cacac6-extract.txt` (from a
2.0 MB log), `merged-main/praxis-tests-merged-1bac2ea7-extract.txt` (from a
2.3 MB log), and `merged-main/praxis-tests-merged-1bac2ea7-a8caeb09-extract.txt`,
`merged-main/praxis-tests-merged-1bac2ea7-bd19e926-extract.txt` and
`merged-main/praxis-tests-merged-1bac2ea7-196a5375-extract.txt` (from logs of
2.3 MB each; the first two were cut again from their logs at 20:13 EST and
matched byte for byte, and the third was cut at 20:39:32 EST from the log its
run finished writing at 20:38:22).

Three repositories changed, each on its own task branch:

| Repository | Baseline | Branch head | Main at the merged checks |
| --- | --- | --- | --- |
| TheNexus | `bd02642` | `6e14bc87`, plus evidence-only commits after it (`f8761e33`, `f011c4ee`, `1d74cad1`, `6c3e913f`, `c5b44405` and the one that adds this update) | `3189bb99`, `a2870083`, then `2a7952fc` |
| Praxis | `1fcf4b59` | `196a5375` (round 7; round 6 ended at `bd19e926`, round 5 at `a8caeb09`, round 4 at `cad6afb2`) | `24c1abaa`, `4d076f91`, `613f66b6`, `fbce5c26`, `519530a9`, `59cacac6`, then `1bac2ea7` (conflicts) |
| TheCortex | `5fdb76a` | `892708c8` (round 5; round 4 ended at `e611edc`) | `3617672`, `b06ed4dc` (conflicts), then `17ee69ce` (the same conflict) |

The mains kept moving while the task ran. The last mains the branches merge
with cleanly are TheNexus `2a7952fc` (main since 15:51:16 EST), Praxis
`59cacac6` (main since 15:51:18; one task landed both), each pinned by its full
hash and checked from 16:09:15 to 16:11:34 EST, and TheCortex `3617672` (main
from 09:01:33). At 16:22 EST task `98d0b1b9` landed Praxis `1bac2ea7` and
TheCortex `b06ed4dc`, and both task branches conflict with them, in lines that
both sides add. This run does not merge main (the brief forbids it). Copies with
the conflicts resolved were built and tested outside every repository; see
"Praxis `1bac2ea7` and TheCortex `b06ed4dc`" below. At 17:04:50 EST task
`2717b41c` landed TheCortex `17ee69ce`, which adds a script and two document
lines that the branch does not touch; the TheCortex branch conflicts with it in
the same file, and the same resolution passes the same tests (same section).
TheNexus main is still `2a7952fc`. After review round 5 the branch heads moved
to Praxis `a8caeb09` and TheCortex `892708c8`, and both were checked again on
the same mains: Praxis `1bac2ea7` and TheCortex `17ee69ce` (same section).
After review round 6 the Praxis head moved to `bd19e926`, and after review
round 7 to `196a5375`; each was checked again on Praxis `1bac2ea7` (same
section). TheCortex and TheNexus code did not change in rounds 6 and 7. The
times come from each shared checkout's reflog for `main`. A main
that moves after the time given at the end of this README is not covered here.

The task's commits, oldest first:

| Repository | Commits |
| --- | --- |
| TheNexus | `fc23f07a`, `d93b3453`, `5d43f2c9`, `3770d86e`, `e1bfcc97` (round 1 and its evidence); `f2644c44`, `7f915704`, `09b75ae8` (the model row made at apply, the seed fix, the evidence update); `6e14bc87` (reasoning checked both ways) |
| Praxis | `766635bc`, `ac0b13e0`, `90d44073`; `6f9fb79b` (switch findings held, local primary follows Model Control); `cad6afb2` (round 4, below); `3d6760b1`, `a8caeb09` (round 5, below); `59161c6e`, `bd19e926` (round 6, below); `196a5375` (round 7, below) |
| TheCortex | `42b67e2`, `ea37c44`, `0909b22`; `e611edc` (overlapping reads, below); `892708c8` (reads one at a time, round 5, below) |

## Precondition (criterion 1)

`criterion-1-precondition.sh` (output `criterion-1-precondition.txt`, 20:54:01
EST, read-only; the same as the 17:12:04 output apart from its time and the
three branch heads) finds the readiness task's commits by their trailer
(`git log main --grep=9227d9b6`). For each one it asks git whether the commit is
on main and under the task branch's head (`git merge-base --is-ancestor`). Then
it runs the brief's own check as the brief writes it.

| Repository | Readiness commits (task `9227d9b6`) | On main | Under the branch head |
| --- | --- | --- | --- |
| TheNexus | `9de7bed6` (its merge, 2026-11-23 22:47:28), `1104ec89`, `22d86d03` | all 3 (main `2a7952fc`) | no |
| Praxis | `1fcf4b59` (its merge, 2026-11-23 22:48:04), `de1c5916`, `884135de`, `1a82f9e8`, `694c867a`, `0bc2c8fb` | all 6 (main `1bac2ea7`) | yes (`196a5375`) |
| TheCortex | `5fdb76a`, `2d7c015` | both (main `17ee69ce`) | yes (`892708c8`) |

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
`5fdb76a`) under "Before" and the branch heads' (`196a5375`, `6e14bc87`,
`892708c8`) under "Now" (output of 20:40:09 EST; against the 19:52:05 output
for `bd19e926`, only two lines of `src/llm/lmstudio-autoload.ts` moved, each
one down: the autoload model read, now `:678`, and a doc comment, now `:1092`).

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
  - These are the same lines at both commits, except three:
    - autoload's is now `llm/lmstudio-autoload.ts:678`;
    - the member-profile drain's is now `council/member-profile-updates.ts:215`.
      Since round 5 it hands the extractor a function
      (`model: () => config.localLlmModel`), which the extractor calls at each
      extraction (`:59`), so an extractor made before a switch asks the model in
      effect;
    - spoken prose's is now `voice/spoken-prose.ts:121`. Since round 6 the same
      call also passes the count of switches, read in the same synchronous step
      as the model (`localModelSwitches: localModelSwitchCount()`, `:132`), so
      the slot claim refuses the call if a switch takes effect before it reaches
      LM Studio's slot.
  - Each reads the getter when it runs, so its next use after a switch gets the
    new model.
  - Autoload's load target and the slot check (`claimLocalSlot`, `:1512`) both
    take the model from `expectedLocalModel()` (`:677-678`).
- **P3, the LLM manager's local provider, local lanes and local fallback**
  (`src/llm/manager.ts`).
  - Before: `:294` gave the local provider the model as a value when the
    manager was built. `:764`, `:809`, `:915`, `:1097`, `:1168`, `:1323-1324`
    and `:1338` read `config.localLlmModel`.
  - Now: the provider gets a function, `:338` (`() => config.localLlmModel`),
    so it reads the model at each call. The other reads are now at:
    - `:855`, `:900`, `:1006` and `:1278`;
    - `:1199` and `:1205`, a role's local target and the local fallback (P6);
    - `:1468`, the credit preflight's reroute. Since round 5 it reads the model
      once, with the count of switches (`:1469`), for its request, its slot
      claim and its usage report. At `cad6afb2` it read the model three times
      (`:1414-1415`, `:1429`).
- **P4, a local primary (`LLM_PRIMARY_PROVIDER=local`).**
  - Before: `manager.ts:302-308` set the primary's model to `LLM_PRIMARY_MODEL`.
  - Now: `primaryModel()` (`:386-387`) returns `config.localLlmModel` when the
    primary provider is local. `:353` still records `LLM_PRIMARY_MODEL` for any
    other provider.
  - On this machine the primary provider is not local.
- **P5, `switchModel("local/<name>")`.**
  - Before: `manager.ts:693` set `activeModel` to the name, and local calls ran
    it.
  - Now: `:784` still records the name, but local calls run
    `config.localLlmModel`. The reply says so (`:774-775`: "local calls run
    ..., the local model chosen under Model Control, not ...").
- **P6, a role that resolves through `local_default`.**
  - Before: `manager.ts:1139` built the role's target from the name Nexus sent,
    the alias target's fixed model name.
  - Now: Nexus marks such a role `followsLocalModel` (TheNexus
    `server/services/model-control.js:373`). Praxis keeps the mark
    (`manager.ts:1248-1249`) and runs `config.localLlmModel` for that role
    (`:1199`). A streamed local primary does the same (`:1686`, `:1742`).
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
      `llm/lmstudio-autoload.ts:1541-1551`).
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
  - `local_model_or` (`:142`) reads `GET /api/model-control/local-model/current`
    through `_read_after_asking` (`:112`), which sends one read at a time. A
    caller that asks while a read is in flight waits for it (`:118`), then
    shares the next read, so the last answer to come back is the newest.
  - It keeps that answer (`:136`), for use during an outage.
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
  sends what its own read returned. Review round 5 found that numbering reads
  as they start does not order Nexus's answers; `892708c8` replaced it (below).
- At `e611edc`, `tests/test_local_model_setting.py`: 23 passed. The new test
  made two overlapping reads, the older one coming back last, then an outage:
  Graphiti and the eval teacher kept the newer model.
- At `e611edc`, the 11 offline test files: 293 passed.
- `cortex-local-model-tests.txt` and `cortex-offline-tests.txt` held these two
  runs until `c5b44405`. They now hold the runs on `892708c8` (below).
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

The round-4 test runs on the branch (the selection, nine-file, related and
wider runs; first log lines 14:05:12 to 14:07:43 EST) started after the last
edit to the seven committed files (14:04:38) and before the commit (14:09:43),
so each ran exactly the committed code. Their copies are in this folder as of
`c5b44405`; the files the results table below names now hold the round-5 runs
on `a8caeb09` (next section). The exceptions are named:
`praxis-wider-tests-before-fixture-fix.txt` ran at 14:00, before the fixture
change; both `tsc` runs and the encoding check ran at the end, on the clean
branch heads; the merged-tree runs used the committed diff. Mutations s1 to s7
ran at 13:54 on `6f9fb79b` plus a patch of six files
(the four source files and the two test files), identical to
`6f9fb79b..cad6afb2` for those files; the seventh file,
`tests/quantized_tool_gate.test.ts`, is not part of their runs.

## Changes since the 17:14 evidence update (`c5b44405`)

### TheCortex `892708c8`

Code review of `e611edc` found that numbering reads as they start does not
order Nexus's answers. A read numbered second can reach Nexus first, before
Praxis applies a switch, and win over a read numbered first that Nexus served
after the switch; an outage then sends every direct call to the model the
switch replaced. Nexus's answer carries nothing that orders it.

- Reads now go out one at a time (`python/cortex/local_model.py`,
  `_read_after_asking`, `:112-139`), so the last answer to come back is the
  newest. A caller that asks while a read is in flight waits for it (`:118`),
  then takes the next read, shared by every caller waiting when it starts
  (`:120-122`). However many Graphiti calls ask at once, Nexus sees one request
  at a time, and no caller queues behind other callers' reads. A read that
  raises frees the slot for a waiting caller (the `finally` at `:129-138`).
  `local_model_or` (`:142`) returns what it did before: the model the call's
  own read named, else the last answer, else the environment fallback.
- `tests/test_local_model_setting.py`, 23 cases before and 26 now: the
  overlapping-read test is replaced by one where the second read would have been
  served first, before the switch; three new cases cover callers sharing the
  next read, an outage reaching every waiting caller, and a read that raises.
- `cortex-892708c8-checks.sh` (output in `cortex-892708c8-checks-output.txt`)
  checks that the worktree is at `892708c8` with no changes, then runs, through
  `cortex-tests.sh`: the setting tests verbose, 26 passed
  (`cortex-local-model-tests.txt`); the 11 offline files, 296 passed
  (`cortex-offline-tests.txt`); the setting tests 25 times in a row, 26 passed
  each time (`cortex-local-model-repeat.txt`), because these tests use threads.
  No file in the worktree changed or appeared, and nothing under
  `/Volumes/Projects/maintenance-mode-worktrees` changed.
- Mutations R1 to R4 (`mutations/cortex-mutations-r.sh`, results and the diff
  each made in `mutations/cortex-mutations-r.txt`), each in a scratch copy of
  `892708c8`; the control run passes 26:
  - R1, a caller sends its read while another is in flight: 4 fail.
  - R2, a waiting caller takes the answer of a read that started before it
    asked: 3 fail.
  - R3, a read that raises leaves the in-flight mark set and wakes no one: 1
    fails, the raising-read case.
  - R4, a waiting caller sends its own read even when one it can share came
    back: 2 fail.
- Mutation Y is kept as the record of `e611edc`. The read-order guard it
  removed is gone at `892708c8`.
- Merged with TheCortex main `17ee69ce`: 328 passed (see "Merged with current
  main").

### Praxis `3d6760b1` and `a8caeb09` (round 5)

Line numbers in this section are `a8caeb09`'s. Round 6 (next section) moved
the slot claim's lines in `src/llm/lmstudio-autoload.ts` and changed how the
refusal message tells its two cases apart; `manager.ts` and `providers.ts` did
not move.

The review of `cad6afb2` found two gaps in the round-4 fixes.

1. The slot claim took its count of switches when the claim started. A call
   that read Gemma before a switch, and was still in admission (LM Studio's
   process check) when the switch took effect, reached the claim with no switch
   "during its wait" and was answered by Gemma. The count is now taken where
   each call reads its model:
   - a local primary's attempt, `src/llm/manager.ts:505` (`tryPrimary`);
   - a pinned call, at `chatVia`'s entry or from its caller
     (`options.localModelSwitches`), `:1362`;
   - a role resolved through local_default, in role resolution (`current()`,
     `:1199`, and the local fallback, `:1205`), passed on by `completeRouted`
     (`:1134`) and the stream candidates (`:1682`);
   - each stream candidate when it is tried, `:1744`;
   - the credit preflight reroute, `:1469`.

   The local provider passes the count to the claim, and sets the key only when
   the caller read one (`switchesReadBy`, `src/llm/providers.ts:300`, used at
   `:338` and `:343`). The claim refuses the call when a switch numbered after
   that count replaced its model (`src/llm/lmstudio-autoload.ts:1511`,
   `:1525-1526`). The refusal says which case it was (`:1641-1649`): the switch
   was recorded while the call waited for it, or it took effect after the call
   read its model and before the call reached LM Studio's slot, so the call is
   not sent.
2. A local call made by work that a counted call started without waiting for it
   (an event published from an autoload swap whose brief calls the local model)
   was skipped by the counter while the first call's context lingered, so a
   switch could take effect while it ran. In `trackLocalCall`
   (`src/llm/local-lane-policy.ts:374-398`) a call made inside a counted call
   that is still open now joins it and keeps it counted until the inner call
   ends; one made after that call ended counts itself. `chatVia` counts every
   local call through the same path (`manager.ts:1363`).

Also in `3d6760b1`: the member-profile extractor reads the local model at each
extraction (`src/council/member-profile-updates.ts:59`, given
`() => config.localLlmModel` at `:215`), so an extraction made before a switch
asks the model in effect.

`a8caeb09` followed. On `3d6760b1` the local provider passed
`localModelSwitches: undefined` to the claim when the caller gave none, which
changed the wait object a provider's claim receives.
`tests/local_inference_safety.test.ts` "the slot claim is given the caller's own
deadline, fixed when the call enters the provider" compares that object
exactly (a key set to `undefined` is not the same as no key there) and failed
in the 40-file run on `3d6760b1`, 535/536
(`praxis-round5-3d6760b1-sets-output.txt`). The test was not changed; the key
is now set only when the caller read a count.

Tests: nine new cases, eight in `tests/local_model_selection.test.ts` (37
before, 45 now) and one in `tests/local_model_demand_callers.test.ts`.
- Four send a call while a switch from Gemma to Inkling takes effect during the
  call's admission: a pinned `chatVia`, `chat()` on a local primary,
  `complete()` for a role resolved through local_default, and a streamed call
  for such a role. Each is refused at the slot claim with the "after this call
  read it" message. No request reaches the stand-in for LM Studio's server and
  the fake loader records no call. The pinned call is deferred; the other three
  are answered by the cascade or the next candidate.
- One has the switch take effect after a role's model is read and before
  `complete()` makes the call; the call is refused.
- One unit case: a call that read its model before a switch is refused at the
  claim even when the switch took effect before the claim began, and one that
  read it after the switch is not.
- Two cover the second gap: local work a counted call starts and leaves running
  stays counted until it ends (joined while that call is open, counted on its
  own once it has ended), and a local call such work makes holds a switch until
  it ends and is counted once.
- One (in `local_model_demand_callers`) shows that an extractor made before a
  switch claims the slot for, and asks, the model in effect.

The admission cases use the real local provider and the real slot claim
(`assertLocalSlot`), reading the fake LM Studio listing and fake loader the
suite already sets up, with two stand-ins: a chat server the test binds on a
loopback port of its own, and an admission step that waits until the test opens
it, where the real one awaits LM Studio's process check
(`localProviderWithHeldAdmission` and `sendWhileSwitchTakesEffectInAdmission`
in `tests/local_model_selection.test.ts`). Nexus's answer to the switch is held
until the call has reached admission.

Mutations (`mutations/praxis-mutations-round5.sh`, results and the diff each
made in `mutations/praxis-mutations-round5.txt`), each in a scratch copy of
`a8caeb09`, running the three suites the new cases are in
(`local_model_selection`, `local_model_demand_callers`, `local_lane_policy`,
64 tests) under the same guards. The control run passes 64/64, every guard log
is empty in all thirteen runs, and each mutation fails only cases that cover
the part it removes:

| Mutation | What it removes | Failing cases |
| --- | --- | --- |
| n1 | the claim ignores the caller's count and takes its own when it starts | 6 |
| n2 | the provider's `chat` does not pass the count to the claim | 4 |
| n3 | the provider's `chatStream` does not pass the count to the claim | 1 |
| n4 | a local primary's attempt does not take the count with its model | 1 |
| n5 | `chatVia` does not pass the count to the provider | 3 |
| n6 | `complete()` does not pass on the count read with the role's model | 1 |
| n7 | `chatStream` does not pass the count to the provider | 1 |
| n8 | role resolution does not take the count with the role's model | 1 |
| m1 | a call made inside a counted call is not counted at all (the round-4 counter) | 2 |
| m2 | a call made inside an open counted call joins it without holding it open | 5 |
| m3 | `chatVia` does not count a call made inside a counted call (the round-4 `chatVia`) | 1 |
| mp | the member-profile extractor reads the model once, when it is made | 1 |

Runs, each under `praxis-files-guarded.sh` or `praxis-wider-run.sh`:
- On `3d6760b1` (`praxis-round5-3d6760b1-sets.sh`, which printed that head;
  output in `praxis-round5-3d6760b1-sets-output.txt`): the 40 related files,
  535/536 (above); the more-related files, 130/130; the wider set, 473/473. The
  per-run logs of these were replaced by the `a8caeb09` runs, which used the
  same tags; the output file keeps their summary lines.
- On `a8caeb09` (`praxis-round5-a8caeb09-sets.sh`, 18:34:28 to 18:35:25 EST,
  head printed before and after; output in
  `praxis-round5-a8caeb09-sets-output.txt`): the mutations above; the three
  suites holding the new cases, 64/64; the 40 related files, 536/536
  (`praxis-related-tests.txt`); the more-related files, 130/130
  (`praxis-more-related-tests.txt`); the wider set, 473/473.
- On `a8caeb09` at 18:37, `local_model_selection`, `local_model_primary` and
  `quantized_tool_gate`
  (`bash $S/praxis-files-guarded.sh $P sel3-r5 quantized_tool_gate local_model_selection local_model_primary`):
  60/60 (`praxis-local-model-selection-tests.txt`).
- On `a8caeb09` at 18:48:55 (`praxis-round5-rerun.sh`, output in
  `praxis-round5-rerun-output.txt`; head `a8caeb09` with 0 changed files before
  and after): the wider set again, 473/473 (`praxis-wider-tests.txt`), then
  `praxis-chat-turn-steps-alone.sh` (see the `chat_turn_steps_legacy`
  paragraph below).
- The more-related run is the nine files of round 4 plus `lane_credit`
  (`praxis-round5-more-related-names.txt`; the 40 related files are in
  `praxis-round5-related-names.txt`). `praxis-round5-importers.sh` (output in
  `praxis-round5-importers.txt`) lists the 68 test files whose text names a
  module round 5 changed (it printed "importing", which is wrong for one file),
  and `lane_credit` was the only one in none of the three lists.
  - Corrected in round 6: this paragraph said `lane_credit` tests the credit
    preflight reroute. It does not: it names `llm/manager.ts` only in a comment
    (`tests/lane_credit.test.ts:103`) and imports none of the changed modules
    (`praxis-round6-importers.txt`). It was run all the same. The reroute
    through `chatVia` is exercised by `critic_deadline_routes`
    ("deadline-scoped credit reroutes never leave delayed queue retries",
    `tests/critic_deadline_routes.test.ts:159`, in the related list), and since
    round 6 by a case of its own (next section).
  - The wider run leaves out `maintenance_review_regressions`, as in round 4
    (it makes its data dir in a shared folder).
- `praxis-tsc.txt`: `npx tsc --noEmit` on the clean head `a8caeb09`, exit 0.

What round 5 leaves as it was, or does not cover (the first and fifth items are
fixed or covered in round 6, next section):
- `voice/spoken-prose.ts` reads `config.localLlmModel` at `:114`, as the
  argument to its default `chatVia`, which first awaits
  `import("../llm/manager.js")` (`:109-112`) and only then calls the manager's
  `chatVia`, where the count is taken. A switch that took effect during that
  await would not be counted against the call. Fixed in round 6: the call now
  passes the count read with the model (`spoken-prose.ts:132` at `bd19e926`).
- Swarm seats claim the slot with no count (`src/swarm/engine.ts:197`), so the
  claim takes its own when it starts, as every call did before round 5.
- Calls that name a model explicitly (the eval and credit routes, scoped routes
  and swarm presets) do not follow the setting; criterion 2's table lists them.
- A call made inside an open counted call is counted as part of that call, not
  as a call of its own (`localCallsInFlight` counts it once); a switch still
  waits for it.
- The credit preflight reroute's count has no case of its own; it goes to the
  claim through the same provider path that n2 checks. (This item also said
  "`lane_credit` passes", as if that suite tested the reroute; it does not, see
  above.) Round 6 adds the case, and mutation s4 shows it fails without the
  count.
- Forked work that inherits a lane grant does so as before; round 5 changed
  only what is counted.
- Praxis numbers its own reads of the setting as they start
  (`src/llm/local-model-selection.ts:221-222`, `:415`, `:442-443`), the scheme
  `892708c8` replaced in TheCortex. A read served before a choice can win over an
  older read served after it. The read Nexus asks for once a choice is saved
  (`src/routes/ops.ts:162`) starts after the choice and is acted on, and Praxis
  reads again every 60 s (`LOCAL_MODEL_RESYNC_MS`, `:141`), so Praxis takes the
  new setting at its next successful read. Unchanged in round 5.

### Praxis `59161c6e` and `bd19e926` (round 6)

The review of `a8caeb09` raised five items. Line numbers in this section are
`bd19e926`'s. Round 7 (next section) moved lines in
`src/llm/lmstudio-autoload.ts` (one down after its imports, five down after the
slot claim's lookup) and in `tests/local_model_selection.test.ts`.

1. Spoken prose read the local model where its own `chatVia` is called, but
   left the count of switches to the manager. Its default `chatVia` awaits
   `import("../llm/manager.js")` before calling the manager
   (`src/voice/spoken-prose.ts:110-113`), so a switch that took effect during
   that await was not counted against the call, and the call went to the model
   the switch replaced. Round 5 listed this as left as it was.
2. The drain's change in `3d6760b1` (the member-profile extractor given the
   model as a function, `src/council/member-profile-updates.ts:215`) had no
   test of its own: the round-5 case builds the extractor directly, not through
   the drain. (In the four suites of the round-6 mutations, putting the plain
   string back fails only the new drain case; see s2.)
3. Two places that read the count with the model had no case of their own: the
   streamed role candidate (`chatStream` keeps the count read with the role's
   model, `src/llm/manager.ts:1744`) and the credit preflight reroute
   (`:1468-1469`).
4. The refusal named the wrong switch and could pick the wrong case. It named
   the model in effect when it was written, not the model that replaced the
   call's, and it said the call "waited for the switch" whenever any switch was
   being recorded when the call reached the claim. A call that read Gemma
   before a switch to Inkling took effect, and reached the claim while a second
   switch to Qwen was being recorded, was told it waited for the switch to Qwen.
   Gemma was replaced by Inkling, before the claim began.
5. The test helper `primaryForTest` put back the manager's provider and not its
   model. `chat()`'s fallback makes the rung that answered the session's
   primary, model included, when no explicit primary is configured
   (`src/llm/manager.ts:691-715`), so a test whose `chat()` fell back could
   leave the next test a different primary model.

The fixes (`59161c6e`; `bd19e926` only corrects a test comment):
- 1: the call now passes the count, read in the same synchronous step as the
  model (`spoken-prose.ts:121` reads the model, `:132` passes
  `localModelSwitches: localModelSwitchCount()`; the options type at `:34`).
  The manager's `chatVia` uses a count its caller passes
  (`manager.ts:1362`), so the slot claim refuses the call when a switch took
  effect during the await.
- 2 and 3: no code change. Each gets a test (below).
- 4: each switch records which model replaced the old one
  (`src/llm/local-model-state.ts:29`, `:102`). The claim's refusal
  (`src/llm/lmstudio-autoload.ts:1537-1546`, type at `:1398-1407`) returns
  `replacedBy`, that model, and `duringWait`, true only when the switch was
  numbered after the count taken when the claim began (`switchesAtClaim`,
  `:1524`). `assertLocalSlot` (`:1659-1671`) names `replacedBy` (`:1663`)
  and picks the message on `duringWait` (`:1665`).
- 5: `primaryForTest` restores the model as well
  (`tests/local_model_selection.test.ts:1290-1298`), and the suite ends with a
  check that the manager's provider and model are what they were before the
  suite (`:1300-1313`).

Tests: five new cases. `tests/local_model_selection.test.ts` has 49 (45 at
`a8caeb09`), and `tests/member_profile_updates.test.ts` one more.
- Two switches (item 4, `:1613`). Inkling takes effect, then a switch to Qwen is
  held in the middle of being recorded, and a call that read Gemma reaches the
  claim. The claim returns `replacedBy` Inkling and `duringWait` false, the
  message is the "after this call read it" one naming Inkling, Qwen is in effect
  at the end, and the fake loader records no call.
- Spoken prose (item 1, `:1651`). `composeSpokenProse` runs with a `chatVia`
  that has the switch to Inkling take effect before it calls the manager's
  `chatVia`: the call names Gemma, the slot claim refuses it with the "after
  this call read it" message, the stand-in for LM Studio's server receives
  nothing, spoken prose returns null, and nothing is loaded.
- The stream candidate (item 3, `:1680`). The role resolves to Gemma through
  local_default, and Nexus's answer to the switch to Inkling is released while
  the role is resolved. A check inside the test confirms that the local
  provider's `chatStream` is entered with Gemma named and Inkling in effect.
  The call is refused, nothing reaches the stand-in server, nothing is loaded,
  and the next candidate streams the reply.
- The credit reroute (item 3, `:1730`). A pinned hosted call fails with status
  402, and the reroute's local call reads Gemma before the switch takes effect
  during its admission. It is refused at the claim, nothing reaches the
  stand-in server, nothing is loaded, and the caller gets the hosted 402.
- The drain (item 2, `tests/member_profile_updates.test.ts:184`). Two jobs; the
  loopback server standing in for LM Studio switches the local model when it
  answers the first. The second job's request names the new model.

Two existing cases compare the claim's refusal object exactly; their expected
objects gained the two new fields (`:929`, `duringWait` true; `:1273`,
`duringWait` false). Two shared helpers gained an optional parameter that only
the new credit reroute case passes (`googleFails` in
`localProviderWithHeldAdmission`, `providers` in
`sendWhileSwitchTakesEffectInAdmission`). Nothing else in an existing case
changed.

Mutations (`mutations/praxis-mutations-round6.sh`, results and the diff each
made in `mutations/praxis-mutations-round6.txt`). The round-4 script
`praxis-mutations-s.sh` used the names s1 to s7 for other mutations. Each runs
in a scratch copy of `bd19e926` on the four suites holding the new cases
(`local_model_selection`, `member_profile_updates`, `spoken_prose`,
`local_model_demand_callers`, 83 tests) under the same guards. In every run the
LM Studio guard caught one request, `member_profile_updates`'s POST to its own
dead port 1, as in every run of that suite; the other guards caught nothing.

| Mutation | What it removes | Failing cases |
| --- | --- | --- |
| control | nothing | 0 of 83 |
| s1 | spoken prose passes no count | 1, the spoken prose case |
| s2 | the drain gives its extractor the model as a plain string | 1, the drain case |
| s3 | `chatStream` takes a new count for the role's candidate | 1, the stream candidate case |
| s4 | the credit reroute passes no count | 1, the credit reroute case |
| s5 | the refusal names the model in effect | 1, the two-switch case |
| s6 | the refusal says "waited" whenever a switch was being recorded on arrival (the `a8caeb09` rule) | 1, the two-switch case |
| s7 | `duringWait` is judged against the caller's count instead of the count when the claim began | 10: every case that expects the "after this call read it" message or `duringWait` false (under s7 every refusal says "waited") |
| s8 | `primaryForTest` restores the provider only (the round-5 helper) | 0 (see below) |
| control, primary variables unset | nothing | 0 |
| s8, primary variables unset | as s8 | 0 |

s8 fails nothing in that script, and the two extra runs show why. This shell
exports `LLM_PRIMARY_PROVIDER` and `LLM_PRIMARY_MODEL` (checked by name), and
with an explicit primary `chat()`'s fallback leaves the primary alone. Test runs
do not load Praxis's `.env` (`src/env.ts`), so with those two unset the
fallback does make the answering rung the primary. But a test run reads no
model registry, so the Antigravity rung's model resolves to
`antigravity-default` (`src/llm/antigravity-provider.ts:24`, `:32-34`), which
is also the model the manager starts with. The model the old helper left behind
equals the one it replaced, so nothing can see it.
`mutations/praxis-mutation-s8-registry.sh` (output
`mutations/praxis-mutation-s8-registry.txt`; its run logs were written from
19:43:58 to 19:48:33 EST) gives each run
a test data folder holding a model registry that lists one Gemini model for the
Antigravity lane, with the two variables unset, and bounds each run with a
270 s alarm:
- as committed, the whole suite: 49/49;
- as committed, only the two tests the leak passes between (the `chat()` and
  `complete()` admission cases, `:1439` and `:1448`): 2/2;
- the old helper, the same two tests: the `complete()` case fails ("answered",
  `:1452`), and so does the suite's closing check ("the manager's primary is as
  it was before the suite");
- the old helper, the whole suite: 40 pass, the `complete()` case fails, and the
  next test (`:1460`) never reports, so the alarm ends the run (exit 142). The
  script found five processes left in its scratch copy and stopped them by PID.

Runs on `bd19e926`, each under `praxis-files-guarded.sh` or
`praxis-wider-run.sh`. The whole outputs these runs wrote under the names in
"Final results" were replaced by round 7's runs of the same sets on `196a5375`
(next section); `praxis-round6-sets-output.txt` keeps round 6's summary lines.
- `praxis-round6-sets.sh` (19:51:37 to 19:52:22 EST, output
  `praxis-round6-sets-output.txt`; it stops unless the worktree is clean at
  `bd19e926`, and prints the head before and after):
  - `local_model_selection`, `local_model_demand_callers`, `local_lane_policy`:
    68/68;
  - the 40 related files: 541/541;
  - the more-related files: 130/130;
  - the wider set: 473/473. Its guards caught 6
    openrouter requests and 6 CLI runs, which is what `chat_turn_steps_legacy`
    makes when it runs alone on `a8caeb09` and on `cad6afb2`
    (`praxis-chat-turn-steps-alone-output.txt`); the wider runs on `a8caeb09`
    caught 3 and 3;
  - `npx tsc --noEmit`: exit 0.
- At 19:57 EST, `local_model_selection`, `local_model_primary` and
  `quantized_tool_gate`, 64/64, and `credit_exhaustion_preflight`, 5/5.
  That last suite is in none of the lists and names none of the changed modules;
  it ran because this README discusses the preflight. It was read after the run
  rather than before: it builds its queue in a temp folder and makes no
  request, and every guard log of the run is empty.
- `praxis-round6-importers.sh` (output `praxis-round6-importers.txt`) lists the
  69 test files whose text names a module round 5 or round 6 changed, spoken
  prose included (`local_model_selection`, `spoken_prose`,
  `voice_prose_deadline`). Every one is in one of the three lists except
  `lane_credit`, which names `llm/manager.ts` only in a comment and runs in the
  more-related set.
- Merged with Praxis main `1bac2ea7`: see "Merged with current main".

What round 6 leaves as it was: everything in round 5's list other than its
first and fifth items. In particular, swarm seats still claim the slot with no
count (`src/swarm/engine.ts:197`), and Praxis still numbers its own reads of the
setting as they start.

### Praxis `196a5375` (round 7)

The review of `bd19e926` found no defect in the source. It raised one test
weakness and two minor items, and round 7 fixes all three. The review ran in a
subagent that read the diff and the code; the one command it ran was
`node --version`, which starts nothing and contacts nothing. Line numbers in
this section are `196a5375`'s.

1. The suite's closing check could not see a leaked model. It compares the
   manager's provider and model with their values before the suite. But this
   shell exports `LLM_PRIMARY_PROVIDER` and `LLM_PRIMARY_MODEL`, which config
   reads at start-up (`src/config.ts:342-343`), and with an explicit primary
   `chat()`'s fallback leaves the primary alone. Without a model registry the
   fallback's model is also the manager's initial one (round 6, s8). So the
   check passed with the round-5 helper too, and its comment claimed more than
   it showed.
2. `primaryForTest` put back the provider and the model but not the manager's
   cache epoch, which the fallback moves on (`src/llm/manager.ts:709`, `:714`;
   the field at `:300`).
3. The slot claim matched a replaced model by its exact spelling. Each switch
   is recorded under the spelling in effect when it took effect, and the records
   are deduplicated by key (`noteLocalModelSwitch`,
   `src/llm/local-model-state.ts:98`, given `localModelKey` by
   `src/llm/local-model-selection.ts:271`). Nexus can name the model in effect
   by its models row's spelling (the tests use
   `thinkingmachines/inkling-2-mini@q4_k_m`), and Praxis takes it without
   counting a switch. Take a call that read `thinkingmachines/inkling-2-mini`,
   after which Nexus respelled it and a switch then replaced it. That call was
   not refused: the record named the row spelling, so the claim fell through to
   the slot check, which answers `{ ok: true }` for a name that is neither the
   model in effect nor the waiting one. The call would have gone to LM Studio
   naming the replaced model.

The fixes (`196a5375`):
- 1: a new test, "primaryForTest puts back the primary chat()'s fallback moved,
  model and cache epoch included, whatever the environment sets"
  (`tests/local_model_selection.test.ts:1492`).
  - It clears `config.llmPrimaryProvider` and `config.llmPrimaryModel` for its
    own length and restores them after (`:1496-1502`), so the fallback moves the
    primary in any shell.
  - It starts the manager's model at a name no rung answers with
    (`model-before-this-test`, `:1507`), so the model the fallback chooses
    differs from it whatever the registry holds.
  - A subtest runs `chat()` on a local primary that the slot claim refuses and
    the first cascade rung answers (round 6's admission helper, `:1513-1518`).
    Inside it, the provider is no longer `local`, the model is no longer the
    start name, and the cache epoch has moved on (`:1521-1523`).
  - After the subtest, whose `primaryForTest` restores what it saved when the
    subtest ends, the provider, the model and the epoch are back (`:1524-1528`).
  - The closing check is unchanged. Its comment now says what it cannot show
    and names this test (`:1342-1349`).
- 2: `primaryForTest` saves and restores `cacheEpoch` as well (`:1331-1340`).
- 3: the claim compares keys (`src/llm/lmstudio-autoload.ts:1541-1543`;
  `localModelKey` is imported at `:153` from
  `src/llm/local-model-capabilities.ts:82`, a module with no imports).
  - The guard in front of the lookup stays exact. A call naming exactly the
    model in effect, or the waiting model, keeps its own path as before.
  - The new test "a call that read the model in effect is refused at the slot
    claim when a switch replaces that model under a spelling Nexus gave it
    after the read" (`tests/local_model_selection.test.ts:1143`) runs this
    sequence:
    - Inkling takes effect, and the call reads Inkling and the count.
    - Nexus respells Inkling, which is not a switch.
    - A switch to Gemma replaces it and is recorded under the row spelling.
  - The claim refuses that call (`switched_away`, `heldBy` the row spelling,
    `replacedBy` Gemma, `duringWait` false). It does not refuse a call naming
    Gemma, the model in effect, under another spelling. The fake loader records
    no call.

Tests: two new tests and one subtest. `tests/local_model_selection.test.ts`
has 52 as the runner counts them (49 at `bd19e926`), the subtest included.
Apart from `primaryForTest`, a shared helper that now restores one more field,
and the closing check's comment, no existing test changed.

Mutations (`mutations/praxis-mutations-round7.sh`, 20:33:18 to 20:33:41 EST;
results and the diff each made in `mutations/praxis-mutations-round7.txt`, and
each mutation's whole run in `mutations/praxis-mutation-r7-k1.txt` to
`-k3.txt`). The earlier `mutations/praxis-mutation-k.txt` is Praxis K in the
table under "Mutations", a different mutation. Each runs in a scratch copy of
`196a5375` on
`local_model_selection`, `lmstudio_autoload` and `local_model_demand_callers`
(125 tests) under the same guards. Every guard log was empty in every run, and
in each run the fake `lms` refused one `ls --json`, from `lmstudio_autoload`'s
"failed embedding recovery" test (shown in each run's log).

| Mutation | What it removes | Failing tests |
| --- | --- | --- |
| control | nothing | 0 of 125 |
| k1 | the claim matches the replaced model by its spelling (the `bd19e926` lookup) | 1, the respelling test: the claim answers `{ ok: true }` where the refusal was expected |
| k2 | `primaryForTest` does not restore the model | 1, the primary-restore test: the model is `antigravity-default`, not `model-before-this-test` |
| k3 | `primaryForTest` does not restore the cache epoch | 1, the primary-restore test: the epoch is 2, not 1 |
| control, primary variables unset | nothing (`LLM_PRIMARY_PROVIDER` and `LLM_PRIMARY_MODEL` unset) | 0 of 125 |

k2 fails in this shell, which exports both primary variables; round 6's s8
failed nothing in the same shell. The new test is what sees the model the old
helper left behind.

Before the commit, at 20:30:51 EST, `local_model_selection` ran alone on the
working tree under `praxis-files-guarded.sh`: 52/52
(`praxis-round7-precommit-selection-run.txt`; its guard logs, the
`*-r7-selection.log` names in the guard scan, are empty). Its `[LmAutoload]`
lines come from the suite's fake catalog and fake loader. `npx tsc --noEmit` on
the working tree then exited 0.

Runs on `196a5375`, each under `praxis-files-guarded.sh` or
`praxis-wider-run.sh`:
- `praxis-round7-sets.sh` (20:34:33 to 20:35:15 EST, output
  `praxis-round7-sets-output.txt`; it stops unless the worktree is clean at
  `196a5375`, and prints the head before and after):
  - `local_model_selection`, `local_model_demand_callers`, `local_lane_policy`:
    71/71 (68 at `bd19e926`, plus the two new tests and the subtest);
  - the 40 related files: 544/544 (`praxis-related-tests.txt`);
  - the more-related files: 130/130 (`praxis-more-related-tests.txt`);
  - the wider set: 473/473 (`praxis-wider-tests.txt`); its guards caught the
    same 6 openrouter requests and 6 CLI runs as on `bd19e926`;
  - `npx tsc --noEmit`: exit 0 (`praxis-tsc.txt`).
- At 20:42 EST, `local_model_selection`, `local_model_primary` and
  `quantized_tool_gate`, 67/67 (`praxis-local-model-selection-tests.txt`), and
  `credit_exhaustion_preflight`, 5/5 (`praxis-credit-preflight-tests.txt`).
  Every guard log of both runs is empty, and the fake `lms`'s fixed log was
  emptied before them and still empty after.
- Round 7 changed one source module, `src/llm/lmstudio-autoload.ts`, which
  round 6 changed too. Every test file that names it is in one of the three
  lists (`praxis-round6-importers.txt`, whose pattern includes
  `lmstudio-autoload`). Every Praxis test file the task changed ran in these
  sets on `196a5375`: `local_model_demand_callers`, `local_model_primary`,
  `local_model_selection`, `member_profile_updates`, `quantized_tool_gate` and
  `webhook_routes_inventory`.
- Merged with Praxis main `1bac2ea7`: see "Merged with current main".

What round 7 leaves as it was: everything round 6 left. The slot check itself
(`slotCheckApplies`, `src/llm/lmstudio-autoload.ts:1575-1582`) still compares
exact names, as it did at the baseline, so a call naming the model in effect by
another spelling is not checked against the slot. Only the switched-away lookup
compares keys.

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
(`guards/guard-logs-scan.txt`). The same scan of the second scratch folder, made
for the `1bac2ea7` checks, found 11 logs and no such line
(`guards/guard-logs-scan-1bac2ea7.txt`). The third folder held the round-5 to
round-7 runs and their merged checks; its scan, at 20:56:57 EST after the last
guarded run, found 132 logs and no such line
(`guards/guard-logs-scan-rounds5-7.txt`). The round-5 to round-7 mutation
scripts (and the s8 registry script) write one log per guard and empty it
before each run, so that scan saw only the last mutation run's logs; the counts
for every mutation run are printed in the mutation outputs. No scan covers the
fake `lms`'s own log (see below). The files in `guards/` are byte-identical to
the ones the scripts ran from each folder (checked with `cmp` before each was
deleted; for the third, `guards/guards-cmp-rounds5-7.txt`). To
rerun a script, first copy the contents of `guards/` into the scratch folder it
names (`/Volumes/Projects/.scratch-fa032fc0`). Git records the eight shims,
`fake-lms` and `praxis-files-guarded.sh` as executable (mode 100755) from the
commit that adds this update on. Before it they were recorded as 100644, because
this checkout has `core.fileMode` off. In a fresh checkout the shims would then
not be executable, and a `PATH` lookup would skip them and find the real
command.

The fake `lms` appends every call to one fixed file, `lms-calls.log` in the
scratch folder. From 14:03 EST, during round 4, `praxis-files-guarded.sh`
empties a per-run name instead, `lms-calls-<tag>.log`, which the fake never
writes, and `guard-logs-scan.py` takes only names containing "guard", "shims"
or "fake-lms". So `praxis-fake-lms-calls.txt`, copied from such a per-run file,
is empty whatever the run did. An earlier version of this README read it as "no
call to the fake `lms`". That was wrong. The run logs show the calls, because the
autoloader logs the fake's refusal:
- The 40-file run on the branch head made one call, `lms ls --json`, and the
  fake refused it (`praxis-related-tests.txt:476-483`, in
  `lmstudio_autoload.test.ts` "failed embedding recovery does not block a
  healthy Gemma load"). That test stubs the catalog, the process count, the
  memory reading and the loader. Only the inventory read is left to the real
  code, which runs `PRAXIS_LMS_BIN`, the fake. The "loading
  google/gemma-4-31b-qat via lms" and "loaded in 0s" lines after it come from
  the test's stub loader. Round 3 recorded the same single call while its copy
  still came from the fixed file (`praxis-fake-lms-calls.txt` at `09b75ae8`).
  The merged runs whose whole logs are kept show the same call
  (`merged-main/praxis-tests-merged-613f66b6.txt:2455`,
  `merged-main/praxis-tests-merged-fbce5c26.txt:2484`).
- In the first scratch folder the fixed file was read once more, at 16:14 EST,
  before the folder was deleted. It held 8 lines, last written at 16:10. The
  three lines printed were `ls --json`; the other five were not printed and
  went with the folder.
- In the second scratch folder (the `1bac2ea7` checks) it holds 2 lines, both
  `ls --json` (`merged-main/praxis-fake-lms-calls-1bac2ea7.txt`). One is from
  the rerun, logged at the same `lmstudio_autoload` test (line 6646 of its
  whole log). The other is from the stopped first run, whose log ends before
  that suite's output. The plain-main run made none.
- In the third (rounds 5 to 7) the merged scripts empty the fixed file before
  each run and copy it after. The merged run of each head made one call,
  `ls --json` (`merged-main/praxis-tests-merged-1bac2ea7-a8caeb09-fake-lms.txt`,
  `merged-main/praxis-tests-merged-1bac2ea7-bd19e926-fake-lms.txt`,
  `merged-main/praxis-tests-merged-1bac2ea7-196a5375-fake-lms.txt`), and the
  plain-main runs none; the merged outputs print both counts.
  `praxis-wider-run.sh` empties the fixed file at its start and prints its
  count: 0 in the wider runs on `a8caeb09`, `bd19e926` and `196a5375`. The
  40-file runs on all three heads show the one refused `ls --json` in their
  logs, as above. In round 6 the fixed file was emptied at 19:54:03 EST and was
  still empty at 20:11:15, so the 19:57 runs made no call. In round 7 it was
  emptied at 20:42:11 EST, just before the 20:42 runs
  (`praxis-local-model-selection-tests.txt`,
  `praxis-credit-preflight-tests.txt`), and was still empty after each of them
  and at its last read, 21:06:47 EST, just before the scratch folder was
  deleted (0 bytes, last written 20:42:11), so they made no call either.

`ls --json` lists the models on disk and loads nothing. Praxis runs it in
`readDownloadedModelInventory` (`src/llm/lmstudio-autoload.ts:294-302`). The fake
answers every call with exit 1 and never runs the real `lms`, and the `lms` shim
first on `PATH` does the same. LM Studio's own log shows no model loaded after
the 11:51:59 unload (see "Live state").

| File | What ran | Result |
| --- | --- | --- |
| `nexus-local-model-selection-tests.txt` | TheNexus `server/__tests__/local-model-selection.test.js` | 17/17 |
| `nexus-related-server-tests.txt` | 23 TheNexus server suites around model control, model rows, Studio, astro and the auth mounts, keyless | 268/268 |
| `dashboard-tsc.txt` | `npx tsc --noEmit` in `dashboard/`, at the end on the head `c5b44405` with nothing changed outside `docs/reviews` (20:54 EST, after review round 7; the commits after `6e14bc87` change only `docs/reviews`) | exit 0 |
| `dashboard-local-model-tests.txt` | `local-model-chooser`, `chat-model-control`, `fast-refresh-boundaries` | 23/23 |
| `dashboard-full-suite.txt` | dashboard `npm test` | 1460/1463 (see the failures below) |
| `dashboard-document-review-rerun.txt` | `document-review.test.mjs` alone | 21/21 |
| `dashboard-baseline-failing-tests.txt` | the two pre-existing failures on baseline `bd02642` | both fail there too |
| `praxis-local-model-selection-tests.txt` | Praxis `local_model_selection`, `local_model_primary` and `quantized_tool_gate`, on `196a5375` (20:42 EST) | 67/67 |
| `praxis-related-tests.txt` | 40 Praxis test files around the local lane, the LLM manager, autoload, the local worker, the ops routes and the route inventory (`praxis-round5-related-names.txt`), on `196a5375` (`praxis-round7-sets.sh`) | 544/544 |
| `praxis-more-related-tests.txt` | the 9 other Praxis test files that name a changed symbol (`cli-concurrency`, `LOCAL_LLM_MODEL` and the like), plus `lane_credit` since round 5 (`praxis-round5-more-related-names.txt`), on `196a5375` (`praxis-round7-sets.sh`) | 130/130 |
| `praxis-wider-tests.txt` | the 40 other Praxis test files that import the LLM manager, the local model state or the output-room wrapper (`praxis-wider-test-list.txt`, less `maintenance_review_regressions`, which makes its data dir in a shared folder); runner `praxis-wider-run.sh`, on `196a5375` (`praxis-round7-sets.sh`) | 473/473 |
| `praxis-credit-preflight-tests.txt` | `credit_exhaustion_preflight`, on `196a5375` (20:42 EST; see round 6) | 5/5 |
| `praxis-tsc.txt` | `npx tsc --noEmit` in Praxis, on the clean head `196a5375` (20:35 EST, `praxis-round7-sets.sh`) | exit 0 |
| `praxis-chat-turn-steps-alone-output.txt` | `chat_turn_steps_legacy` alone, twice on `a8caeb09` and twice on `cad6afb2` (`praxis-chat-turn-steps-alone.sh`) | 2/2 each time; 6 CLI runs and 6 requests refused each time |
| `praxis-lmstudio-guard.txt`, `praxis-fake-lms-calls.txt`, `praxis-cli-shims-related.txt` | what the guards caught in the 40-file run on `196a5375` | 1 POST to port 1 from `member_profile_updates.test.ts` (its own dead URL, pre-existing); 1 `lms ls --json` refused by the fake `lms`, shown in the run log (`praxis-fake-lms-calls.txt` is empty for the reason given above the table); 3 `--version` calls (`claude`, `codex`, `agy`); the network and live-port guards refused nothing |
| `praxis-encoding-scan.txt` | `npm run check:encoding` over the Praxis files changed | see `encoding-and-dash-scans.txt` |
| `cortex-offline-tests.txt` | 11 TheCortex test files (listed in `merged-main/merged-main-check.sh`), on `892708c8` | 296 passed |
| `cortex-local-model-tests.txt` | TheCortex `tests/test_local_model_setting.py`, verbose, on `892708c8` | 26 passed |
| `cortex-local-model-repeat.txt` | the same file 25 times in a row, on `892708c8` | 26 passed each time |
| `encoding-and-dash-scans.txt`, made by `final-scans.sh` | UTF-8 scans of every file changed in each repository, and em dashes in added lines | see the file; summary at the end of this README |

In the runs behind `praxis-local-model-selection-tests.txt` (3 files, 67 tests),
`praxis-more-related-tests.txt` (10 files, 130 tests) and
`praxis-credit-preflight-tests.txt` (1 file, 5 tests) every guard log is
empty, and no run's log shows a refused `lms` call. In the wider run the guards caught only the pre-existing
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

### Praxis `1bac2ea7` and TheCortex `b06ed4dc` (the branches conflict)

At 16:22 EST task `98d0b1b9` ("Hold daytime knowledge-graph extraction for the
overnight window so Gemma stays unloaded during the day") landed TheCortex
`b06ed4dc` (16:22:23) and Praxis `1bac2ea7` (16:22:26). TheNexus main did not
move. Both task branches now conflict with their mains. This run does not merge
main, because the brief forbids it. When the run lands, Praxis's run merge will
find the conflict, merge nothing, and send the task back with a "MERGE
CONFLICT" correction (`src/orchestrator/run-merge.ts:1039-1047` on `1bac2ea7`,
its text at `:398-412`). The correction asks for `git merge main` resolved by
hand, the task's verification rerun on the result, and a new QA review. This
section shows the conflicts, a resolution that keeps both sides, and the checks
of that resolution, all made in scratch copies outside every repository.

The conflicts (`merged-main-1bac2ea7-b06ed4dc.sh`, output in
`merged-main-1bac2ea7-b06ed4dc-output.txt`, 16:36:49 to 16:39:16 EST; each one
again as a diff from the file with markers to the resolved file in
`conflict-resolutions-1bac2ea7-b06ed4dc.sh`, output beside it):
- Praxis: main changed 16 files since `59cacac6`. The branch also changes five
  of them: `src/index.ts`, `src/llm/local-lane-policy.ts`, `src/llm/manager.ts`,
  `src/nexus/client.ts` and `tests/webhook_routes_inventory.test.ts`. `git
  merge-tree` reports two conflicting files with three hunks. No hunk has
  anything on the base side: both sides only add lines.
  - `src/llm/local-lane-policy.ts`, one hunk in the test-only reset. Main adds
    four resets for its hold (`operatorGrantsOpen = 0`,
    `operatorGrantListeners.clear()`, `admissions.clear()`,
    `graphHoldReading = null`); the branch adds `runningJobs.clear()`.
  - `src/llm/manager.ts`, two hunks in one import list. Main adds
    `isLocalLaneHoldCaller` and `runHeldLocalLaneCall`; the branch adds
    `insideCountedLocalCall` and `trackLocalCall`.
- TheCortex: main changed 12 files since `3617672`. The branch also changes three
  of them: `TheCortex/conftest.py`, `python/cortex/config.py` and
  `python/cortex/memory/client.py`. One hunk conflicts, in `conftest.py`: both
  sides add `import pytest` at the same place, and the branch adds its
  `local_model_setting_offline` fixture after it. Main's own fixture,
  `graph_episode_hold_per_test`, merges further down without conflict.

The resolution is `git merge-file --union`, which keeps both sides' lines.
Compared with the file with markers, it removes only the marker lines, plus the
second `import pytest` and one blank line in `conftest.py`, and adds nothing.
Keeping both sides is right here:
- The reset lines and the imports are independent additions.
- In `chatVia`, main sends its held callers through `runHeldLocalLaneCall`. When
  the lane is closed, such a call is either refused before any model is called,
  or, while Robert's grant is open, run again through `chatVia` under an
  `episode` grant (merged copy: `src/llm/manager.ts:1330-1343`,
  `src/llm/local-lane-policy.ts:463-471`). On that second pass the lane reads
  open, so the call reaches the branch's `trackLocalCall`. It is counted as
  local work, and a switch of local model waits for it. A refused call never
  runs on LM Studio and is not counted.
- In TheCortex the Graphiti client keeps the branch's model
  (`_resolve_graphiti_llm()`, which asks Nexus through `local_model_or`) and
  main's new transport, which stamps the lane admission on each request (merged
  copy: `python/cortex/memory/client.py:278-305`). `config.py` gains main's
  hold-file setting beside the branch's lines.

The checks, under the same guards as before:
- Each merged copy is `git archive` of the tree that `git merge-tree` writes
  (with the markers), with the conflicted files replaced by their resolution.
  Compared with that tree file by file: Praxis 6773 files, only the two
  resolved files differ, no extra file; TheCortex 2986 files, only
  `conftest.py` differs.
- Praxis `tsc`: exit 0 (`praxis-tsc-merged-1bac2ea7.txt`).
- Praxis suites, 179 (`praxis-suites179-1bac2ea7.txt`): the 152 of the
  `59cacac6` check plus 27 that main changed or that import a module main
  changed (named in the output). Every suite that makes its data folder under
  `/Volumes` is left out: the six `maintenance_*` suites, which the whole-suite
  run left out for the same reason. Of those six, only
  `maintenance_review_regressions` was among the suites picked.
- The merged run loaded TheNexus from a scratch copy of TheNexus `2a7952fc` plus
  the TheNexus branch diff (`NEXUS_TEST_ROOT`), and the plain-main run from a
  copy of `2a7952fc` alone. Neither copy had a `nexus.db`, and neither run wrote
  a file in it.
- Merged: 2574 tests, 2555 pass, 10 fail
  (`praxis-tests-merged-1bac2ea7-extract.txt`). The ten are in six suites:
  `alert_investigation`, `code_freshness_recovery`, `qa_state_persistence`,
  `research_web_retrieval`, `run_model_dispatch_state` and
  `webhook_routes_inventory`.
- The same six suites on plain `1bac2ea7` (that copy matches the commit file for
  file: 6769 files, 0 differ): 212 tests, 202 pass, and the same ten fail
  (`praxis-failing-suites-plain-main-1bac2ea7.txt`). Nine of them are the nine
  of the `59cacac6` check. The tenth is new; see "Failures that are not this
  task's".
- The guards on the merged copy (`praxis-tests-merged-1bac2ea7-*.txt`):
  - the LM Studio guard refused 2 requests to the dead port 1:
    `member_profile_updates`'s POST and a `GET /api/v0/models` from
    `run_model_dispatch_state`;
  - the network guard refused 6 openrouter chat requests;
  - the CLI shims took 9 calls: 2 each for `agy`, `claude` and `codex`, and
    their 3 `--version` calls;
  - the live-port guard refused 1 connection, to `mixed.test` from
    `research_web_retrieval`;
  - the fake `lms` refused 1 `ls --json` (see "Final results on the branch
    heads").

  On plain main they caught the `run_model_dispatch_state` request and the
  `mixed.test` connection only
  (`praxis-failing-suites-plain-main-1bac2ea7-{lmstudio-guard,live-port-guard}.txt`).
- TheCortex: the 11 files of the earlier checks plus `tests/test_graph_episode_hold.py`,
  which main added: 325 passed (`cortex-tests-merged-b06ed4dc.txt`). The new
  file was read before it ran:
  - TheCortex's test guard is installed by the root `conftest.py`;
  - Praxis's lane, Graphiti, the graph driver and the episodic store are fakes;
  - each hold is a SQLite file in pytest's temp folder (main's
    `graph_episode_hold_per_test` fixture and the suite's own `harness`);
  - its one subprocess runs under the same guard, with the hold file in that
    temp folder.
- No entry in `/Volumes/Projects/maintenance-mode-worktrees` changed during the
  run (checked at the end of each part).

The first run of this check (16:31:37 EST) picked its suites by import and did
not scan them first. Its selection included `maintenance_review_regressions`,
which sets `PRAXIS_DATA_DIR` to a folder it makes under
`/Volumes/Projects/maintenance-mode-worktrees`, a shared folder.
- The run was stopped at about 16:32:30, before that suite could clean up
  (`merged-main-1bac2ea7-b06ed4dc-stopped-run.txt`). The suite had made one
  folder, `review-regressions-4K2BvL`, holding two empty folders.
- The whole test was then read. Everything it writes goes inside that folder,
  and its one model call is mocked.
- `maintenance-folder-residue.sh` (output beside it) records the folder's times
  and contents and removes it with `rmdir`, which refuses a folder that is not
  empty. It also shows that nothing else in the shared folder changed after
  16:31:00.
- Then every suite of the selection was scanned (`suite-hazard-scan-1bac2ea7.sh`,
  output beside it):
  - for data folders made under `/Volumes`: the scan finds the six
    `maintenance_*` suites, now left out;
  - for lines naming `/Volumes/Projects`, a home folder or a live port. Three of
    the 27 added suites have such lines, and none connects or writes there:
    `fleet_preflight` has an address in an error message;
    `operator_restart_chat_turn` has the Praxis bridge address inside its own
    stubbed `fetch`, which forwards that request to the test's own server; and
    `slot_numbering` has workspace paths in its fixtures. The other suites with
    such lines ran in the earlier checks.
- The rerun used fresh scratch names.

TheCortex main moved once more, at 17:04:50 EST, to `17ee69ce` (task
`2717b41c`, "Archive the failed bao research report's statements out of the
knowledge graph"). Since `b06ed4dc` it changes `AGENTS.md` and `CLAUDE.md` and
adds `TheCortex/scripts/archive_failed_research_ingest.py`. The branch changes
none of them, and the only other file of the merged tree that names the new
script is `CLAUDE.md`. `cortex-merged-17ee69ce.sh` (output
`cortex-merged-17ee69ce-output.txt`, 17:11:16 to 17:11:39 EST) repeats the
TheCortex check on the new main, under the same guards:
- the conflict is the same single hunk in `conftest.py`, and the union
  resolution is byte-identical to the one tested on `b06ed4dc`;
- the copy matches the merge-tree's tree except in `conftest.py` (2987 files
  compared, no extra file), and differs from the `b06ed4dc` copy only in main's
  three files;
- the same 12 test files: 325 passed (`cortex-tests-merged-17ee69ce.txt`); the
  run wrote no file in the copy, and nothing in
  `/Volumes/Projects/maintenance-mode-worktrees` changed.

### After review rounds 5 to 7: TheCortex `892708c8`, Praxis `a8caeb09`, `bd19e926` and `196a5375`

The mains did not move after these checks above: Praxis `1bac2ea7`, TheCortex
`17ee69ce`, TheNexus `2a7952fc`. Each new head was checked on them the same way,
in scratch copies outside every repository, under the same guards.
- TheCortex `892708c8` on `17ee69ce` (`cortex-merged-17ee69ce-892708c8.sh`,
  output beside it, 18:46:44 to 18:46:57 EST):
  - the conflict is the same single hunk in `conftest.py`, and its union
    resolution is identical to the one built for `e611edc`;
  - the copy matches the merge-tree's tree except in `conftest.py` (2987 files,
    no extra file). Against the copy built the same way for `e611edc`,
    `diff -rq` finds only the two files round 5 changed (`local_model.py` and
    `test_local_model_setting.py`), and the link to TheCortex's `.env` that the
    script makes in the new copy before its tests run, as
    `cortex-merged-17ee69ce.sh` did;
  - the same 12 test files: 328 passed
    (`cortex-tests-merged-17ee69ce-892708c8.txt`; 325 before, plus round 5's
    three new cases). The run wrote no file in the copy, and nothing in
    `/Volumes/Projects/maintenance-mode-worktrees` changed.
- Praxis `a8caeb09` on `1bac2ea7` (`praxis-merged-1bac2ea7-a8caeb09.sh`, output
  beside it, 18:51:17 to 18:53:31 EST):
  - the same two conflicting files, one hunk each. `local-lane-policy.ts` is as
    before. In `manager.ts` round 5 dropped the branch's
    `insideCountedLocalCall` import, so one hunk is left in that import list:
    main's `runHeldLocalLaneCall` against the branch's `trackLocalCall`. The
    union resolution removes only the marker lines;
  - the copy matches the merge-tree's tree except the two resolved files (6773
    files, no extra file), and `tsc` exits 0
    (`praxis-tsc-merged-1bac2ea7-a8caeb09.txt`);
  - the same 179 suites (`praxis-suites179-merged-a8caeb09.txt`): the round-5
    sets add none, their two trading suites are not on main, and
    `maintenance_review_regressions` is left out as before. 2583 tests, 2564
    pass, 10 fail (`praxis-tests-merged-1bac2ea7-a8caeb09-extract.txt`), the
    same ten as in the `1bac2ea7` check. On plain `1bac2ea7` the same six suites
    give 212 tests, 202 pass, and the same ten fail
    (`praxis-failing-suites-plain-main-1bac2ea7-a8caeb09.txt`);
  - the guards caught what they caught in the `1bac2ea7` check
    (`praxis-tests-merged-1bac2ea7-a8caeb09-*.txt`,
    `praxis-failing-suites-plain-main-1bac2ea7-a8caeb09-*.txt`).
- Praxis `bd19e926` on `1bac2ea7` (`praxis-merged-1bac2ea7-bd19e926.sh`, output
  beside it, 19:52:22 to 19:54:33 EST). Round 6 changed none of the files main
  changed since the merge-base:
  - the conflict hunks and their resolution are byte for byte those of the
    `a8caeb09` check (the two outputs differ there only in the copy's name);
  - the copy matches the merge-tree's tree except the two resolved files (6773
    files, no extra file), and `tsc` exits 0
    (`praxis-tsc-merged-1bac2ea7-bd19e926.txt`);
  - the same 179 suites (`praxis-suites179-merged-bd19e926.txt`, identical to
    the `a8caeb09` list): 2588 tests (round 6's five new cases more), 2569
    pass, and the same ten fail
    (`praxis-tests-merged-1bac2ea7-bd19e926-extract.txt`). On plain `1bac2ea7`:
    212 tests, 202 pass, the same ten fail
    (`praxis-failing-suites-plain-main-1bac2ea7-bd19e926.txt`);
  - the guards caught the same entries as in the `a8caeb09` check, process ids
    and the copy's path aside (`praxis-tests-merged-1bac2ea7-bd19e926-*.txt`):
    2 refused requests to port 1 (`member_profile_updates`'s POST and
    `run_model_dispatch_state`'s `GET /api/v0/models`), 6 openrouter requests,
    9 CLI shim calls, 1 connection to `mixed.test`, and 1 `ls --json` refused by
    the fake `lms`. On plain main, the `run_model_dispatch_state` request and
    the `mixed.test` connection only
    (`praxis-failing-suites-plain-main-1bac2ea7-bd19e926-*.txt`);
  - neither TheNexus copy had a `nexus.db`, neither run wrote a file in it, and
    nothing in `/Volumes/Projects/maintenance-mode-worktrees` changed.
- Praxis `196a5375` (round 7) on `1bac2ea7` (`praxis-merged-1bac2ea7-196a5375.sh`,
  output beside it, 20:36:44 to 20:38:57 EST). Round 7 changed
  `src/llm/lmstudio-autoload.ts` and `tests/local_model_selection.test.ts`,
  neither of which main changed since the merge-base:
  - the conflict hunks and their resolution are byte for byte those of the
    `bd19e926` check, the copy's name aside (56 lines of each output compared);
  - the copy matches the merge-tree's tree except the two resolved files (6773
    files, no extra file), and `tsc` exits 0
    (`praxis-tsc-merged-1bac2ea7-196a5375.txt`);
  - the same 179 suites (`praxis-suites179-merged-196a5375.txt`, identical to
    the `bd19e926` list): 2591 tests (round 7's two new tests and one subtest
    more), 2572 pass, and the same ten fail, by name
    (`praxis-tests-merged-1bac2ea7-196a5375-extract.txt`). On plain `1bac2ea7`:
    212 tests, 202 pass, the same ten fail
    (`praxis-failing-suites-plain-main-1bac2ea7-196a5375.txt`);
  - every guard log holds the same lines as in the `bd19e926` check once the
    leading process id and the copy's path are removed
    (`praxis-tests-merged-1bac2ea7-196a5375-*.txt`,
    `praxis-failing-suites-plain-main-1bac2ea7-196a5375-*.txt`);
  - neither TheNexus copy had a `nexus.db`, neither run wrote a file in it, and
    nothing in `/Volumes/Projects/maintenance-mode-worktrees` changed.

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

Rounds 5 to 7 have their tables in their own sections: Praxis n1 to n8, m1 to
m3 and mp (`praxis-mutations-round5.sh`, round 5); TheCortex R1 to R4
(`cortex-mutations-r.sh`, TheCortex `892708c8`); Praxis s1 to s8 of round 6
with the registry runs for s8 (`praxis-mutations-round6.sh`,
`praxis-mutation-s8-registry.sh`, round 6); and Praxis k1 to k3 of round 7
(`praxis-mutations-round7.sh`, round 7). The round-6 names s1 to s8 are not
the round-4 s1 to s7 in the table above, and k1 to k3 are not Praxis K. The
four mutation scripts print the diff each mutation made before its result; the
s8 registry script names the line it removes and checks that it is gone.

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
  read-only read-back at the end of the task, 20:54:04 EST, after the last test
  run (20:42, round 7). It ran inside `r7-final-readbacks.sh`, after the
  precondition check and the dashboard tsc. Apart from its clock times it is
  line for line the same as the 13:00, 14:39, 14:51, 15:52, 16:14, 16:41 and
  20:07 read-backs before it.
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
restarted no service. Its only contact with LM Studio was twelve listing
requests (`GET /api/v1/models`), and a listing loads nothing:
- 07:54 and 08:26 EST, to read the real listing's shape before writing the fake;
- one in each read-back, at 11:00, 12:46, 13:00, 14:39, 14:51, 15:52, 16:14,
  16:41, 20:07 and 20:54 EST.

`criterion-9-lmstudio-contact.sh` (output `criterion-9-lmstudio-contact.txt`,
21:01:28 EST, read-only, after the last read-back) checks this from both sides,
from this run's first start (21:39:35 EST on 2026-11-23) on:
- LM Studio's own server log has thirteen `GET /api/v1/models` requests in that
  time. Twelve are the ones above. Eleven came within a second of the tool call
  that sent them; the 20:54:04 one came four seconds after its call (20:54:00),
  which ran the precondition check and the dashboard tsc first. The thirteenth,
  at 21:47:18 EST on 2026-11-23, came while this run's session was idle (its
  longest pause, 21:40:38 to 07:42:09), so another client sent it. The six
  `GET /v1/models` requests fall in the same pause.
- In the session transcript and its ten subagents' transcripts, 12 Bash calls
  send to LM Studio: the twelve above. The 21 other Bash calls whose text names
  port 1234 (20 in the session, 1 in one subagent) are search patterns and
  scans; the file lists each one. The 20:54 read-back ran inside the scratch
  script `r7-final-readbacks.sh` (copied here), whose name the script's first
  patterns do not match, so after round 7 the contact script also counts a call
  that runs it; without that pattern the transcript side found eleven sends
  and missed this one.
- The `GET /api/v0/models` polls and every `POST` (chat completions and
  embeddings) come from other clients. No Bash call of this run sends one, and
  its test runs could not reach port 1234 (next paragraph).

In every test run the guards refused LM Studio's port, 1234: the network guard
and the LM Studio guard in the Praxis and TheNexus runs, the live-port guard as
well in the Praxis runs from round 4 on, and TheCortex's offline guards with
every service URL on port
1. The 153 guard logs in the first scratch folder, scanned before it was
deleted, the 11 in the second and the 132 in the third show no request to port
1234 (`guards/guard-logs-scan.txt`, `guards/guard-logs-scan-1bac2ea7.txt`,
`guards/guard-logs-scan-rounds5-7.txt`). The fake
`lms`, which those scans do not cover, refused only `lms ls --json` listing calls
wherever its calls were printed (see "Final results on the branch heads").

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
  run (`praxis-related-tests.txt`, 40 files, 544/544 on `196a5375`).
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

On main `59cacac6` the 152 suites of that merged check fail nine of these ten
tests on the merged tree (`email_intake_runtime` passed in that run). The five
suites behind the nine fail the same nine on plain `59cacac6`
(`praxis-failing-suites-plain-main-59cacac6.txt`).

On main `1bac2ea7`, merged with the conflicts resolved (see the merged section),
the 179 suites fail ten tests: the nine of `59cacac6` and one new one,
`run_model_dispatch_state` "a fresh task run and QA review run on claude-code
and codex report their model in dispatch state". All ten fail the same way on
plain `1bac2ea7`, which has none of the branch's changes
(`praxis-failing-suites-plain-main-1bac2ea7.txt`). The new failure is the
assertion at `tests/run_model_dispatch_state.test.ts:236`. The suite's stand-in
CLIs record three launches, not four, and the missing one is the `codex` QA
review with `gpt-5.6-sol` at `medium`. The suite passed in the round-4 full run
on `4d076f91`.

The same ten fail on the merged trees of the round-5 head `a8caeb09`, the
round-6 head `bd19e926` and the round-7 head `196a5375`, and each time the same
six suites fail the same ten on plain `1bac2ea7`
(`praxis-failing-suites-plain-main-1bac2ea7-a8caeb09.txt`,
`praxis-failing-suites-plain-main-1bac2ea7-bd19e926.txt`,
`praxis-failing-suites-plain-main-1bac2ea7-196a5375.txt`; see the merged
section). No failure in any run on the branch heads themselves: every Praxis
run listed under rounds 6 and 7 passes in full.

## Round-1 records kept

- `praxis-related-tests-earlier-run.txt`: 35 files, 470/470 at 09:18.
- `praxis-voice-deadline-rerun.txt`: `voice_prose_deadline.test.ts` alone, 5/5.
- `nexus-net-guard-studio-first-dummy-key-run.txt`.
- The two failed browser runs and the non-subject screenshots listed above.

## Scans

`final-scans.sh` writes `encoding-and-dash-scans.txt` and
`praxis-encoding-scan.txt`. At the end of the task:
- UTF-8 (fatal decoder, BOM, U+FFFD): no problems in 397 TheNexus files (405
  changed or added against `bd02642`, 8 PNGs skipped), 12 TheCortex files and 21
  Praxis files (`1fcf4b59..196a5375`). Praxis's own `npm run check:encoding`
  passes on the same 21.
- Em dashes in added lines: 0 in Praxis, 0 in TheCortex, 0 in the TheNexus code,
  docs and scripts this task wrote. The verbatim outputs in this folder carry
  the products' own log wording.
- The dashboard has no change since `e1bfcc97`.
- The registered package: the three PNGs hash to the registered values, the
  folder has no uncommitted change, and it holds the three PNGs and
  `local-model-control.design.json`. The same readiness request as
  `document-readiness-final.json`, made again at 20:59:01 EST
  (`document-readiness-recheck.json`; apart from `checked_at` the same as the
  17:01:47 and 20:14:11 rechecks it replaces), reports revision `5a481277` ready, with all
  three required screens servable and each screen's content hash equal to the
  file's.

## Last check of the mains

At 21:02:33 EST the mains were TheNexus `2a7952fc` (since 15:51:16), Praxis
`1bac2ea7` (since 16:22:26) and TheCortex `17ee69ce` (since 17:04:50), read
from each shared checkout's reflog for `main` with `git --no-optional-locks`.
The Praxis and TheCortex task worktrees were clean at `196a5375` and
`892708c8`.
