# ai-terminal.tsx — inventory and module map

Ticket **P2-27**, 2026-09-03. Before this pass `src/components/ai-terminal.tsx`
was **2,275 lines** carrying seven unrelated concerns in one component. A
2026-07-02 comment (then at lines 36–38) records an earlier pruning that
removed the Agent/Chat modes and the model picker but did not decompose, so
the file grew straight back.

After: **698 lines** — composition plus chat transport. Everything below is a
move, not a redesign: every prop, aria-label, `data-testid` / `data-message-row`
attribute, `className`, keyboard shortcut and autoplay timing rule is
unchanged.

---

## 1. Inventory of the original component

Classification key: **T** transport · **R** rendering · **A** audio/voice ·
**F** attachments · **H** history/scrollback · **L** task-links · **Y** layout.

### Module-level values (outside the component)

| Symbol | Governs | Class | Now lives in |
|---|---|---|---|
| `AITerminalProps` / `AITerminalHandle` | modal-vs-inline mode, `hideHeader`, imperative new-conversation / history | Y | `ai-terminal.tsx` |
| `createClientMessageId()` | optimistic message id for the send round-trip | T | `ai-terminal.tsx` |
| `voiceKeyForMessage(msg, vidx)` | stable voice identity (id-based, never array index) | A | `hooks/use-chat-audio.ts` |
| `messageKey(msg)` | stable transcript row identity for memoized rows | H | `hooks/use-chat-history.ts` |
| `VOICE_PLAYED_STORE_KEY` / `_MAX` | localStorage registry of notes this device started | A | `hooks/use-chat-audio.ts` |
| `VOICE_AUTOPLAY_FRESH_MS` (3 min) | inline voice-note freshness window | A | `hooks/use-chat-audio.ts` |
| `REPORT_AUTOPLAY_FRESH_MS` (re-export of `VOICE_AUTOPLAY_FRESH_MS` from `lib/chat-audio`) | full-status-report freshness window | A | `hooks/use-chat-audio.ts` |
| `loadPlayedVoiceStore()` | lazy, SSR-safe read of that registry | A | `hooks/use-chat-audio.ts` |
| `readPraxisEventStream()` | SSE frame parser for streamed Praxis deltas | T | `ai-terminal.tsx` |
| `MESSAGE_PROSE` | the one prose scale shared by every conversational message | R | `components/chat/markdown-message.tsx` |
| `TASK_LINK_CLASS` | task-id mention styling | L | `components/chat/markdown-message.tsx` |
| `TaskLinkedText` (memo) | plain-text turns with task ids linked | L | `components/chat/markdown-message.tsx` |
| `REMARK_PLUGINS` / `MARKDOWN_COMPONENTS` | remarkGfm + remarkTaskLinks; internal-vs-external `<a>`, scrollable `<table>`, Prism `code` | R + L | `components/chat/markdown-message.tsx` |
| `MarkdownMessage` (memo) | the expensive remark/Prism render for one message | R | `components/chat/markdown-message.tsx` |
| `RENDER_WINDOW` 200 / `RENDER_WINDOW_SLACK` 40 / `REVEAL_PAGE` 100 | transcript DOM window | H | `hooks/use-chat-history.ts` |
| `COMPOSER_MAX_HEIGHT` 200 | textarea auto-grow cap | Y | `components/chat/composer.tsx` |
| `ChatComposer` + `ChatComposerProps` | the draft textarea and send button (own keystroke state) | Y | `components/chat/composer.tsx` |

### `useState` inside `AITerminal`

| State | Governs | Class | Now lives in |
|---|---|---|---|
| `loading` | a send/ingest is in flight; disables the composer, shows the typing dots | T | `ai-terminal.tsx` |
| `hiddenCount` | messages trimmed off the HEAD of the DOM window | H | `hooks/use-chat-history.ts` |
| `pendingArtifact` | **dead** — set nowhere, read nowhere | — | removed |
| `attachedFiles` | the `File[]` that will be uploaded on send | F | `hooks/use-file-attachments.ts` |
| `attachedPreviews` | chip metadata (name/size/type/thumbnail URL) | F | `hooks/use-file-attachments.ts` |
| `isDragging` | drag-over highlight + drop overlay | F | `hooks/use-file-attachments.ts` |
| `showConversations` | history panel open/closed | H | `hooks/use-chat-history.ts` |
| `critiqueFeedback` | `{messageKey, text, loading}` for the inline revision form | Y | `ai-terminal.tsx` (passed down) |
| `approvalLoading` | which row's Approve button is mid-request | Y | `ai-terminal.tsx` (passed down) |
| `expandedArtifact` | which artifact row is expanded (legacy nodes, vote reasoning) | R | `ai-terminal.tsx` (passed down) |
| `reviewModalData` | `{artifact, messageKey}` for the fullscreen plan review | R | `ai-terminal.tsx` (passed down) |
| `isRecording` / `recordingTime` | MediaRecorder capture + elapsed seconds | A | `hooks/use-voice-recorder.ts` |
| `audioBlob` / `audioPreviewUrl` | the captured memo and its preview object URL | A | `hooks/use-voice-recorder.ts` |
| `dismissedVoice` / `listenedVoice` | per-note badge state; both suppress autoplay | A | `hooks/use-chat-audio.ts` |

### `useRef` inside `AITerminal`

| Ref | Governs | Class | Now lives in |
|---|---|---|---|
| `dragCounter` | enter/leave balance across child elements | F | `hooks/use-file-attachments.ts` |
| `fileInputRef` / `mediaInputRef` | the two hidden `<input type=file>` elements | F | `hooks/use-file-attachments.ts` |
| `mediaRecorderRef` / `audioChunksRef` / `recordingTimerRef` | recording machinery | A | `hooks/use-voice-recorder.ts` |
| `voiceAudioRefs` | live `<audio>` elements keyed by voice key | A | `hooks/use-chat-audio.ts` |
| `nowPlayingVoiceRef` | the single note currently speaking | A | `hooks/use-chat-audio.ts` |
| `voiceQueueRef` | notes waiting their turn (one voice at a time) | A | `hooks/use-chat-audio.ts` |
| `voiceStartPendingRef` | double-start guard across the ~0.5 s chirp window | A | `hooks/use-chat-audio.ts` |
| `playedVoiceRef` | in-memory mirror of the persisted played registry | A | `hooks/use-chat-audio.ts` |
| `pendingReportRef` | the fresh briefing staged for the global player | A | `hooks/use-chat-audio.ts` |
| `messagesContainerRef` | the scroll container | H | `hooks/use-chat-history.ts` |
| `prevMessageCountRef` / `prevScrollHeightRef` | prepend-vs-append detection and scroll compensation | H | `hooks/use-chat-history.ts` |
| `isNearBottomRef` | stick-to-bottom; also gates the DOM-window trim | H | `hooks/use-chat-history.ts` |

### `useEffect` / `useImperativeHandle`

| Effect (deps) | Governs | Class | Now lives in |
|---|---|---|---|
| `[conversationId]` | reset the DOM window on conversation switch | H | `hooks/use-chat-history.ts` |
| `useImperativeHandle([startNewConversation, loadConversations])` | host-driven new-conversation / toggle-history | Y | `ai-terminal.tsx` |
| `[messages]` | the transcript autoplay scan: stage a fresh report, enqueue fresh voice notes, kick the queue | A | `hooks/use-chat-audio.ts` |
| `[isLoadingHistory, conversationId, isOpen, jumpToBottom]` | open at the newest message (+150 ms settle re-pin) | H | `hooks/use-chat-history.ts` |
| `[messages, hiddenMessageCount]` | trim the DOM window, only while pinned and past the slack | H | `hooks/use-chat-history.ts` |
| `[visibleMessages]` | append-follow, prepend scroll compensation, streaming-growth re-pin | H | `hooks/use-chat-history.ts` |
| `[input, resizeInput]` (ChatComposer) | textarea auto-grow | Y | `components/chat/composer.tsx` |
| `[isOpen, isInline]` (ChatComposer) | focus on open, modal only | Y | `components/chat/composer.tsx` |
| `[]` (ChatComposer) | `nexus:chat-seed` window listener — any deck surface can fill the composer | Y | `components/chat/composer.tsx` |

### Handlers

| Handler | Governs | Class | Now lives in |
|---|---|---|---|
| `getPlayedVoice` / `markVoicePlayed` | lazy load + persist the started-playback registry (capped at 300) | A | `hooks/use-chat-audio.ts` |
| `playCommChirp` | two WebAudio rising tones before each auto-played note | A | `hooks/use-chat-audio.ts` |
| `maybeStartPendingReport` | start the briefing on the global player once the inline queue drains | A | `hooks/use-chat-audio.ts` |
| `playNextQueuedVoice` | the one-at-a-time queue + last-active-device gate | A | `hooks/use-chat-audio.ts` |
| `saveVoiceMemo` | base64 → Blob → browser download | A | `hooks/use-chat-audio.ts` |
| `jumpToBottom` | scroll to newest, re-pin after first paint | H | `hooks/use-chat-history.ts` |
| `handleMessagesScroll` | near-bottom tracking; reveal-then-paginate at the top | H | `hooks/use-chat-history.ts` |
| `handleFileDrop` | 25 MB filter, 5-file cap, image thumbnails, console note | F | `hooks/use-file-attachments.ts` |
| `handleDragEnter` / `handleDragOver` / `handleDragLeave` / `handleDrop` | drag-and-drop | F | `hooks/use-file-attachments.ts` |
| `removeFile` | drop one chip and revoke its object URL | F | `hooks/use-file-attachments.ts` |
| `startRecording` / `stopRecording` / `clearAudio` | voice memo capture | A | `hooks/use-voice-recorder.ts` |
| `handleSend` | synchronous accept/reject decision, `/ingest` slash command, optimistic user row | T | `ai-terminal.tsx` |
| `runIngest` | `POST /api/ingest` | T | `ai-terminal.tsx` |
| `runSend` | file upload, base64 audio, retry-once fetch, SSE-vs-JSON response, error banners | T | `ai-terminal.tsx` |
| `renderTerminalContent` | the shared inline/modal body | Y | `ai-terminal.tsx` |

### Inline subcomponents (JSX rendered in place, no component boundary)

| Block | Class | Now lives in |
|---|---|---|
| Fullscreen plan-review modal (own prose scale, own ReactMarkdown + Prism, approve / request-revisions) | R + Y | `components/chat/plan-review-modal.tsx` |
| Terminal header (title, scope badge, new-conversation, history, close) | Y | `components/chat/terminal-header.tsx` |
| Conversation history panel | H | `components/chat/conversation-list.tsx` |
| Transcript row: system line / system card / user / assistant bubble | R | `components/chat/message-row.tsx` |
| Artifact renderers: `PLAN_DRAFT`, `PLAN_REVISED`, `COMPILED_PLAN`, `COUNCIL_REVIEW`/`VOTE_SUMMARY`, `UNKNOWN_ARTIFACT`, catch-all | R | `components/chat/message-row.tsx` |
| Morning status-briefing player card | A | `components/chat/message-row.tsx` |
| Inline voice-note cards (`<audio>`, save, dismiss) | A | `components/chat/message-row.tsx` |
| Attachment preview chips | F | `components/chat/attachment-chips.tsx` |
| Composer row: hidden inputs, chips, audio preview chip, mic / photo / paperclip buttons | F + A + Y | `components/chat/composer.tsx` (`ComposerRow`) |
| Drop overlay, empty state, "loading older", scroll-up hint, typing dots | Y | `ai-terminal.tsx` |

---

## 2. Module map

| File | Lines | Owns |
|---|---:|---|
| `src/components/ai-terminal.tsx` | 698 | composition + transport (`readPraxisEventStream`, `handleSend`, `runIngest`, `runSend`), modal/inline shell |
| `src/components/chat/markdown-message.tsx` | 142 | `MarkdownMessage`, `TaskLinkedText`, `MESSAGE_PROSE`, `TASK_LINK_CLASS` — both memoized |
| `src/components/chat/message-row.tsx` | 550 | one transcript row: bubbles, artifacts, briefing player, voice notes |
| `src/components/chat/plan-review-modal.tsx` | 277 | fullscreen plan review (keeps its own roomier prose scale — deliberate) |
| `src/components/chat/composer.tsx` | 290 | `ChatComposer` (draft state, Enter/Shift+Enter, IME guard) + `ComposerRow` |
| `src/components/chat/terminal-header.tsx` | 88 | title bar and its controls |
| `src/components/chat/conversation-list.tsx` | 79 | history panel |
| `src/components/chat/attachment-chips.tsx` | 72 | attachment preview chips |
| `src/hooks/use-chat-audio.ts` | 367 | autoplay decisions, voice queue, chirp, played registry, briefing handoff |
| `src/hooks/use-chat-history.ts` | 204 | DOM render window, stick-to-bottom, reveal-then-paginate, history panel toggle |
| `src/hooks/use-file-attachments.ts` | 190 | `attachmentsReducer` (pure) + selection / drag-drop / preview / removal |
| `src/hooks/use-voice-recorder.ts` | 91 | MediaRecorder capture and the memo preview |

## 3. Autoplay timing rules (unchanged, now stated once)

In `hooks/use-chat-audio.ts`:

- A **full status report** auto-plays only when this device has never *started*
  it, the hosting message is younger than `REPORT_AUTOPLAY_FRESH_MS` (3 min),
  it is not already the global player's item, and it is not already staged.
  (`shouldQueueReportAutoplay`)
- An **inline voice note** auto-plays only when this device has never started
  it, it is neither dismissed nor listened, and the message is younger than
  `VOICE_AUTOPLAY_FRESH_MS` (3 min). (`shouldQueueVoiceAutoplay`)
- Eligibility is keyed by stable message **identity**, never array position, so
  a history load or a mid-list merge surfaces an old note without re-announcing.
- Exactly one Praxis voice speaks at a time; a manual play preempts everything,
  including the global briefing player.
- Announcements only speak on the device Robert most recently touched; on an
  inactive client the queue is dropped and marked played, and the
  "New Voice Message" badge stays for manual play.

## 4. Tests

- `src/hooks/__tests__/chat-audio-autoplay.test.ts` — the fresh-report decision
  (all four conditions, both boundaries of the window) and the voice-note
  variant; plus voice-key identity.
- `src/hooks/__tests__/file-attachments-reducer.test.ts` — the attachment list
  reducer: size filter, 5-file cap with head-wins, thumbnail-only-for-images,
  and the revoke set for remove / clear / overflow.
- `src/components/__tests__/ai-terminal-shape.test.ts` — the ratchet:
  ai-terminal.tsx imports neither `react-markdown` nor
  `react-syntax-highlighter` (nor `remark-gfm`) and stays under 700 lines.
