import type { Task } from './tasks';
import { API_URL, authFetch } from './shared';

// ═══════════════════════════════════════════════════════════════
// STAKEHOLDERS — PDM governance: request approval queue, comms
// settings, Project Status Reports (via Praxis), review meetings
// (@praxis/contract shapes — entities/stakeholders.ts)
// ═══════════════════════════════════════════════════════════════

import type {
    StakeholderGate as _StakeholderGate,
    StakeholderDecision as _StakeholderDecision,
    ProjectCommsSettings as _ProjectCommsSettings,
    ReportTemplate as _ReportTemplate,
    StakeholderReport as _StakeholderReport,
} from '@praxis/contract';
import type { CalendarEvent } from '../calendar';
import { calendarEventsUrl } from '../calendar';

export type StakeholderGate = _StakeholderGate;
export type StakeholderDecision = _StakeholderDecision;
export type ProjectCommsSettings = _ProjectCommsSettings;
export type ReportTemplate = _ReportTemplate;
export type StakeholderReport = _StakeholderReport;

/** How the dashboard signs every gate decision it records. */
export const OPERATOR_DECIDER: NonNullable<StakeholderDecision['decided_by']> = {
    name: 'Robert (operator)',
    via: 'operator',
};

/** A gated feedback request as served by GET /api/projects/:id/requests. */
export interface ProjectRequest {
    id: string;
    name: string;
    description?: string;
    status: string;
    priority?: number;
    created_at: string;
    updated_at?: string;
    source?: string;
    gate: StakeholderGate;
}

/** Requests awaiting (or past) a PDM/operator decision. `pending` = gate still open. */
export async function getProjectRequests(projectId: string, status: 'pending' | 'all' = 'pending'): Promise<ProjectRequest[]> {
    const res = await authFetch(`${API_URL}/${encodeURIComponent(projectId)}/requests?status=${status}`);
    if (!res.ok) throw new Error(`Requests API unavailable (${res.status})`);
    const data = await res.json();
    return Array.isArray(data?.requests) ? data.requests : [];
}

/** Record a gate decision on a request task (approve → idea, reject/duplicate → cancelled, defer → stays blocked). */
export async function decideStakeholderRequest(
    taskId: string,
    body: StakeholderDecision,
): Promise<{ success: boolean; task: Task; gate: StakeholderGate }> {
    const res = await authFetch(`/api/tasks/${encodeURIComponent(taskId)}/stakeholder-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to record decision (${res.status})`);
    return data;
}

// ─── Review meetings (calendar series, event_type "stakeholder_meeting") ───

export type MeetingRecurrence = 'weekly' | 'biweekly' | 'monthly';

/** Calendar row + the series fields stakeholder meetings carry. */
export interface MeetingEvent extends CalendarEvent {
    series_id: string | null;
    recurrence: MeetingRecurrence | null;
    /** Member ids invited to the meeting. */
    attendees: string[];
}

export interface CreateMeetingSeriesInput {
    title: string;
    /** ISO timestamp of the first occurrence. */
    start_time: string;
    end_time?: string;
    /** Default 60. */
    duration_minutes?: number;
    /** null/undefined = one-off meeting. */
    recurrence?: MeetingRecurrence | null;
    /** Occurrences when recurring (default 12, max 52). */
    count?: number;
    project_id: string;
    attendees?: string[];
    description?: string;
}

function normalizeMeeting(raw: CalendarEvent & Partial<MeetingEvent>): MeetingEvent {
    return {
        ...raw,
        series_id: raw.series_id ?? null,
        recurrence: raw.recurrence ?? null,
        attendees: Array.isArray(raw.attendees) ? raw.attendees : [],
    };
}

/** Stakeholder review meetings for a project between two instants (inclusive window). */
export async function getProjectMeetings(projectId: string, from: Date, to: Date): Promise<MeetingEvent[]> {
    const url =
        `${calendarEventsUrl(from.toISOString(), to.toISOString())}` +
        `&project_id=${encodeURIComponent(projectId)}&event_type=stakeholder_meeting`;
    const res = await authFetch(url);
    if (!res.ok) throw new Error(`Calendar API unavailable (${res.status})`);
    const data = await res.json();
    const rows: Array<CalendarEvent & Partial<MeetingEvent>> = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
    // Defensive client-side filter — an older server ignores the query filters.
    return rows
        .filter((e) => e.event_type === 'stakeholder_meeting' && (e.project_id ?? null) === projectId)
        .map(normalizeMeeting)
        .sort((a, b) => a.start_time.localeCompare(b.start_time));
}

/** Create a one-off meeting (recurrence null) or a series of occurrences. */
export async function createMeetingSeries(body: CreateMeetingSeriesInput): Promise<{ series_id: string; events: MeetingEvent[] }> {
    const res = await authFetch('/api/calendar/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to schedule meeting (${res.status})`);
    return {
        series_id: data.series_id,
        events: Array.isArray(data.events) ? data.events.map(normalizeMeeting) : [],
    };
}

/** Remove every occurrence of a series starting at/after `from` (default: now). */
export async function deleteMeetingSeries(seriesId: string, from?: Date | string): Promise<{ deleted: number }> {
    const fromIso = from instanceof Date ? from.toISOString() : from;
    const qs = fromIso ? `?from=${encodeURIComponent(fromIso)}` : '';
    const res = await authFetch(`/api/calendar/series/${encodeURIComponent(seriesId)}${qs}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to delete meeting series (${res.status})`);
    return { deleted: Number(data.deleted ?? 0) };
}

/** Delete a single calendar event (one meeting occurrence). */
export async function deleteCalendarEvent(id: string): Promise<void> {
    const res = await authFetch(`/api/calendar/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to delete event (${res.status})`);
    }
}

// ─── Project Status Reports (Praxis, via the Nexus relay) ──────────────────

const STAKEHOLDER_REPORTS_URL = '/api/praxis/stakeholder-reports';

/** Reports Praxis has generated for a project, newest first. */
export async function listStakeholderReports(projectId: string): Promise<StakeholderReport[]> {
    const res = await authFetch(`${STAKEHOLDER_REPORTS_URL}?project_id=${encodeURIComponent(projectId)}`);
    if (!res.ok) throw new Error(`Reports API unavailable (${res.status})`);
    const data = await res.json();
    const reports: StakeholderReport[] = Array.isArray(data?.reports) ? data.reports : [];
    return [...reports].sort((a, b) => (b.generated_at ?? '').localeCompare(a.generated_at ?? ''));
}

/**
 * Ask Praxis to compose a report now. `dryRun` builds a preview (no send, no
 * HITL card) — it also makes Praxis create the project's branded template the
 * first time.
 */
export async function generateStakeholderReport(projectId: string, opts: { dryRun?: boolean } = {}): Promise<StakeholderReport> {
    const res = await authFetch(`${STAKEHOLDER_REPORTS_URL}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, trigger: 'manual', ...(opts.dryRun ? { dry_run: true } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Report generation failed (${res.status})`);
    if (!data?.report) throw new Error(data.detail || data.error || 'Praxis returned no report');
    return data.report as StakeholderReport;
}

/** Send a draft/review report to its recipients. */
export async function sendStakeholderReport(id: string): Promise<void> {
    const res = await authFetch(`${STAKEHOLDER_REPORTS_URL}/${encodeURIComponent(id)}/send`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) throw new Error(data.error || `Failed to send report (${res.status})`);
}

/** Dashboard-relative URL of a report's rendered HTML (served by the existing Praxis report proxy). */
export function stakeholderReportPreviewUrl(htmlFile?: string | null): string | null {
    if (!htmlFile) return null;
    const path = htmlFile.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    return `/api/praxis/report/${path}`;
}

