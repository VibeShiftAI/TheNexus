# Dashboard breadcrumbs

**Goal:** Expand the existing upper-left navigation into independently clickable ancestors, always rooted at Dashboard (`/`).

**Design:** Use one shared accessible breadcrumb component in the existing header locations. Pages supply their current label and any intermediate links; the component always supplies Dashboard. Use explicit page hierarchy rather than browser history, so direct links work. Keep the current page as text with `aria-current="page"`; ancestors remain ordinary Next links. Bound long labels and wrap trails on narrow screens.

**Acceptance criteria:**
1. From a task, Dashboard navigates directly to `/`, and Task Board independently navigates to `/task-board`.
2. Nested Academy, Studio, review, and labeling views expose their intermediate pages, preserving existing Studio channel parameters.
3. Existing upper-left home/back links use the same Dashboard-rooted pattern; navigation remains usable on narrow screens and when detail data is unavailable.

**Implementation:**
- [x] Create `dashboard/src/components/breadcrumbs.tsx` with `current`, optional `parents: {label, href}[]`, and optional `className` props.
- [x] Replace existing page-header back links and remove their unused imports. Keep unrelated actions and current local edits intact.
- [x] Run dashboard tests, an isolated production build, and browser navigation checks for task → dashboard, task → board, and a nested section. Review the task-scoped diff.

**Validation commands:** `npm test` and `NEXT_DIST_DIR=.next-breadcrumbs-verify npm run build` in `dashboard/`. Restore only the build-generated tsconfig include rewrite. Browser-check desktop and a narrow viewport against the existing supervised development server; do not launch a second server.
