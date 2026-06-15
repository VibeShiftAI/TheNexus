# Design Spec: Add Intake Report Log (Notebook View)

## Status
Approved

## Goal
Add a tabbed notebook to log the daily intake reports, sorted by date.
These reports (`ingestion-report` notes) are generated during nightly sweeps and will be integrated directly with the Nightly Run History on the Knowledge Ingestion page so that clicking a run reveals both the high-level AI Intelligence Report and the technical run details.

## Proposed Architecture & Changes

### 1. Data Source
- Ingestion reports are stored in the SQLite `notes` table with `category = 'ingestion-report'` and `project_id = NULL`.
- They will be fetched on the client side using the existing `getGlobalNotes` API endpoint from `dashboard/src/lib/nexus.ts`.

### 2. Client State
- In `dashboard/src/app/knowledge-ingestion/page.tsx`, we will add state for all ingestion reports:
  ```typescript
  const [reports, setReports] = useState<Note[]>([]);
  ```
- In `loadAll()`, we will fetch global notes, filter by `category === 'ingestion-report'`, and store them.
- We will add a state to track the active detail tab in the run detail view:
  ```typescript
  const [detailTab, setDetailTab] = useState<'report' | 'details'>('report');
  ```

### 3. Run matching
- When a user selects an ingestion run (`selectedRun`), we will look up a matching report by comparing dates:
  1. Check for matching `YYYY-MM-DD` of `run.created_at` and `note.created_at`.
  2. Fall back to finding a report whose timestamp is within 12 hours of the run.
- When `selectedRun` changes, if a matching report exists, we set `detailTab` to `'report'`. If no matching report exists, we default to `'details'`.

### 4. UI Layout (Nightly Ingestion & Intake Hub)
- Inside the run history detail view (the right column of the grid), we will render a tab selector at the top:
  - **📝 Intake Report**: Renders the matched report using `ReactMarkdown` and `remark-gfm` in a styled scrollable container.
  - **📊 Ingestion Details**: Renders the existing technical run summary (search queries, outcomes per source, discovered items).
- If no report is found, the **Intake Report** tab will show: "No AI Intelligence Report was generated for this run."

## Verification Plan
- Verify that global notes of category `ingestion-report` are loaded and displayed.
- Verify that selecting a run matches and shows the corresponding daily report.
- Verify that toggling between the tabs shows the correct content.
