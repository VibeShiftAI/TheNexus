# Praxis Mind Transaction Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all five praxis-mind MCP writes through a verified, compensatable transaction envelope with an append-only audit log.

**Architecture:** A generic coordinator owns transaction lifecycle and log verdicts. Existing MCP handlers provide domain adapters that continue to call the current validated API/filesystem paths and perform fresh read-back verification.

**Tech Stack:** Node.js CommonJS, MCP SDK, Zod, Jest, native filesystem and fetch APIs.

---

## File map

- Create `services/praxis-mind-mcp/lib/transition-log.js`: append/read records and build compensation payloads.
- Create `services/praxis-mind-mcp/lib/transactions.js`: lifecycle coordinator, deep comparison helpers, transaction error type.
- Create `services/praxis-mind-mcp/bin/transition-log.js`: read-only inspection/compensation CLI.
- Modify `services/praxis-mind-mcp/lib/config.js`: configurable transition-log location.
- Modify `services/praxis-mind-mcp/lib/backends.js`: project and Cortex episode read-back helpers.
- Modify `services/praxis-mind-mcp/tools/nexus.js`: task create/update and project update adapters plus expected-state arguments.
- Modify `services/praxis-mind-mcp/tools/vault.js`: file capture/read-back adapter plus expected-state arguments.
- Modify `services/praxis-mind-mcp/tools/memory.js`: episode capture/read-back adapter.
- Modify `services/praxis-mind-mcp/package.json`: CLI script/bin metadata.
- Create `server/__tests__/praxis-mind-transactions.test.js`: coordinator/log/compensation tests with mocked APIs.
- Create `server/__tests__/praxis-mind-write-envelope.test.js`: tool wiring and mocked-backend behavior tests.

### Task 1: Transaction lifecycle and log

- [ ] Write a Jest test that executes a transaction against mocked capture/apply/read functions and expects a committed JSONL record containing caller, before, and after.
- [ ] Run `npx jest server/__tests__/praxis-mind-transactions.test.js --runInBand` and confirm it fails because the transaction modules do not exist.
- [ ] Implement secure append, record reads, terminal verdicts, and `TransactionError` with the smallest API needed by the test.
- [ ] Re-run the focused test and confirm it passes.
- [ ] Add failing tests for stale preconditions (apply not called), apply failure with best-effort after capture, and postcondition mismatch.
- [ ] Implement those lifecycle branches and re-run until green.

### Task 2: Compensation and CLI

- [ ] Add failing compensation tests covering task/project updates, task/memory creates, and existing/new vault files.
- [ ] Implement deterministic compensation payload generation from the record's tool, target, before, and after images.
- [ ] Add CLI argument tests or hand-execution coverage for `list`, `show`, and `compensate` output; implement the read-only CLI.
- [ ] Re-run the transaction test suite and confirm all compensation cases pass.

### Task 3: Nexus write adapters

- [ ] Add mocked-backend handler tests proving stale `expected_status` rejects task update and a read-back mismatch returns an error and logs `postcondition_mismatch`.
- [ ] Run the focused handler test and confirm RED.
- [ ] Add `nexusProjectById`; wrap project update, task create, and task update with adapters while preserving existing API calls, rate limits, privileges, and ledger entries.
- [ ] Add expected-state schema fields and exact field/need read-back comparisons.
- [ ] Re-run focused tests and confirm GREEN.

### Task 4: Vault and memory adapters

- [ ] Add failing tests proving vault before/after capture and memory create read-back behavior through mocked filesystem/backend boundaries.
- [ ] Wrap `vault_write`, including `expected_exists` and `expected_content`, and verify exact final file content.
- [ ] Add `cortexEpisodeById`; wrap `memory_write` with a generated id and fresh Cypher read-back.
- [ ] Re-run focused tests and confirm GREEN.

### Task 5: Verification and review

- [ ] Run `npx jest server/__tests__/praxis-mind-transactions.test.js server/__tests__/praxis-mind-write-envelope.test.js --runInBand` and confirm all focused tests pass.
- [ ] Run `npm test -- --runInBand` and distinguish any unrelated pre-existing failures from regressions.
- [ ] Run `node services/praxis-mind-mcp/bin/transition-log.js --help` and a temporary-log `list/show/compensate` smoke test.
- [ ] Inspect `git diff --check`, `git status --short`, and the complete scoped diff against every acceptance criterion without touching unrelated dashboard/data changes.
