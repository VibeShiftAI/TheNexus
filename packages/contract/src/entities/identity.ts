/**
 * Identity — the single source of truth for who Praxis is.
 *
 * Phase 7 of the rearchitecture: everything that used to live as scattered
 * soul/user/memory markdown files (or hard-coded prompts) collapses into a
 * typed object that the Praxis agent reads at boot and every channel adapter
 * can consult for voice/tone shaping.
 *
 * The identity object is owned by TheCortex (persistent, graph-backed), with
 * a local-file fallback inside Praxis for offline boot and a last-resort
 * hard-coded default baked into the runtime. Consumers never read the files
 * directly — they call `getIdentity()` and let the runtime resolve the tier.
 */

import { z } from "zod";

/**
 * Known channels Praxis speaks through. Kept as a string enum so future
 * surfaces (Slack, Discord, etc.) can be added without breaking consumers
 * — the runtime will fall back to the `default` voice when a channel name
 * isn't recognized.
 */
export const IdentityChannelSchema = z.enum([
  "default",
  "nexus",
  "mobile",
  "imessage",
  "gmail",
  "home-assistant",
  "voice",
  "system",
]);
export type IdentityChannel = z.infer<typeof IdentityChannelSchema>;

/**
 * Per-channel voice hint. Consumers use these to shape a reply before
 * sending — e.g. trim length for iMessage, stay thorough for Nexus dashboard.
 */
export const ChannelVoiceSchema = z.object({
  /** One-sentence description of the voice for this channel. */
  tone: z.string().optional(),
  /** Soft length ceiling — e.g. "2-3 sentences", "under 500 chars". */
  length: z.string().optional(),
  /** Emoji usage policy. */
  emoji: z.enum(["none", "sparse", "natural", "heavy"]).optional(),
  /** Format hints — "markdown", "plain", "voice-friendly", etc. */
  format: z.string().optional(),
  /** Extra free-form guidance appended to the system prompt. */
  notes: z.string().optional(),
});
export type ChannelVoice = z.infer<typeof ChannelVoiceSchema>;

/**
 * The operator — the human Praxis works with.
 * Mirrors what user.md carries today, typed and indexable.
 */
export const OperatorProfileSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  pronouns: z.string().optional(),
  role: z.string().optional(),
  goals: z.string().optional(),
  workStyle: z.string().optional(),
  communicationPreferences: z.string().optional(),
});
export type OperatorProfile = z.infer<typeof OperatorProfileSchema>;

/**
 * Identity — the full object. Any field may be absent; the runtime
 * composes whatever is present into the final system prompt.
 */
export const IdentitySchema = z.object({
  /** Agent name. */
  name: z.string(),
  /** How the agent refers to itself (pronouns, nickname). */
  pronouns: z.string().optional(),
  /** One-line tagline — used in headers and status bars. */
  tagline: z.string().optional(),

  /**
   * "Soul" — who the agent is, non-negotiable. Rendered first in the prompt.
   * Free-form markdown; `loadIdentity()` keeps it intact.
   */
  soul: z.string(),

  /** Operator profile (the human). */
  operator: OperatorProfileSchema.optional(),

  /**
   * Persistent memory block — important facts, ongoing relationships, etc.
   * Distinct from per-session working memory (which lives in SQLite/Cortex).
   */
  memory: z.string().optional(),

  /**
   * Channel-keyed voice map. `default` is used when a specific channel
   * isn't listed. Unknown channels fall back to `default`.
   */
  channelVoices: z.record(IdentityChannelSchema, ChannelVoiceSchema).optional(),

  /** Hard-limit behaviors — things the agent must never do. */
  boundaries: z.array(z.string()).optional(),

  /** Provenance — where this identity was loaded from. */
  source: z.enum(["cortex", "local-file", "default"]).optional(),

  /** ISO-8601 timestamp of last mutation. */
  updatedAt: z.string().datetime().optional(),
});
export type Identity = z.infer<typeof IdentitySchema>;

/**
 * Patch shape for `upsertIdentity` — all fields optional so the agent can
 * tweak one slice (e.g. mobile channel voice) without resending the whole
 * persona.
 */
export const IdentityPatchSchema = IdentitySchema.partial().extend({
  updatedBy: z.string().optional(),
});
export type IdentityPatch = z.infer<typeof IdentityPatchSchema>;
