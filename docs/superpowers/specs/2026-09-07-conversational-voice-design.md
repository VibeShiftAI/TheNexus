# Conversational cockpit voice

The approved frontend scope expands spoken replies and useful task announcements while keeping Praxis as the sole conversational runtime. One shared speech owner coordinates direct voice, recording, inline notes, and global briefings. Automatic speech waits; explicit playback and microphone requests interrupt. A canceled session aborts synthesis and cannot regain ownership after asynchronous completion.

Replies retain their complete text and synthesize sequential sentence-aware chunks of at most 1,600 characters. Above 24,000 characters the panel retains the full response and explicitly explains the spoken limit. Returned voiceData is played directly. Voice chat requests add voiceConversation: true to the existing chat seam.

Spoken alerts offer Off, Attention, and Conversational modes. Existing disabled alerts remain off; new installations default to Conversational. Attention includes failures and unexpected HITLs; Conversational adds task completion and blocking. Titles come from the shared board cache. Quiet hours remain 22:00–08:00, routine morning HITLs remain excluded, and announcements retain a two-minute interval with an actual deferred wakeup. Only the active device speaks. A bounded persisted event registry and Web Locks prevent duplicate alerts across tabs where locks are available.

Recording allows sixty seconds, shows elapsed time, and stops after ten seconds without speech or the existing silence interval after speech. Microphone, timers, fetches, and playback are released on cancellation and unmount. Automatic follow-up listening is excluded from this bounded pass.

Acceptance: regression tests prove complete sequential speech and stale-session cancellation; alert tests prove selection, quiet/rate timing, active gating and dedupe; cross-player tests prove direct capture interrupts playback while automatic audio waits. Run existing audio tests and dashboard typecheck. Parent owns production build, runtime verification, and deployment.
