# Review priorities

Approved by Robert in this chat, October 6, 2026.

Show “Blocking N tasks” with task links on document rows and in the reader.
Prioritize blocking documents before pagination. Persist explicit waiting-task IDs
separately from the producer task; never infer a review requirement merely from
sharing a project or a task dependency. Exclude terminal and archived tasks.
Approval of the current revision clears the indicator; a new revision restores it.

Allow producers to declare blocking_task_ids, and allow the reviewer to move a
reference into the queue and edit waiting-task links without registering another
document. Preserve revision history, feedback and decisions. This surface records
review requirements; it does not dispatch, approve, publish, or send.

Reconcile legacy references individually from their review history and successors;
promote unresolved current drafts, retaining already-reviewed and superseded
outlines as reference. Record the exact changes and evidence.

Acceptance: API tests prove accurate counts, lifecycle changes, input validation,
and ordering before pagination. UI tests prove readable task links and promotion.
A separate dashboard build and live API/browser check verify the integrated result.
