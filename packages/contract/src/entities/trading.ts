import { z } from "zod";

/**
 * Trading wire-format — first cut (paper-only, equities, daily cadence).
 *
 * Scope for round 1:
 *   - persona-council signals
 *   - risk verdict placeholder (deterministic gate lives in Praxis)
 *   - paper fills via Alpaca
 *   - journal entries linking signal → verdict → fill → outcome
 *
 * Not modeled yet: options, limit orders, stop brackets, crypto, multi-leg
 * positions, live-money graduation rules. Those land when round 2 adds the
 * real risk gate and the paper→live switch.
 */

export const TradeDirectionSchema = z.enum(["buy", "sell", "hold"]);
export type TradeDirection = z.infer<typeof TradeDirectionSchema>;

export const PaperOrLiveSchema = z.enum(["paper", "live"]);
export type PaperOrLive = z.infer<typeof PaperOrLiveSchema>;

export const BrokerNameSchema = z.enum(["alpaca"]);
export type BrokerName = z.infer<typeof BrokerNameSchema>;

/** One persona's take on a ticker. */
export const PersonaThesisSchema = z.object({
  persona: z.string(),
  direction: TradeDirectionSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type PersonaThesis = z.infer<typeof PersonaThesisSchema>;

/** Synthesized signal produced by the council + portfolio manager. */
export const TradeSignalSchema = z.object({
  id: z.string(),
  at: z.string().datetime(),
  ticker: z.string(),
  direction: TradeDirectionSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  theses: z.array(PersonaThesisSchema),
  sourceAgents: z.array(z.string()),
});
export type TradeSignal = z.infer<typeof TradeSignalSchema>;

/** Output of the (still-TODO) deterministic risk gate. */
export const RiskVerdictSchema = z.object({
  approved: z.boolean(),
  sizeShares: z.number().int().nonnegative(),
  blockedBy: z.array(z.string()),
  kellyFraction: z.number().optional(),
  vix: z.number().optional(),
  notes: z.string().optional(),
});
export type RiskVerdict = z.infer<typeof RiskVerdictSchema>;

export const PositionSchema = z.object({
  ticker: z.string(),
  qty: z.number(),
  avgEntryPx: z.number(),
  marketValue: z.number().optional(),
  unrealizedPnL: z.number().optional(),
  broker: BrokerNameSchema,
  paperOrLive: PaperOrLiveSchema,
});
export type Position = z.infer<typeof PositionSchema>;

export const FillSchema = z.object({
  orderId: z.string(),
  ticker: z.string(),
  qty: z.number(),
  px: z.number(),
  side: z.enum(["buy", "sell"]),
  broker: BrokerNameSchema,
  paperOrLive: PaperOrLiveSchema,
  at: z.string().datetime(),
});
export type Fill = z.infer<typeof FillSchema>;

/** One full closed loop: signal → verdict → (optional) fill → (optional) outcome. */
export const TradeJournalEntrySchema = z.object({
  id: z.string(),
  at: z.string().datetime(),
  ticker: z.string(),
  signal: TradeSignalSchema,
  verdict: RiskVerdictSchema,
  fill: FillSchema.optional(),
  blockedReason: z.string().optional(),
});
export type TradeJournalEntry = z.infer<typeof TradeJournalEntrySchema>;
