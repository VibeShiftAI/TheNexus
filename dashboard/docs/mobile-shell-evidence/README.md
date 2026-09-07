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
