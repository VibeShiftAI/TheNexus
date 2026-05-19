# Design Spec: Redesigning The Nexus Dashboard

**Date:** 2026-05-19  
**Author:** Praxis (AI Co-founder)  
**Status:** Under Review  

---

## 1. Goal Description

Simplify and consolidate **The Nexus** dashboard to focus on the current configuration of **Praxis** (where the terminal is the main interface and Praxis manages Projects, Tasks, and Schedules). 

Currently, The Nexus uses separate full-page views for the Task Board, Calendar, and Local Queue. This design replaces the home page with a single, unified "Command Center" dashboard displaying the Praxis chat terminal alongside schedule, background queue, and task board widgets, with a dual-mode inline inspection system.

---

## 2. User Review Required

> [!IMPORTANT]
> The top navigation header is simplified to a single hamburger menu toggle. Clicking it opens a slide-out drawer containing links to Codex, System Monitor, and Workflow Builder. This keeps the layout extremely clean but hides these secondary pages by default.

---

## 3. UI & Layout Architecture

The redesigned home dashboard (`dashboard/src/app/page.tsx`) will be structured as a 2-column responsive layout:

```
+-------------------------------------------------------------+
| THE NEXUS                             [Standup Active]  [☰] |
+------------------------------------+------------------------+
|                                    |                        |
|                                    | 📅 TODAY'S SCHEDULE    |
|                                    |    - Item 1 (Accordion)|
|                                    |    - Item 2            |
|                                    |                        |
| 💬 PRAXIS CHAT / TERMINAL          +------------------------+
|                                    | 🔄 LOCAL LLM QUEUE     |
|                                    |    - Job 1             |
|                                    |    - Job 2             |
|                                    |                        |
|                                    +------------------------+
|                                    | 📋 COMPACT TASK BOARD  |
|                                    |   [Todo]   [In Progress]|
|                                    |   - Task1  - Task2     |
|                                    |                        |
+------------------------------------+------------------------+
```

### Components List
1. **AITerminal (Left Column - 50%)**: Displays the main Praxis terminal interface using `dashboard/src/components/ai-terminal.tsx` in `inline` mode.
2. **ScheduleTimeline Widget (Right Column - 50% Top)**: Displays today's schedule events chronologically.
3. **LocalQueue Widget (Right Column - 50% Middle)**: Displays active/pending background jobs.
4. **CompactTaskBoard Widget (Right Column - 50% Bottom)**: Displays active tasks in compact cards grouped by status.
5. **Detail Drawer (Right Overlay Panel - 360px wide)**: Slides in from the right edge over the control widgets when a detailed markdown file or task is selected, allowing the user to view/edit markdown notes, checklists, and transcripts while keeping the terminal visible.
6. **Accordion Card Wrapper**: Used in the Schedule and Queue widgets to expand minor details (duration, timestamps, quick logs) directly in-place without triggering the drawer.

---

## 4. Interaction Specs (The Combo)

- **Schedule Event Click**: Expands an Accordion inline to show start/end times and quick comments.
- **Queue Job Click**: Expands an Accordion inline to show attempts, priority, and real-time execution log snippet.
- **Task Board Card Click**: Slides open the **Right Detail Drawer** displaying the complete Markdown description, checklist, and any associated meeting transcripts.
- **Daily Journal/Markdown File Click**: Slides open the **Right Detail Drawer** to edit or read the file.

---

## 5. Implementation Steps

1. **Header HUD Cleanup**:
   - Refactor the main navigation header in `dashboard/src/app/layout.tsx` or a shared component to collapse links into a slide-out hamburger menu.
2. **Dashboard Redesign (`page.tsx`)**:
   - Re-architect `dashboard/src/app/page.tsx` into the new 2-column layout.
   - Embed `AITerminal`, and build/embed the three widgets (`ScheduleTimeline`, `LocalQueue`, `CompactTaskBoard`).
3. **Inspection State & Components**:
   - Implement `InspectorDrawer` and `AccordionCard` components.
   - Manage the selected item state using local React state in the page or a shared hook.
4. **Data Syncing**:
   - Set up automatic polling (every 5 seconds) to fetch updated schedule, queue, and task board state.

---

## 6. Verification Plan

### Automated Verification
- Verify the Next.js app builds successfully: `npm run build` inside `dashboard`.
- Test rendering and click events using interactive browser verification.

### Manual Verification
- Verify that clicking different item types opens the correct Inspector mode (Accordion vs. Right Drawer).
- Verify that editing markdown in the drawer correctly syncs changes to the backend.
