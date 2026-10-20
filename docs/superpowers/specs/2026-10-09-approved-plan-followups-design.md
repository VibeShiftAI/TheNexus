# Follow-ups from today's approved plan

Robert approved this behavior in chat on October 9 and clarified that the related tasks are downstream successors.

Keep the existing Calendar/Home interface and explicit automatic-start controls. Populate prepared follow-ups only after today's America/New_York morning plan is approved. Roots must be non-withdrawn approved slots represented on today's calendar. Traverse board dependency and successor links downstream; show unfinished, unarchived descendants that are not already scheduled. Completed roots and completed intermediate tasks retain their lineage for the rest of the day. Show the approved root task titles beside each follow-up and retain every unresolved dependency, including prerequisites outside the plan.

This is a read projection, not approval or dispatch. Existing morning standing consent, explicit automatic-start intent, execution queue, running work and QA remain unchanged. No plan, pending/rejected/old plan, missing calendar evidence or unreadable schedule means no prepared follow-ups. Actual running/queued/review work remains visible independently.

Use the existing read-only slate lifecycle reader; no new scheduler or approval store. Recompute on each live-work refresh. Tests use isolated SQLite, fake runtime and injected schedule data. Verify both dashboard surfaces and the live read-only endpoint after activation.

## October 13 scope refinement

Robert requested that the crowded follow-up section show only QA improvements and direct follow-ups. Ordinary prepared tasks now require one dependency or successor link from an approved calendar root. Do not traverse further through unfinished, completed, or already scheduled intermediate tasks. A later task can appear if its own direct predecessor is independently in today's approved plan. Preserve QA improvement records and actual running, queued, and review activity.

Acceptance: direct follow-ups retain their root attribution; transitive milestones are absent; QA improvement visibility remains intact. Verified by the approved-plan-followups, dispatch-insight-live-work, and task-improvements suites (63 tests).
