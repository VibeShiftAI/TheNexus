# Nexus-Mobile-Android evidence for task 556f1c50 (captured 2026-09-07T21:49:47Z)

Repo: /Users/robertwashko/Projects/Nexus-Mobile-Android (branch council-chamber-mobile, HEAD 9dbdc58).
The task re-point endpoint refused this path ("workspace must be under /Volumes/Projects"), so the mobile
diff is recorded here, inside the home workspace, and the new shell files were staged (git add) in the mobile repo.
app/_layout.tsx, app.json and hooks/use-notifications.test.tsx also carry a sibling session's hunks (first-run gate, versionCode).

```
 app.json                                  |   4 +-
 app/(tabs)/_layout.tsx                    | 209 ++---------
 app/+native-intent.tsx                    |  16 +
 app/_layout.tsx                           | 103 +++--
 app/shell.tsx                             |  23 ++
 components/shell/dashboard-shell.test.tsx | 233 ++++++++++++
 components/shell/dashboard-shell.tsx      | 600 ++++++++++++++++++++++++++++++
 docs/dashboard-shell.md                   | 176 +++++++++
 hooks/use-notifications.test.tsx          |  46 ++-
 lib/shell/bridge.test.ts                  |  75 ++++
 lib/shell/bridge.ts                       | 125 +++++++
 lib/shell/routes.test.ts                  | 147 ++++++++
 lib/shell/routes.ts                       | 205 ++++++++++
 lib/shell/session.test.ts                 |  82 ++++
 lib/shell/session.ts                      |  85 +++++
 tests/legacy-tabs-redirect.test.tsx       |  42 +++
 16 files changed, 1949 insertions(+), 222 deletions(-)
```

Patch: nexus-mobile-android-9dbdc58.patch (sha256 76972c279af451ae974fb5a55cc553c907823d01de2beb0936c7f350e9364232)
APK: /tmp/nexus-mobile-0.6.0.apk sha256 b9ffe69a7b6278780e95f0b80ca10261a2814da593961aacc48fa9533238730d (EAS build 05c2e081-0837-4302-9a56-f1b8ad923916)

## Verification record (appended 2026-09-07 after the QA pass, in answer to the adversarial critic)

Each acceptance criterion with the command or observation that proves it. Commands ran in the repo named; results are quoted, not summarized.

| Criterion | Evidence |
| --- | --- |
| 1. Android app displays the canonical dashboard, no parallel native screens | Mobile repo: `npx jest lib/shell components/shell tests/legacy-tabs-redirect hooks/use-notifications` printed `Test Suites: 6 passed, 6 total / Tests: 45 passed, 45 total`. `components/shell/dashboard-shell.test.tsx` renders the WebView shell against the configured origin; `tests/legacy-tabs-redirect.test.tsx` proves every retired native route redirects into `/shell`. Patch applies to a clean export of mobile HEAD `9dbdc58`: `git apply --check nexus-mobile-android-9dbdc58.patch` exit 0. |
| 2. Desktop routes and actions on phone, no desktop regression, documented width checks | Home repo, isolated production build served on :3055: `AUDIT_STRICT=1 AUDIT_BASE=http://localhost:3055 npm run audit:responsive` printed `34 route/width checks; 0 phone-width overflow(s)` (17 routes at 390 px and 1440 px). Full machine output: `responsive-audit-report.json` in this folder. Dashboard tests `npm test`: 314 pass, 0 fail. Build: `NEXT_DIST_DIR=.next-verify npm run build` exit 0. |
| 3. Auth, connectivity, back, notifications/deep links, chat, voice, attachments; limitations recorded | Same 45-test mobile run covers session priming (`lib/shell/session.test.ts`), navigation policy and Access fallback (`lib/shell/routes.test.ts`), bridge message validation (`lib/shell/bridge.test.ts`), notification tap routing into the shell (`hooks/use-notifications.test.tsx`). Home repo: `dashboard/src/lib/__tests__/mobile-shell.test.ts` and `dashboard/src/components/__tests__/mobile-shell-bridge.test.mjs` cover the web side of the bridge (part of the 314). Device-only checks and the Web Speech limitation are listed in the mobile repo's `docs/dashboard-shell.md`. |
| 4. Tests/typecheck/build pass; installable artifact recorded | Mobile `npm run typecheck` exit 0. EAS build `05c2e081-0837-4302-9a56-f1b8ad923916` status FINISHED (profile preview). APK `/tmp/nexus-mobile-0.6.0.apk`, 126,517,428 bytes, sha256 `b9ffe69a7b6278780e95f0b80ca10261a2814da593961aacc48fa9533238730d`. `aapt2 dump badging` printed `package: name='com.vibeshiftai.nexus' versionCode='1' versionName='0.6.0'`. Download URL: https://expo.dev/artifacts/eas/12a5NpgJzlhqGMnUO9HNDWlF2E-_OIbfx4k81ckP920.apk |

Not claimed: on-device behaviour. `adb devices` listed no device and the SDK has no AVD, so the device-only checklist in the mobile doc remains open.
