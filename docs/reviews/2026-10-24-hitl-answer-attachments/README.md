# Photos on inbox answers: root cause and evidence

Task `0df94949-dcae-4c3d-9356-e1e65f0ad75f` (TheNexus), 2026-10-24.
Robert answered questionnaire `ask-robert-0fe6eaf9-7af9-4555-bedb-7b630954b1dd`
(Praxis task `d88e7186-9e9a-4535-961c-fa24cf9e17a4`) and wrote
"I couldn't attach a photo".

## Root cause

Every client Robert could have answered from converges on one surface and one
transport, and neither had a photo path:

- The card. `dashboard/src/components/hitl-card.tsx` is the single inbox card
  (the `/inbox` route, the home inbox panel and the Android shell, which hosts
  the dashboard in a WebView, all render it). It offered a textarea, option
  chips, Send and Park. `HitlResolveInput` was `{ choice?, freeText? }`.
- The transport. The dashboard posts the answer to
  `/api/praxis/hitl/:id/resolve`; the Nexus proxy forwards the JSON body
  verbatim; the Praxis route validates it with `HITLResolveBodySchema`
  (resolvedBy, choice, freeText, payload, audio) and strips unknown keys.
  Nothing in that chain carried, stored or described a file.
- The consumers. `inboxQueryFromAnswer` accepts string or number answers only,
  and the follow-up prompt built by `actOnAnsweredQuery` renders those strings.
- The other channels do not exist: push taps deep-link to `/inbox#<id>` in the
  shell, the Android app defines no notification reply action, and `ask_robert`
  sends no email or hosted form. The saved record (`resolvedBy: "robert"`,
  text only) matches the dashboard card.

So the failure was not a broken upload; there was no attachment path at all.

## The repair

Reuses the chat upload store (`POST /api/chat/files/upload`, served at
`GET /api/chat/files/:fileId`, files under `data/chat-files/`) and rides the
references on the open-typed `payload.attachments` of the existing resolve
body. No contract change.

- Dashboard: the card gets a Photo button, a hidden file input
  (`image/*,.heic,.heif`), chips with thumbnail, name, size and a remove
  button, and an error line. Send uploads pending photos first, then resolves
  with `payload.attachments`. A refused file, a failed upload or a failed
  send keeps the typed answer and the photos on the card; a photo whose upload
  succeeded is not uploaded again on retry. Text-only and choice answers send
  exactly the same body as before (no `payload` key). History rows link the
  saved photos. Pure helpers in `dashboard/src/lib/hitl-attachments.ts`.
- Nexus server: `server/services/hitl-answer-attachments.js` rebuilds every
  reference from the store before the proxy forwards it (UUID id that exists,
  image extension, magic bytes, size, at most four, cleaned name; url, mime
  and size derived on the server). A bad reference is a 400
  `invalid_attachment` and the card stays pending. `NEXUS_CHAT_FILES_DIR`
  lets an isolated stack keep its own store.
- Praxis: `src/hitl/answer-attachments.ts` validates the same shape (zod),
  keeps the list on `resolution.payload.attachments`, and appends a note to
  the saved `freeText` (local file path when the store is on this disk, plus
  the Nexus URL), the way a voice transcription is merged. Every consumer and
  every retry or sweep that re-reads the store therefore sees the photo: the
  ask_robert follow-up prompt, the human-query answer, the generic
  `[HUMAN REPLY]` resume.

## Evidence

Isolated stack, one foreground script, torn down by child PID:
`dashboard/scripts/hitl-attachment-browser-check.mjs`. It runs the Praxis
fixture (`Praxis/scripts/hitl-answer-attachments-fixture.ts`: the real HITL
router over sandboxed stores with the follow-up agent replaced by a
recorder), a throwaway Nexus API on a `.backup` copy of `nexus.db` with its
own chat-files store, a second `next dev` (`.next-verify-hitl`), and headless
Chrome at 390x844 (DPR 2, Android UA, the WebView shell's shape). Result:
`CHECK_RESULT ok (13 steps)`; `report.json` holds every assertion.

Screenshots (`screenshots/`):

| File | Shows |
| --- | --- |
| 01-inbox-card-phone.png | The ask_robert card at phone width with the Photo button; Send disabled with nothing to send |
| 02-photo-picked.png | gmail-screenshot.png picked: thumbnail, name, 234 KB, remove button; Send enabled |
| 03-photo-removed.png | The chip removed before sending; Send disabled again |
| 04-answer-and-photo-ready.png | Photo picked again with the typed answer |
| 05-after-send.png | The card left the pending list |
| 06-history-with-photo-link.png | Resolved history with the 📎 gmail-screenshot.png link to `/api/chat/files/<id>` |
| 07-refused-pdf.png | notes.pdf refused in words; typed answer kept; no chip, no upload |
| 08-refused-oversized.png | A 26 MB file refused in words |
| 09-guard-refused-kept-answer.png | Text named fake.png: uploaded, refused by the Nexus guard (400), the card says so and keeps the answer and the chip; Praxis has no resolution |
| 10-text-only-sent.png | After removing fake.png the text-only answer resolved with no payload |
| 11-choice-card.png, 12-choice-sent.png | A choice card resolved by tapping approve, no payload |
| 13-desktop-history.png | The same history at 1280 px |

Files:

- `report.json`: ports, every step and assertion, the page's API calls
  (exactly two uploads: the photo and fake.png).
- `saved-resolution.json`: the stored card with `payload.attachments` and the
  note in `freeText`, and the answered human query (`answers.q1` carries the
  note).
- `follow-up-prompt.txt`: the follow-up prompt the recorder received, naming
  the task id, the subject, the typed answer, the local file and the URL.

Bytes: the file served at the URL and the local file named in the note both
hash equal to the picked file (sha256 in `report.json`). A repeated submit of
the same body through the Nexus guard returned 200 and produced no second
follow-up. The live `data/chat-files` store was untouched (42 files before
and after).

## Automated checks

- TheNexus server: `npx jest server/__tests__/hitl-answer-attachments.test.js server/__tests__/praxis-stream.test.js server/__tests__/praxis-stream-reconnect.test.js server/__tests__/ai-chat-praxis-stream.test.js`: 34 passed, 1 failed (`praxis-stream route › ignores X-Forwarded-For and judges loopback by the socket peer`, a pre-existing loopback failure recorded before this task; it does not touch the resolve route).
- Dashboard: `npm test` 1103/1108, the 5 failures are the known pre-existing set (ai-terminal line budget and four voice announcement tests, all in files this task did not touch); the 9 HITL tests pass; `tsc --noEmit` exit 0.
- Praxis: `node --test --import tsx tests/hitl_answer_attachments.test.ts` 4/4; `ask_robert_inbox` 5/6 with the same one failure on a detached baseline worktree of HEAD (`partial need write failures are retried`, project-needs path); `hitl_resolve_body_validation` 4/4; `hitl_deeplink_contract` 8/8; `hitl_dispatch_refusal` 9/10 with the same failure on the baseline worktree; `npx tsc --noEmit` exit 0; `npm run check:encoding` on the edited files passed.

## Rerun

```sh
cd /Volumes/Projects/TheNexus/dashboard
node scripts/hitl-attachment-browser-check.mjs
```

Needs Chrome, `sqlite3`, the Praxis checkout beside this repo, and a few
minutes for the second Next dev server to compile `/inbox`.

## Caveats

- The live Praxis process and the live Nexus API run the code they were
  started with. Until both restart, an answer with photos is stored with
  `payload.attachments` (the Nexus guard and the Praxis validator are not yet
  active there), but the note is not folded into the follow-up prompt.
- HEIC photos are accepted and stored; the card's thumbnail preview depends
  on the browser decoding HEIC, so the chip may show a placeholder icon.
- The attachment shape lives in two validators (Nexus and Praxis). Promoting
  it into `@praxis/contract` is a follow-up.
