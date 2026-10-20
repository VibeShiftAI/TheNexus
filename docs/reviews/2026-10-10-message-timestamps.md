# Worker message timestamps

User requested the latest worker message's update time, distinct from the task start shown at 11:54. The projection now preserves explicit, timezone-qualified structured event timestamps within the dispatch boundary. Missing, invalid and out-of-attempt timestamps stay unknown; log mtime and fetch time never masquerade as message time. The dashboard labels Active time as Started and displays Message updated immediately above the message, with source times in expanded attempt history.

Verification: regression observed failing before implementation; 7 server tests and 13 dashboard model/render tests pass. Isolated Next production build passed using .next-timestamp-verify; generated tsconfig includes removed. Live Nexus API restarted through its existing Praxis supervisor; executor runtime was not restarted. Live task ce8b2315-df02-4a5b-bac1-f88c0c8063f8 API returned latest message at 2026-10-10T16:07:09.548Z. Browser confirmed Started 11:54:29 AM and Message updated 12:07:09 PM above the correct text. Self-review checked timestamp bounds, fallback truthfulness, stale/newer-attempt behavior and unrelated change preservation. No commits or staging.

Limitation: logs without native event timestamps remain explicitly unavailable. This is a message timestamp, not a continuous activity heartbeat.
