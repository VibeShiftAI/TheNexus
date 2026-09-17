# Cortex Retrieval Contract Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task.

**Goal:** Make MCP result limits and evidence-only retrieval reach the existing gateway correctly.

**Architecture:** Keep k as the public compatibility argument; translate it only at the HTTP boundary. Expose gateway-supported booleans through the tool schema and preserve existing defaults/provenance.

**Tech Stack:** CommonJS, native fetch, Zod, Jest.

## Task 1: Contract regression and repair

Files: services/praxis-mind-mcp/lib/backends.js, tools/memory.js; new server/__tests__/praxis-mind-memory-search-contract.test.js.

- [x] Add a failing request-body regression for a nondefault limit and explicit evidence/query-expansion switches. Register the actual memory tool with a fake server to validate its Zod argument shape, privilege behavior, and output wrapping.
- [x] Run `npx jest --runInBand server/__tests__/praxis-mind-memory-search-contract.test.js`; observe the contract mismatch before changing production code.
- [x] Change `cortexSearch({ query, k = 10, namespace = 'ai-research', evidence_only = false, include_query_expansion = true })` to send `body: { query, max_results: k, namespace, evidence_only, include_query_expansion }`.
- [x] Add the two boolean options to the memory_search Zod shape and forward them. Preserve all current authorization and provenance code.
- [x] Run the new test and mcp-boundary-security, praxis-mind-stateless-conformance, and praxis-mind-retrieval-health tests.
- [x] Obtain independent spec and quality review, integrate only this delta into shared source, then verify a fresh MCP registration and read-only live gateway request.

Verification and activation completed September 7, 2026. See `/Volumes/Projects/reviews/cortex-retrieval-and-capture-2026-09-07.md` for tested behavior and remaining boundaries. Shared source changes remain uncommitted; unrelated staging is preserved.
