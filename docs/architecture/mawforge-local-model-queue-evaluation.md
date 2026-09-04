# Evaluation: MawForge for the Local Model Queue

**Status:** Evaluation complete — **recommendation: do not adopt now; defer with conditions.**
**Date:** 2026-07-15
**Nexus task:** 2da2e7a5-4276-44f0-82d4-1560bff7394f — "Evaluate MawForge for the Local Model Queue"
**Provenance of the ask:** 2026-07-15 morning knowledge council (`/Volumes/Projects/shared-mind/memories/note_knowledge_council_2026-07-15.md`, section 5 PROJECT KNOWLEDGE ROUTING). This is an *evaluate*, not an *implement*, task — nothing in the runtime was changed.

---

## TL;DR

The routing that produced this task pairs a **memory-capacity technique** (MawForge:
"memory-bounded expert materialization" for running a Mixture-of-Experts model on
constrained hardware) with a limitation (**L10**) that is actually a **reliability /
content-extraction bug** on a **dense** model that is **not memory-constrained**. The two
do not meet. Concretely:

1. **The Local Model Queue does not run an MoE model.** Its worker is dense Gemma 4 31B
   QAT under LM Studio. The MoE alternative (Qwen-style 26B-A4B) was **deliberately
   rejected** by Robert on 2026-07-01 for quality-over-speed. Adopting a MoE-offloading
   technique presupposes first reversing that product decision.
2. **The hardware is not memory-bound for the current model.** On the M4 Max 64 GB box,
   Gemma 4 31B QAT at 128K context uses ~33 GiB with **~20 GB headroom**. There is no
   memory wall for MawForge to relieve.
3. **L10 (as scoped on 2026-07-15) is an empty-content stall, not a capacity problem.**
   The council's *own* verdict names the direct remedy — the SLM + symbolic-validator
   reprompt loop (L8), already approved — and the underlying bug (Gemma emitting to
   `reasoning_content` with empty `content`) is already mitigated in code.
4. **MawForge is real, rigorous, and solves a genuine problem — just not this one.**
   It is a published arXiv paper (2607.09686, Craig Opie / Holocron Security, 17 Jun 2026)
   with a working llama.cpp-derived runtime. But its value binds only when a MoE model's
   full weights **exceed fast memory**: it was validated on a **24 GB** MacBook Pro serving
   **25–34 GB** MoE models under an 18 GiB budget. Robert's box is **64 GB** — even those
   test models would fit resident there without MawForge — and the queue runs a **dense**
   model besides. The paper also makes **no answer-quality or reliability claim** ("measures
   systems behavior, not answer quality"), so it cannot address L10's empty-content stall.

**Verdict: do not adopt.** The technique is sound; the fit is wrong. Revisit only if the
queue deliberately moves to a MoE model whose weights exceed the 64 GB box (see "Conditions
to revisit").

---

## 1. What MawForge is

MawForge is a **real, published systems paper with a working runtime** — not, as an earlier
draft of this evaluation wrongly stated, an unlocatable label. The correction was surfaced
by QA and is important, so the provenance is documented in full here.

- **Citation:** Craig Opie, *"MawForge: Memory-Bounded Expert Materialization for Local
  Mixture-of-Experts Inference,"* Holocron Security, Inc., arXiv:2607.09686 [cs.LG],
  submitted 17 Jun 2026. <https://arxiv.org/abs/2607.09686>. (It surfaced in the 2026-07-15
  ingestion/knowledge-council; my first pass failed to find it because the WebSearch tool is
  US-index-limited and returned only adjacent work. That was a material research miss.)
- **What it does (the "split-pack + materialization" method).** A packer reads a GGUF MoE
  model and separates tensors into **common tensors** (kept resident) and **expert tensors**
  (split into deterministic per-layer/per-expert blocks stored on disk as `experts.pack` +
  `experts.index`). The serving worker keeps the common tensors resident, allocates a small
  number of bounded per-layer **slot tensors**, and on a cache-miss **materializes** the
  requested expert block into a slot on demand. It ships as `mawforge serve`, an
  OpenAI-compatible local endpoint, on a **llama.cpp-derived Metal worker**. A static
  `serve plan` check rejects any cache/context config whose lower-bound footprint
  `C + E(p) + K(n)` exceeds the memory budget *before* load.
- **The problem it solves.** Fitting a MoE model whose **full weights exceed the machine's
  fast-memory envelope** onto that machine, by trading resident footprint for on-demand
  expert I/O. It is explicitly framed as a **capacity/feasibility** mechanism, *"not a
  cache-maximization policy,"* and it *"measures systems behavior, not answer quality."*
- **What the paper actually demonstrated (evidence quality matters for a "should we adopt"
  call).**
  - **Hardware:** a single **MacBook Pro M5 Pro, 24 GB** unified memory; **18 GiB** serving
    target; June 8–9 2026.
  - **Models:** Gemma 4 26B A4B Q8_0 (**25 GB** on disk), Qwen3.6 35B A3B Q8_0 (**34 GB**),
    Qwen3.6 35B A3B Q4_K_M (**20 GB**) — every profile larger than the comfortable resident
    envelope of the 24 GB box.
  - **Result (RQ1):** completed all **540** statically-feasible generation rows under 18 GiB
    with **0 memory-guard triggers**; rejected 60 over-budget rows up front. A **direct
    stock full-GGUF llama.cpp load** of Gemma 4 26B A4B Q8_0 at 32K crossed the 98%
    system-used guard (hit **99.19%**) and was killed with no output, where MawForge's
    split-pack path served the same row. This is the paper's core, and it is credible.
  - **Costs the paper is candid about:** decode throughput is **1.30–13.86 tok/s** (Gemma
    Q8 4K) and TTFT reaches **~92–167 s** at high cache; cache size is **non-monotonic**
    (bigger cache → higher hit rate but often *worse* throughput under memory pressure);
    MTP speculative decoding **hurt** (decode 9.52→8.31 tok/s while materialized expert
    bytes rose 48.06→**116.66 GiB**).
- **Maturity caveats.** Single machine, one configuration; evidence *"collected locally by
  the MawForge project rather than an independent laboratory"* with AI-assisted drafting;
  four deterministic prompt classes and 96-token completions — *"does not characterize long
  interactive sessions, multi-turn state growth, streaming workloads, or multi-user
  serving,"* and the author states *"external replication remains necessary."* Legitimate
  work, early-stage evidence.

## 2. What the Local Model Queue actually is

The queue **engine is not in this repo** — it lives in the separate Praxis service
(`PRAXIS_URL`, default `http://127.0.0.1:54322`; berth `Praxis src/local-llm/`). TheNexus
contains three things:

- **A proxy** — `server/routes/local-queue.js` forwards list/enqueue/promote/cancel/retry/
  pause/resume and calendar-window calls to Praxis (`server/shared/constants.js:22`).
- **The dashboard "queue panel"** — the just-shipped surface this task refers to:
  - `dashboard/src/app/local-queue/page.tsx` — full-page "LOCAL LLM QUEUE" view, polls
    `getLocalLlmQueue()` every 5s; stat cards for Queue / Worker flag / Calendar.
  - `dashboard/src/components/local-queue-list.tsx` — reusable panel (currently an orphan
    import; the homepage-embedded widget was specced in
    `docs/superpowers/specs/2026-05-19-redesign-the-nexus-design.md:38`).
  - Bridge/ops embeddings: `dashboard/src/components/bridge/executor-detail.tsx:157-189`
    (`LocalLlmDetail`), `dispatch-station.tsx`, `ops/page.tsx:165-167`,
    `use-crew-activity.ts:135-140`.
  - Client wrappers + types: `dashboard/src/lib/nexus.ts:1164-1263`.
- **Config** — `../nexus-shared/src/endpoints.ts:25` (`localLlm: http://127.0.0.1:1234`,
  LM Studio OpenAI-compatible), env `LOCAL_LLM_URL` / `PRAXIS_URL`.

**The worker** (per `dashboard/src/app/codex/page.tsx:172-187`): LM Studio running
**Gemma 31B QAT** on-metal under Praxis's queue, doing nightly ingestion, community
summaries, skill harvesting, and calendar/history digestion — governed by a **swap-aware
pressure governor** that pauses when the machine strains ("Operator pauses are sacred").
Job types include `knowledge_intake_read`, `nightly_synthesis`, `lars_analysis`,
`stock_analysis`, `ad_hoc_local_prompt`, etc. (`dashboard/src/app/local-queue/page.tsx:21-30`).

Authoritative model facts (`/Volumes/Projects/shared-mind/projects/Praxis LLM Stack.md`):
- Model: **`google/gemma-4-31b-qat`** — a **dense** 31B model, 4-bit QAT, ~17.56 GiB weights.
- Hardware: **M4 Max, 64 GB**. At 128K context: ~13.5 GiB KV + ~17.4 GiB weights + ~2 GiB
  ≈ **33 GiB total, ~20 GB headroom** (`recommendedMaxWorkingSetSize` ≈ 54 GB).
- **On 2026-07-01, Robert explicitly chose Gemma 4 31B QAT over the "26B-A4B MoE" —
  "quality-over-speed."** The MoE path is a road already considered and not taken.
- The real local bottleneck is **latency (prefill ≈ 110 tok/s → minutes of TTFT on big
  prompts)**, not memory. MawForge would not touch prefill latency.

## 3. What L10 actually is

**L10 is not a persisted project need.** TheNexus's `projects.needs` column is empty
(`[]`) — verified directly against `nexus.db`. The "L#" labels are **per-day enumeration
indices** in each morning council's self-assessment, and they are **not stable**: across
recent notes "L10" has meant orphan-entity quarantine (07-09), leaf-entity densification
(07-12), community recompute (07-07), and transaction validation (07-06). Pinning a task
to "L10" is only meaningful *inside the 2026-07-15 note*.

On **2026-07-15**, L10 = **"the local Gemma empty-content stall at rank-select"** — the one
open reliability gap on an otherwise all-green fleet. This is a **content-extraction / prompt
reliability** failure, not a capacity failure. It is well documented:
- `/Volumes/Projects/shared-mind/incidents/2026-06-08 - Morning Routine Stall and Local Empty-Content.md`:
  "Never read only `message.content` from a local Gemma call. It routinely emits everything
  to `reasoning_content`."
- Already mitigated in code: `server/services/ai-service.js` `callLocal` salvages
  `content || reasoning_content` (noted at `ai-service.js:148`), mirrored in Praxis and
  Cortex per the LLM-stack changelog.

The council's own verdict names the **direct** remedy — "Wrap local Gemma in an
SLM + symbolic-validator reprompt loop … the direct remedy for L10's empty-content failure"
(L8, `slm-validator-guided-control-loop`, already **approved**). MawForge is not that remedy.

## 4. The core mismatch

| Dimension | MawForge addresses | L10 / the queue needs |
|---|---|---|
| Problem class | Memory **capacity/feasibility** for large GGUF MoE weights | **Reliability** (empty content at rank-select) + latency |
| Model assumed | GGUF Mixture-of-Experts (larger than fast memory) | Dense (Gemma 4 31B QAT), comfortably resident |
| Binding constraint today | — (none; 64 GB box, ~20 GB headroom) | Prefill latency; content-extraction robustness |
| Throughput profile | 1.3–13.9 tok/s, TTFT up to ~167 s (paper's numbers) | already slower than desired on dense Gemma |
| Answer-quality / reliability | **Explicitly out of scope** ("systems behavior, not answer quality") | the actual failure mode |
| Council's stated remedy | Not named as the remedy | L8 SLM+validator loop (approved) |

Note the irony: the paper's lead test model is **Gemma 4 26B A4B Q8_0** — the *same*
26B-A4B MoE Robert rejected on 2026-07-01. MawForge would let that model *fit*, but its
measured throughput (1.3–13.9 tok/s, multi-minute TTFT at high cache) **reinforces** the
quality-over-speed rejection rather than overturning it. Adopting MawForge would mean:
(a) switching the worker to a MoE model already rejected, (b) to relieve a memory wall that
does not exist on a 64 GB box (where even that 25 GB MoE fits resident), (c) at a throughput
penalty, (d) while leaving the actual L10 reliability bug untouched. Four steps sideways.

## 5. If MoE-on-constrained-hardware ever *does* become a goal

Two tiers of tooling exist, and which one you need depends on how far the model overflows
memory. MawForge earns its keep only at the extreme.

- **Tier 1 — stock offload, already in the stack (the likely-sufficient case).** For a MoE
  that is close to or modestly over the resident envelope, LM Studio's own engine (llama.cpp)
  already keeps expert tensors off the GPU via `--n-cpu-moe` / `-ot (--override-tensor)`. On
  Robert's **64 GB** box this covers a lot of ground — even the paper's 25–34 GB test MoEs
  fit resident here, so no offloading is needed at all. Because the queue worker speaks the
  OpenAI-compatible endpoint (`:1234`), adopting a MoE this size is a **model-load/config**
  change in LM Studio, not an integration — the proxy, queue, and dashboard panel are
  model-agnostic.
- **Tier 2 — MawForge (the genuine gap it fills).** The paper's own direct-load baseline
  shows the honest limit of Tier 1: a **stock full-GGUF llama.cpp load crossed the 98%
  memory guard (99.19%) and was killed** on the 24 GB machine, where MawForge's split-pack
  path served the row under 18 GiB. So when a MoE's weights genuinely **exceed** the box's
  fast memory and stock residency/offload can't keep it under a safe pressure ceiling,
  MawForge (disk-resident expert packs materialized into bounded slots + a pre-load budget
  planner) is exactly the right tool, and it is *more* than stock llama.cpp offload. That
  regime does not exist on the current 64 GB + dense-model setup, but it is the real
  condition under which this evaluation should flip to "adopt/trial."

## 6. Recommendation

- **Do not schedule MawForge integration work now.** MawForge is sound engineering, but the
  win it promises is unavailable on the current setup (no memory wall on the 64 GB box; the
  queue runs a dense model) and it does not touch L10 (a reliability bug it explicitly places
  out of scope). Close/park this evaluation task with the conditions below recorded.
- **Route L10 to its real remedy:** the approved L8 `slm-validator-guided-control-loop`, and
  confirm the `content || reasoning_content` salvage is live on every local call path the
  queue uses. Those close the 2026-07-15 L10 gap.
- **Feed the routing finding back to knowledge-routing** (see Follow-ups): the artifact is
  real, but it was matched to a limitation (L10, an empty-content reliability stall) whose
  *problem class* it does not address. A light "confirm the problem class matches the
  limitation" gate on APPLY lines — not just "does the source exist" — would have caught this.

### Conditions to revisit (when MawForge becomes the right tool)
Reopen and trial MawForge if **all** of these become true:
1. The queue deliberately adopts a **MoE** model (a product decision, reversing 2026-07-01,
   accepting MawForge's 1.3–13.9 tok/s / multi-minute-TTFT profile for the background-cognition
   workload — plausibly fine since the queue is latency-insensitive), **and**
2. that model's **full weights exceed the 64 GB box's safe fast-memory envelope** (a real
   capacity wall — e.g. a much larger MoE, or several loaded concurrently), **and**
3. stock llama.cpp residency / `--n-cpu-moe` offload can't keep it under the pressure ceiling
   (i.e. you hit the paper's direct-load failure mode).

If those hold, MawForge is a strong candidate — but pilot it against its own caveats
(single-machine self-reported evidence; validate throughput/TTFT on *our* M4 Max 64 GB, not
the paper's 24 GB M5 Pro; confirm the OpenAI-compatible `mawforge serve` endpoint drops into
the queue's `:1234` contract). Until then, it solves a problem this system does not have.

---

## Evidence / sources

- Ask provenance & L10 scoping: `/Volumes/Projects/shared-mind/memories/note_knowledge_council_2026-07-15.md`
- Model choice, hardware, headroom, prefill latency: `/Volumes/Projects/shared-mind/projects/Praxis LLM Stack.md`
- Empty-content failure mode: `/Volumes/Projects/shared-mind/incidents/2026-06-08 - Morning Routine Stall and Local Empty-Content.md`
- Queue proxy / panel / config: `server/routes/local-queue.js`, `dashboard/src/app/local-queue/page.tsx`,
  `dashboard/src/components/local-queue-list.tsx`, `dashboard/src/app/codex/page.tsx:172-187`,
  `dashboard/src/lib/nexus.ts:1164-1263`, `../nexus-shared/src/endpoints.ts:25`,
  `server/services/ai-service.js:87-148`
- L10 is not a persisted need: `nexus.db` → `projects.needs` = `[]` for project
  c0117b65-9ad7-4afa-90e6-c675b483ccc3 (queried directly); L10 is an Improvement Ledger
  index generated by `/Volumes/Projects/Praxis/src/morning/improvement-ledger.ts:415`,
  materialized in `/Volumes/Projects/Praxis/data/improvement-ledger/2026-07-15.json`
- **MawForge primary source:** Craig Opie, "MawForge: Memory-Bounded Expert Materialization
  for Local Mixture-of-Experts Inference," Holocron Security, Inc., arXiv:2607.09686 [cs.LG],
  17 Jun 2026 — <https://arxiv.org/abs/2607.09686> (full PDF read for method, hardware, the
  600-row validation matrix, throughput/TTFT numbers, and stated limitations)
- Not integrated in-repo: repo-wide grep finds 0 occurrences of `MawForge` / `mixture of
  experts` / `memory-bounded` in TheNexus (the queue is model-agnostic; no MawForge wiring exists)
