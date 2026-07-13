# Praxis Mind Transaction Gate Design

## Goal

Add an auditable transaction envelope around the five praxis-mind MCP write tools without replacing the validation, vocabulary, predecessor, or usage-ledger gates that already exist.

## Considered approaches

1. **Shared envelope with per-tool adapters (selected).** A single coordinator owns capture, precondition, apply, read-back, verification, and append-only logging. Each tool supplies target-specific callbacks and expected fields. This keeps transaction verdicts consistent while preserving each existing write path.
2. **Duplicate the phases inside every tool handler.** This has fewer new abstractions initially, but five subtly different error and log paths would be difficult to audit and likely drift.
3. **Wrap the raw backend HTTP/filesystem clients.** This centralizes writes, but those clients do not know the MCP caller, logical tool, expected state, or compensation intent. It would also make read-back verification hard to describe at the domain level.

## Architecture

`lib/transactions.js` will expose an `executeTransaction` coordinator. A caller supplies the tool name, caller identity, target, intent, and callbacks for before-image capture, apply, after-image read, precondition comparison, and postcondition verification. The coordinator always appends one terminal JSON object to the configured JSONL log. It returns the apply result only after successful read-back verification; stale state, apply failures, read-back failures, and mismatches produce explicit transaction errors carrying the transaction id and verdict.

`lib/transition-log.js` will own secure append-only writes, JSONL inspection, and deterministic compensation generation. Records include schema version, transaction id, timestamps, tool, caller identity/namespace, target, intent, before and after images, verdict, and error or mismatch details. The transition log defaults under `~/.praxis-mind/` and can be redirected in tests.

`bin/transition-log.js` will offer `list`, `show <id>`, and `compensate <id>` commands. Compensation is data only; the CLI never applies it. Update/file transactions restore the recorded before-image, while create-only transactions emit an explicit delete payload containing the created identity and backend namespace/project information.

## Tool adapters

- `nexus_task_update`: capture and re-read with `nexusTaskById`; accept `expected_status` and `expected_updated_at`; verify every patched field against the fresh task row.
- `nexus_project_update`: capture and re-read with a new `nexusProjectById` backend helper; accept `expected_status` and `expected_end_state_updated_at`; execute the existing PATCH/add-need/update-need calls; verify patch fields and requested need changes against the fresh project.
- `nexus_task_create`: before-image is `null`; call the existing validated batch endpoint; obtain the created id from its response and re-read the task; verify the requested project/name/description/priority/dependencies/successor/payload.
- `vault_write`: capture file existence and full content, optionally compare `expected_exists` / `expected_content`, write through the existing allowlist and filesystem path, then re-read and verify the exact resulting content.
- `memory_write`: generate the episode id before entering the envelope, record a null before-image, use the existing `ingest_atoms` endpoint, then re-read the Episodic node through the existing read-only Cypher API and verify id, content, source, and factoids.

## Error handling

Authorization, rate limiting, path allowlisting, and no-op validation remain ahead of the envelope because they reject calls before a write transaction exists. Once an envelope starts, every terminal outcome is logged. An apply exception triggers a best-effort re-read so the log reveals a partial write when possible. A successful API response is not success until fresh state matches the intent.

## Testing

Jest tests will mock the API/backend boundary and use a temporary transition log. They will prove successful before/after logging with caller identity, stale expected-state rejection without an apply call, postcondition mismatch reporting and logging, compensation generation for every supported tool, and registration/routing of all five write handlers through the envelope. Read handlers remain unchanged.

## Scope decisions

There is no auto-repair or compensation application in v1. The gate does not add new server-side vocabularies or dependency validators. The log intentionally contains complete before-images because exact one-step compensation requires them; its directory/file permissions are restricted accordingly.
