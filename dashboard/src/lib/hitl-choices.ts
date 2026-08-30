/**
 * Card choices the dashboard cannot perform, and how to say so.
 *
 * "accept as-is — mark complete" is an operator override of a QA rejection.
 * Praxis refuses it without a high-entropy capability token minted per card
 * and delivered ONLY in that card's push notification (Praxis
 * `src/orchestrator/qa-accept-token.ts`) — deliberately, so that possession
 * of the inbox listing is not enough to complete QA-rejected work. The
 * dashboard has no way to hold one, so the tap can only ever 403.
 *
 * Defined once and imported by both inbox surfaces (the embedded
 * `components/hitl-inbox.tsx` widget and the standalone `app/inbox` page) so
 * the two cannot drift into disagreeing about which choices are phone-only.
 *
 * Found 2026-08-30 after four refused taps across two days: the server had
 * enforced this credential since 2026-08-28 and no client ever sent it.
 */

export const PHONE_ONLY_CHOICE = "accept as-is — mark complete";

export const PHONE_ONLY_HINT =
  "Accepting overrides a QA rejection, so it needs the one-time key from this card's phone notification — tap it in Nexus Mobile instead.";

export function isPhoneOnlyChoice(option: string): boolean {
  return option === PHONE_ONLY_CHOICE;
}
