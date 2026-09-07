# Voice integration with concurrent dashboard changes

Integration baseline: `06c2b39036a9d7ca7cb557da2c4e08693e49369c`. Voice implementation and review fixes: `f12aebd91ef8e8d45e4ca724c5781bf688a3fb58`, `df75985b632eebcdc35f2a18288b719908efc4e0`.

Snapshot closed at `2026-09-07T20:48:29.524076+00:00`. The live dashboard source was read without modification. Its concurrent mobile work and CLI recovery-label change are copied into the isolated worktree so the next build represents the deployed surroundings. These copies are not voice feature changes and must not be copied back over live files during voice rollout.

## Voice integration files

- `dashboard/src/app/layout.tsx`: preserves the live MobileShellBridge import, comment and mount; adds the GlobalVoiceDock import/mount and changes bottom padding from 2.25rem to 7rem.
- `dashboard/src/components/global-voice-dock.tsx` and `dashboard/src/components/bridge/voice-command-bar.tsx`: divide viewport bounds by `--nexus-display-scale` before subtracting margins, preserving enlarged text while fitting the dock and both upward panels at 150% scale. Parent reproduced a settings-panel left edge of -124px at a 390px phone viewport before this fix and owns browser re-verification.
- `dashboard/src/app/page.tsx`: preserves the live responsive wrapping header, smaller gaps, New project accessible label and mobile text visibility; removes only the VoiceCommandBar import and home instance.

## Exact concurrent baseline copies

- `dashboard/src/app/academy/page.tsx`
- `dashboard/src/components/bridge/event-ticker.tsx`

- `dashboard/src/app/globals.css`
- `dashboard/src/app/inbox/page.tsx`
- `dashboard/src/components/__tests__/mobile-shell-bridge.test.mjs`
- `dashboard/src/components/__tests__/nav-sidebar-shell-settings.test.mjs`
- `dashboard/src/components/mobile-shell-bridge.tsx`
- `dashboard/src/components/nav-sidebar.tsx`
- `dashboard/src/lib/__tests__/cli-lane.test.ts`
- `dashboard/src/lib/__tests__/mobile-shell.test.ts`
- `dashboard/src/lib/cli-lane.ts`
- `dashboard/src/lib/mobile-shell.ts`

## Baseline audit and rollout checks

The Academy wrapping and event-ticker overflow classes changed live during this integration and were captured in a second baseline read. Recheck source bytes again immediately before rollout.

A byte-level union of baseline-tracked paths and current live dashboard/src files found exactly these fourteen added/modified files plus one missing baseline file: `dashboard/src/lib/hitl-choices.ts`. The missing file has no live dashboard/src import or reference. Both live and isolated dashboard source have no consumers of its exports. Its concurrent deletion is preserved in isolation for build parity and remains outside the voice rollout. All other live dashboard/src files match the integration baseline byte for byte, including the existing voice implementation.

Before applying voice changes, recheck these captured live SHA-256 values. If a live file changed again, preserve its newer changes before rollout. Only the two root/home integration files and voice feature files are voice rollout candidates; the twelve concurrent copies and the unused-file deletion remain live-owned.

| Live source path | SHA-256 at integration |
| --- | --- |
| `dashboard/src/app/academy/page.tsx` | `540ee41eb456cca4e4e81a4a8969314849c4cc9b636ced17d3b6cb75f5cfa6b3` |
| `dashboard/src/app/globals.css` | `e0697b1be4211866dfc8c3694f6fc2d728252d5d76ba2b3ba633b6659a5325a3` |
| `dashboard/src/app/inbox/page.tsx` | `36813f4c403b88bad5d7eba6fd0182fcec48dc5448de00ba1c05ddce3ce41a58` |
| `dashboard/src/app/layout.tsx` | `43c90615aeb2a33a2ed9c42b69669840ff3c6ed8a1cceac4f0a599e63ac8def9` |
| `dashboard/src/app/page.tsx` | `d9520614a3e2365d8ca9b175a6d010721789f748ac97986e659614eecd2f48fc` |
| `dashboard/src/components/__tests__/mobile-shell-bridge.test.mjs` | `28a7209bb1ca8eae741a0c8c4f4dc944d163faba8c77eeecf4434ba81ce6c9db` |
| `dashboard/src/components/__tests__/nav-sidebar-shell-settings.test.mjs` | `cba99942a3adf31be72ac86040fbaa60d4cc4764ce4f057d146d56140e2fe8be` |
| `dashboard/src/components/bridge/event-ticker.tsx` | `6c0ecef822763ede9bc3e2a99e5a9de378cd18d2e17c412815a22806316aa178` |
| `dashboard/src/components/mobile-shell-bridge.tsx` | `3139f0b835bfe8373cb2ca7fae63c4f7af33e3ca5f6a72186027bc72d74d8cc5` |
| `dashboard/src/components/nav-sidebar.tsx` | `8df91b5849fa7b859b9e67a39972a6c8fcd7249c38f32819f40365efba9b31b3` |
| `dashboard/src/lib/__tests__/cli-lane.test.ts` | `9833a186018cae4ce529131822cd9754981f5d286c3e700e20d68f3425119f1f` |
| `dashboard/src/lib/__tests__/mobile-shell.test.ts` | `b31ccfc05aa09a9b63066675a4cf85ee0a848d47b44aba7c616822aa60553f20` |
| `dashboard/src/lib/cli-lane.ts` | `dc3fd65c494b0626b7c1fb2b4b2c4fba5e58a7580aba91e9e179d82929c195ab` |
| `dashboard/src/lib/mobile-shell.ts` | `feee078f471dcc579b2a8eb542f20b61a91ff3a0cccf46f7de8f36c99289b960` |

Validation: 82/82 targeted voice/audio/dock tests pass, the 20 copied mobile-shell/CLI baseline tests pass, TypeScript without emitting files passes, and git diff --check passes. Parent owns the integrated production build and browser checks at phone width and 150% display scale. Concurrent unrelated route edits may continue after this bounded snapshot; full parity with a moving live tree is not a rollout requirement. Recheck the actual voice rollout destination files before writing them.
