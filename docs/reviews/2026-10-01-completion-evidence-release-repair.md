# Completion-evidence release repair (GitHub run 36876516205)

Repair task: `4e93bf2c-eee2-46f4-a322-a0c72b86f411`. Original feature task:
`30daf8ea-2c8b-426f-8fc8-0ccc5fb219a5` (board-completed, QA passed, auto-committed
as `3d24a68`).

## Failure

CI/CD Pipeline run 36876516205 on `main` at `3d24a68` finished `failure`: job
`lint` success, job `build` failure in the "Build dashboard" step, job `deploy`
skipped. The build error was:

```
Type error: Cannot find module '@/lib/task-evidence' or its corresponding type declarations.
```

`3d24a68` tracked `dashboard/src/hooks/use-task-evidence.ts`,
`dashboard/src/lib/__tests__/task-evidence.test.ts` and
`server/routes/task-evidence.js`, but none of the modules they import. The same
gap existed server-side: the committed route requires
`server/services/task-evidence.js`, which was untracked, so a clean checkout of
`3d24a68` would also fail to start the API.

## Why the files were omitted

The Praxis QA-pass auto-commit (`Praxis/src/orchestrator/qa-pass-commit.ts`) commits
only files it can attribute to the task. Attribution is proven per file through the
write-receipt chain (`Praxis/src/executors/write-receipts.ts`): the worktree blob must
equal the `after` oid of the task's last confirmed receipt, and only Edit/Write tool
calls record receipts. Evidence from the original run log
(`Praxis/data/claude-code-runs/30daf8ea-2c8b-426f-8fc8-0ccc5fb219a5.log`) and the
receipt ledger for that task:

- Round 1 created the feature files through Edit/Write, so receipts exist
  (for example `dashboard/src/lib/task-evidence.ts` null to `8979297f`).
- QA failed criteria 1 and 2. The correction round rewrote
  `server/services/task-evidence.js` (14:20:40Z), `dashboard/src/lib/task-evidence.ts`
  and `dashboard/src/components/task-view/evidence-dossier-panel.tsx` (14:21:14Z, a
  `python3` heredoc edit script) and `server/__tests__/task-evidence.test.js`
  (14:21:38Z) through shell heredocs. Shell writes leave no receipt, so the worktree
  blobs (`2a9174a6`, `0eac6480`, `5f5f6b22`, `60e53807`) no longer matched the last
  receipt and the commit withheld all four as unattributable.
- `dashboard/src/app/task-board/page.tsx` and `dashboard/src/app/task/[id]/page.tsx`
  were only ever edited through a python heredoc (14:06:59Z) and have no receipt at all.
- `server/server.js` had a receipt chain starting at before-oid `991cb26d`, which is
  not HEAD's `c80cb135`: the file already carried a sibling session's uncommitted
  routing-economics mount, so it was contested and withheld.
- The three files that did land were written only with Edit/Write and never changed
  again, so they matched their receipts exactly.

The local QA pass still saw every file in the shared working tree; the clean CI
checkout did not. This is a Praxis pipeline property (shell-heredoc writes are
invisible to attribution, and the auto-commit has no import-closure or clean-export
gate). Fixing that belongs to a separately scoped Praxis task; nothing in Praxis was
changed by this repair (read only).

## Release contents

Commit `4b25c46e1d37ecf6be6afd0c447e7a2e330a7770` on `main`, 7 files, +1294 / -1, every
file byte-identical to the reviewed working tree (no feature code was rewritten):

- `dashboard/src/lib/task-evidence.ts` (new, the missing `@/lib/task-evidence`)
- `dashboard/src/components/task-view/evidence-dossier-panel.tsx` (new)
- `dashboard/src/app/task/[id]/page.tsx` (panel import and mount, `id="task-walkthrough"`
  anchor the panel links to)
- `dashboard/src/app/task-board/page.tsx` (evidence badge on completed cards)
- `server/services/task-evidence.js` (new, required by the committed route)
- `server/__tests__/task-evidence.test.js` (new, 19 tests)
- `server/server.js`: only the comment and the `/api/task-evidence` mount (3 lines),
  staged with `git apply --cached` from a patch that drops the sibling's
  `/api/routing-economics` line

Staging used explicit pathspecs only (no `git add -A`, no `git commit -a`); the index
held nothing else at commit time.

## Preserved shared work

Left untouched and uncommitted with their owners: `.env.example`,
`dashboard/src/app/activity/page.tsx`, `dashboard/src/components/task-view/dispatch-console.tsx`,
`dashboard/src/components/usage-routing-panel.tsx`, `dashboard/src/lib/dispatches.ts`,
`db/work-admission.js`, `docs/work-admission.md`, `server/routes/dispatch-insight.js`,
`server/routes/dispatches.js`, the routing-economics line in `server/server.js`, and the
untracked routing-economics, run-cost, operator-answers, `docs/plans/` and
`docs/reviews/2026-09-28-routing-economics/` files. Dirty-path count went from 26 to 20,
exactly the 6 release paths that became clean plus the partially committed `server/server.js`.
No stash, checkout, restore, reset or delete was run.

## Validation (local, before the push)

Clean export, never the live tree: `git archive 4b25c46 | tar -x` into
`/tmp/nexus-ci-verify/TheNexus`; `nexus-shared` cloned from GitHub at `bdc8993` (its
current `origin/main`) into `/tmp/nexus-ci-verify/nexus-shared`, `npm install && npm run build`
(CJS and DTS build success); root `npm ci` (709 packages); dashboard `npm ci` (546 packages,
installed contract copy byte-equal to the sibling `dist/index.js`). The live
`dashboard/.next` (Sep 7 mtimes) and the supervised :3000 and :4000 processes were not touched.

- Dashboard production build in the export: `npm run build` printed
  "Compiled successfully" and "Generating static pages (28/28)", `BUILD EXIT 0`
  (`/tmp/nexus-ci-verify/dashboard-build.log`).
- Static closure over the committed tree: every `@/` and relative import in 375
  `dashboard/src` files and every relative `require` in 243 `server/` and `db/` files
  resolves to a tracked file, except five references that predate `3d24a68`, are
  unchanged by this commit, and built green in run 36875738297
  (`ai-terminal-clear.test.tsx`, `stakeholder-policy.test.js`,
  `usage-stats-migration.test.js`, two tool requires in `routes/initiatives.js`).
- Server Jest in the export: `npx jest` 106 suites passed, 3 failed, 1250 tests passed;
  the 3 failing suites are the known pre-existing ones (`openrouter-free-lane`,
  `praxis-stream`, `studio-route`). `server/__tests__/task-evidence.test.js` passed 19/19
  in the export and in the real checkout.
- Dashboard tests in the export: `npm test` 637 of 638 passed; the one failure is
  `nexus-barrel.test.ts`, which shells to `git log` and cannot run in an archive export.
  It passes 2/2 in the real checkout.
- Exported server boot on a free port with a throwaway `NEXUS_DB_PATH`:
  `GET /api/health` 200; `GET /api/task-evidence?task_ids=nope` 200 with
  `{"spineAvailable":true,"tasks":{}}`; `GET /api/task-evidence/nope` 404
  `{"error":"Task not found"}`; `/api/routing-economics` 404 (not part of this release).
  The child was stopped with SIGTERM.
- Encoding gate: strict UTF-8 decode, mojibake scan and em-dash scan over the 7 committed
  files (0 em dashes in added lines) and the commit message: clean.

## Publication and remote CI

These are four different things and only the last one is GitHub success:

1. Local validation: passed, as listed above.
2. QA approval: this repair task's QA review happens after this record; the original
   feature's QA pass (14:27Z) covered the shared working tree, not a clean checkout.
3. Commit and push, done under the brief's own instruction to "stage/commit/publish only
   attributable necessary changes" and to "record commit and actual GitHub result if
   publication occurs" (same basis as repair task 0542c200 and commit `51f5a6b` on
   2026-09-07): `4b25c46` committed at 14:45:44Z and pushed to `origin/main` on 2026-10-01 (push run created 2026-10-01T14:48:26Z)
   (`3d24a68..4b25c46`), confirmed with `git ls-remote origin main`.
4. Remote CI: GitHub Actions run 36879250180
   (https://github.com/VibeShiftAI/TheNexus/actions/runs/36879250180) at `4b25c46`
   completed with conclusion `success`; jobs `lint`, `build` and `deploy` all `success`.
   The `deploy` job reports status only: `.github/workflows/ci.yml` (the `deploy` job,
   line 76 onward) echoes a message and delegates the actual deployment to Netlify. No
   Netlify deployment was verified here; green `deploy` means the build passed on `main`.
   The earlier failure at `3d24a68` (run 36876516205) stays on record as a failed run; it
   is superseded, not re-run.

## Follow-up (separately scoped, Praxis)

- Writes made through shell heredocs or scripts record no write receipt, so a correction
  round that rewrites a file that way makes the whole file unattributable and the
  QA-pass auto-commit withholds it silently. Either record receipts for shell writes, or
  make the executor brief require Edit/Write for source edits.
- The auto-commit could run an import-closure check (or a clean-export build) over the
  commit it is about to make and refuse, or at least flag, a commit whose tracked files
  import withheld paths. This is the second time the gap shipped a red build
  (`51f5a6b` on 2026-09-07 repaired the first).
