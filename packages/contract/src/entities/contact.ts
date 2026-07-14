/**
 * Contacts — the shared people directory of the Praxis ecosystem.
 *
 * One row per human (family tester, client, domain expert…). Contacts are
 * project-independent; `project_contacts` links attach them to projects with
 * a per-project role ("Client", "Tester", "Domain expert"). Praxis's
 * human-comms channel uses the same records to personalize outreach, and the
 * future knowledge-gathering loop reads `expertise`/`interests` to decide WHO
 * to ask when knowledge isn't on the internet.
 *
 * Stored in TheNexus SQLite (contacts / project_contacts), served by
 * /api/contacts on :4000.
 */

import { z } from "zod";

/** How this person prefers to be talked to — freeform but structured. */
export const ContactPreferencesSchema = z
  .object({
    /** Preferred channel: "email" today; "sms"/"telegram" later. */
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

export const ContactSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  /** Relationship shorthand, e.g. "nephew", "sister", "client (TIME)". */
  relationship: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  preferences: ContactPreferencesSchema.optional().nullable(),
  /** What they know that Praxis can't google, e.g. ["board games", "video production"]. */
  expertise: z.array(z.string()).optional().nullable(),
  /** What they care about — feeds outreach relevance. */
  interests: z.array(z.string()).optional().nullable(),
  /** Provenance: "operator" (created in the UI) or "feedback" (auto-observed). */
  source: z.string().optional().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  /** ISO timestamp of the last observed communication either direction. */
  last_contact_at: z.string().optional().nullable(),
});
export type Contact = z.infer<typeof ContactSchema>;

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
