/**
 * Members — the ONE shared people directory of the Praxis ecosystem
 * (2026-07-16 unification of contacts + council members, Robert's directive).
 *
 * One row per member — human (family tester, client, domain expert…) or AI
 * (council seat). Members are project-independent; `project_contacts` links
 * attach them to projects with a per-project role ("Client", "Tester",
 * "Domain expert"), and the same records serve as the council's bench:
 * `claims` carry what a member SAYS they know (per-domain, with notes) while
 * demonstrated standing is computed by Praxis's council reputation ledger
 * keyed on `seat_id`. Praxis's human-comms channel personalizes outreach
 * from these records, and `interaction_log` accumulates Praxis's own notes
 * on every exchange.
 *
 * Stored in TheNexus SQLite (contacts / project_contacts), served by
 * /api/members (canonical) and /api/contacts (legacy alias) on :4000.
 * "Contact" type names remain as aliases for older callers.
 */

import { z } from "zod";

/** How this person prefers to be talked to — freeform but structured. */
export const ContactPreferencesSchema = z
  .object({
    /** Preferred channel: "email" today; "manual" = Robert relays; "sms"/"telegram" later. */
    channel: z.string().optional(),
    /** Tone hints for Praxis-composed mail, e.g. "kid-friendly", "formal". */
    tone: z.string().optional(),
    /** Free-text availability/cadence notes, e.g. "weekends only". */
    availability: z.string().optional(),
    /** Never contact without Robert's explicit approval. */
    requireApproval: z.boolean().optional(),
  })
  .passthrough();
export type ContactPreferences = z.infer<typeof ContactPreferencesSchema>;
export type MemberPreferences = ContactPreferences;

/** A claimed knowledge area — what the member (or Robert) says they know. */
export const MemberClaimSchema = z.object({
  /** Praxis council knowledge domain (reputation.ts taxonomy). */
  domain: z.string(),
  /** Free text: "10y distributed systems", "runs a materials lab". */
  note: z.string().optional(),
  claimedAt: z.string(),
  /** Who asserted it — the member themself, Robert, or an intake interview. */
  source: z.enum(["self", "robert", "intake"]).default("robert"),
});
export type MemberClaim = z.infer<typeof MemberClaimSchema>;

/** One Praxis note about an interaction with this member. */
export const MemberLogEntrySchema = z.object({
  at: z.string(),
  note: z.string(),
  /** What wrote it: "praxis", "consultation", "feedback", "operator"… */
  source: z.string().optional(),
});
export type MemberLogEntry = z.infer<typeof MemberLogEntrySchema>;

export const ContactSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** "human" (default) or "ai" — AI members are council seats. */
  kind: z.enum(["human", "ai"]).optional().nullable(),
  /**
   * Stable council/reputation key: `human:<slug>` or `cli:<backend>`.
   * Generated at creation for humans; the reputation ledger folds on it.
   */
  seat_id: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  /** Relationship shorthand, e.g. "nephew", "sister", "client (TIME)". */
  relationship: z.string().optional().nullable(),
  /** ISO date "1985-06-12" or year "1985" — age derives from it. */
  birthday: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  preferences: ContactPreferencesSchema.optional().nullable(),
  /** What they know that Praxis can't google, e.g. ["board games", "video production"]. */
  expertise: z.array(z.string()).optional().nullable(),
  /** What they care about — feeds outreach relevance. */
  interests: z.array(z.string()).optional().nullable(),
  /** Claimed knowledge per council domain — verified against demonstrated standing. */
  claims: z.array(MemberClaimSchema).optional().nullable(),
  /** Praxis's running notes on interactions (append-only, newest last). */
  interaction_log: z.array(MemberLogEntrySchema).optional().nullable(),
  /** "active" members are selectable/consultable; "dormant" are never tapped. */
  status: z.enum(["active", "dormant"]).optional().nullable(),
  /** Provenance: "operator" (created in the UI), "feedback" (auto-observed), "praxis". */
  source: z.string().optional().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  /** ISO timestamp of the last observed communication either direction. */
  last_contact_at: z.string().optional().nullable(),
});
export type Contact = z.infer<typeof ContactSchema>;

/** The unified directory row — "Member" is the canonical name since 2026-07-16. */
export const MemberSchema = ContactSchema;
export type Member = Contact;

/** Age in whole years from a birthday string ("YYYY-MM-DD" or "YYYY"), or null. */
export function memberAge(birthday: string | null | undefined, now: Date = new Date()): number | null {
  if (!birthday?.trim()) return null;
  const match = birthday.trim().match(/^(\d{4})(?:-(\d{2})-(\d{2}))?/);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isFinite(year) || year < 1900 || year > now.getFullYear()) return null;
  let age = now.getFullYear() - year;
  if (match[2] && match[3]) {
    const hadBirthday =
      now.getMonth() + 1 > Number(match[2]) ||
      (now.getMonth() + 1 === Number(match[2]) && now.getDate() >= Number(match[3]));
    if (!hadBirthday) age -= 1;
  }
  return age;
}

export const ProjectContactLinkSchema = z.object({
  project_id: z.string(),
  contact_id: z.string(),
  /** Their role on THIS project, e.g. "Client", "Tester", "Domain expert". */
  role: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  added_at: z.string(),
});
export type ProjectContactLink = z.infer<typeof ProjectContactLinkSchema>;

/** A contact joined with its link row (what project pages render). */
export const ProjectContactSchema = ContactSchema.extend({
  role: z.string().optional().nullable(),
  link_notes: z.string().optional().nullable(),
  added_at: z.string().optional(),
});
export type ProjectContact = z.infer<typeof ProjectContactSchema>;

// ── Comms feed (bridge indicator drill-down) ────────────────────────────────

/**
 * One external-communication event, either direction, as served by Praxis's
 * GET /api/comms (relayed to the dashboard at /api/praxis/comms).
 */
export const CommsItemSchema = z.object({
  id: z.string(),
  direction: z.enum(["in", "out"]),
  /** What kind of event: feedback | email | reply | questionnaire | query. */
  kind: z.string(),
  /** ISO timestamp of the event. */
  at: z.string(),
  /** The human on the other end (email or name), when known. */
  party: z.string().optional(),
  /** Trace tag (PX-…) when the event belongs to tracked work. */
  tag: z.string().optional(),
  /** One-line human-readable summary. */
  summary: z.string(),
  /** Record status at feed time (triaged/tasked/sent/answered…). */
  status: z.string().optional(),
  /** Widget/display project name, when known. */
  project: z.string().optional(),
});
export type CommsItem = z.infer<typeof CommsItemSchema>;

export const CommsFeedSchema = z.object({
  items: z.array(CommsItemSchema),
  counts: z.object({
    in: z.number(),
    out: z.number(),
    /** Items newer than the `since` the caller passed (0 when no since). */
    new: z.number(),
  }),
  generatedAt: z.string(),
});
export type CommsFeed = z.infer<typeof CommsFeedSchema>;
