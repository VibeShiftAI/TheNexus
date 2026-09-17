# Combadge cue before announcements

At the operator's request, proactive cockpit voice alerts now play the clean TNG combadge sample before speaking. The 0.456-second MP3 is served locally at /audio/tng-combadge.mp3, at 45% element volume. Source and provenance are in dashboard/public/audio/README.md.

The voice player prepares the first speech chunk, plays the cue once, waits for its end, and then starts speech. Normal interactive voice replies and manual playback do not receive this cue. The existing automatic chat/report path uses the same clip instead of its prior synthesized tones.

Speech ownership spans cue and voice. Cancellation stops the cue and suppresses late speech; alert eligibility is rechecked before and after the cue. Error, blocked autoplay and a two-second timeout leave the message available to read/replay. A failed automatic report cue consumes that automatic attempt so releasing its audio reservation cannot trigger an endless retry loop.

Verification: all 446 dashboard tests passed; npx tsc --noEmit passed. Regression coverage includes synthesis/cue/speech ordering, one cue across multiple speech chunks, cancellation, failed/stalled cue cleanup, replay dedupe, legacy chat ownership, report cue failure, and unchanged interactive replies. afinfo validated the MP3. The live dashboard served an exact SHA-256 match of the local asset and returned HTTP 200. The supervised dashboard runs next dev, so these source and static asset changes are live without restarting Praxis. No test announcement or example push was sent.

Only /Volumes/Projects/TheNexus was edited. Existing shared dirty changes were preserved; no commit or push. The source-only delta against the starting files is /Volumes/Projects/reviews/combadge-cue-2026-09-08/changes.patch.
