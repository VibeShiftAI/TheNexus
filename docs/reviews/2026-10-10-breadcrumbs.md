# Dashboard breadcrumb verification — October 10, 2026

Expanded the existing upper-left navigation at 28 locations with a shared accessible breadcrumb component. Dashboard (`/`) is always the first ancestor; intermediate links remain independently clickable. Current page labels truncate with a full-text title, and trails wrap on narrow displays. Task, document, Academy, Studio, labeling and vault-document hierarchies retain their meaningful parents. Studio links preserve the channel query parameter. Labeling navigation is in its persistent header, including during loading, and its Nexus logo now links home.

Validation:
- Final isolated production build: `NEXT_DIST_DIR=.next-breadcrumbs-verify npm run build` — exit 0. Build-generated tsconfig include entries removed; original bytes verified.
- Final component suite: `node --import ./test/register.mjs --test 'src/components/__tests__/*.test.mjs'` — 380 passed, 0 failed.
- Full dashboard suite: 921 passed, 9 failed out of 930. All nine failures are in `voice-command-bar.test.ts`. A test mirror using the pre-breadcrumb TSX snapshots reproduced exactly the same nine failures (43 passed, 9 failed), confirming they predate this navigation change.
- Live browser: Task → Dashboard reaches `/`; Task → Task Board reaches `/task-board`; Academy skill → Academy reaches `/academy`; Simulator → Object Catalog → Studio preserves `channelId=praxis-youtube`. Document review displays Dashboard, Task Board, source task, and document title after loading.
- Responsive checks at 375px: task and document trails wrap; Simulator retains all ancestors. LLM Activity's Dashboard label was initially squeezed by its old nonwrapping header, then verified fully visible after adding wrapping and preventing the breadcrumb from shrinking.
- Independent code review: no remaining actionable findings after adding the vault activity ancestor and correcting the narrow headers. `git diff --check` passes.

Existing unrelated working-tree edits were preserved. No API, task data, or orchestration behavior was changed. The supervised development server picked up the navigation changes without a restart.

Screenshot: `/Volumes/Projects/reviews/nexus-breadcrumbs-2026-10-10/task-breadcrumbs.png`.
Detailed build/test logs and task-scoped before/after diff: `/tmp/nexus-breadcrumbs-20261010/`.
