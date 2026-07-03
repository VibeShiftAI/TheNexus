# Intake Report Log Implementation Plan

> **Status: ✅ SHIPPED — verified against the codebase 2026-07-02.** The unchecked boxes below were never ticked during execution and are NOT open work. Canonical open-items list: shared-mind vault → `projects/Open Items Board.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the daily intake reports (notes with category `ingestion-report`) directly with the Nightly Run History on the Knowledge Ingestion page, displaying them in a tabbed notebook interface when a run is selected.

**Architecture:** Fetch global notes of category `ingestion-report` on the client, match the selected run to a report by date/time proximity, and render a tabbed pane in the run detail view displaying either the markdown report or technical run details.

**Tech Stack:** Next.js, React, ReactMarkdown, remarkGfm, Tailwind CSS.

---

### Task 1: Update Knowledge Ingestion Page to Fetch Global Notes

**Files:**
- Modify: `dashboard/src/app/knowledge-ingestion/page.tsx`
- Test: Manual verification of page load and logs.

- [ ] **Step 1: Import notes API functions and components**
  Add imports for `getGlobalNotes` and the type `Note` from `@/lib/nexus`, and `ReactMarkdown`, `remarkGfm`, and `normalizeMarkdown`.
  
  ```typescript
  import { getGlobalNotes, type Note } from "@/lib/nexus";
  import ReactMarkdown from "react-markdown";
  import remarkGfm from "remark-gfm";
  import { normalizeMarkdown } from "@/lib/normalizeMarkdown";
  import { BookOpen } from "lucide-react";
  ```

- [ ] **Step 2: Add reports and tab selection states**
  Inside the `KnowledgeIngestionPage` component, add:
  
  ```typescript
  const [reports, setReports] = useState<Note[]>([]);
  const [detailTab, setDetailTab] = useState<"report" | "details">("report");
  ```

- [ ] **Step 3: Update `loadAll` to fetch global notes**
  Fetch global notes inside the `loadAll` function:
  
  ```typescript
  const loadAll = useCallback(async () => {
      try {
          setError(null);
          setLoading(true);
          const [overviewData, runList, notesData] = await Promise.all([
              getIngestionOverview(),
              getIngestionRuns(14),
              getGlobalNotes(),
          ]);
          setOverview(overviewData);
          setRuns(runList.runs);
          
          // Filter notes for daily intake reports
          const reportNotes = (notesData || []).filter(
              (n) => n.category === "ingestion-report"
          );
          setReports(reportNotes);
      } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to load dashboard data");
      } finally {
          setLoading(false);
      }
  }, []);
  ```

- [ ] **Step 4: Add run-to-report matching logic**
  Add `getLocalDateString` helper and the `matchingReport` useMemo hook:
  
  ```typescript
  const getLocalDateString = (isoString?: string | null) => {
      if (!isoString) return "";
      try {
          return new Date(isoString).toISOString().split("T")[0];
      } catch {
          return "";
      }
  };

  const matchingReport = useMemo(() => {
      if (!selectedRun) return null;
      const runDate = getLocalDateString(selectedRun.created_at);
      
      // 1. Try YYYY-MM-DD match
      const byDate = reports.find(r => getLocalDateString(r.created_at) === runDate);
      if (byDate) return byDate;
      
      // 2. Proximity fallback (within 12 hours)
      const runTime = new Date(selectedRun.created_at).getTime();
      let bestMatch: Note | null = null;
      let minDiff = Infinity;
      for (const r of reports) {
          const diff = Math.abs(new Date(r.created_at).getTime() - runTime);
          if (diff < minDiff && diff < 12 * 60 * 60 * 1000) {
              minDiff = diff;
              bestMatch = r;
          }
      }
      return bestMatch;
  }, [selectedRun, reports]);
  ```

- [ ] **Step 5: Auto-switch tabs when selected run changes**
  Modify `openRun` to default to "report" if a report is found, otherwise "details":
  
  ```typescript
  const openRun = useCallback(async (runId: string) => {
      try {
          const runDetail = await getIngestionRunDetail(runId);
          setSelectedRun(runDetail);
          
          // Check if there is a matching report
          const runDate = getLocalDateString(runDetail.created_at);
          const hasReport = reports.some(r => getLocalDateString(r.created_at) === runDate);
          setDetailTab(hasReport ? "report" : "details");
      } catch (err) {
          setNotice(err instanceof Error ? err.message : "Failed to load run");
      }
  }, [reports]);
  ```

- [ ] **Step 6: Commit changes**
  ```bash
  git add dashboard/src/app/knowledge-ingestion/page.tsx
  git commit -m "feat: fetch and match daily intake reports to runs"
  ```

---

### Task 2: Render Tabbed Notebook View in Run History Detail

**Files:**
- Modify: `dashboard/src/app/knowledge-ingestion/page.tsx`
- Test: Verify visual appearance of tabs and markdown rendering.

- [ ] **Step 1: Update the Run Details Pane layout**
  Modify the `selectedRun` detail block to include tabs at the top and conditionally render either the markdown report or the technical details.
  
  ```typescript
  // Replace the rendering inside the right panel (max-h-[520px] overflow-y-auto p-4)
  // around lines 871-962
  ```

- [ ] **Step 2: Implement ReactMarkdown report view**
  Inside the "report" tab rendering block, display:
  ```tsx
  {detailTab === "report" ? (
      matchingReport ? (
          <div className="prose prose-invert prose-sm max-w-none text-left
              prose-headings:text-white prose-headings:font-bold prose-headings:mt-4 prose-headings:mb-2
              prose-p:text-slate-300 prose-p:leading-relaxed prose-p:mb-3
              prose-a:text-cyan-400 hover:prose-a:underline
              prose-code:text-cyan-300 prose-code:bg-slate-800/80 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
              prose-pre:bg-slate-950 prose-pre:border prose-pre:border-slate-800
              prose-ul:list-disc prose-ul:pl-5 prose-ul:mb-3 prose-ul:text-slate-300
              prose-ol:list-decimal prose-ol:pl-5 prose-ol:mb-3 prose-ol:text-slate-300
              prose-strong:text-white
              prose-table:w-full prose-table:border-collapse prose-table:my-4
              prose-th:border prose-th:border-slate-800 prose-th:px-3 prose-th:py-2 prose-th:bg-slate-900/50 prose-th:text-white prose-th:font-semibold
              prose-td:border prose-td:border-slate-800 prose-td:px-3 prose-td:py-2 prose-td:text-slate-300
              prose-blockquote:border-l-4 prose-blockquote:border-cyan-500/50 prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-slate-400
          ">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {normalizeMarkdown(matchingReport.content)}
              </ReactMarkdown>
          </div>
      ) : (
          <div className="p-8 text-center text-slate-500 italic text-xs border border-dashed border-slate-800 rounded-lg bg-slate-950/20">
              No AI Intelligence Report was generated for this run.
          </div>
      )
  ) : (
      // Existing details details render
  )}
  ```

- [ ] **Step 3: Run dev server and manually verify**
  Run: `npm run dev` in dashboard folder, view `/knowledge-ingestion` page. Click runs and verify that tabs toggle properly and the report is beautifully rendered.

- [ ] **Step 4: Commit changes**
  ```bash
  git add dashboard/src/app/knowledge-ingestion/page.tsx
  git commit -m "feat: render tabbed notebook and markdown report"
  ```
