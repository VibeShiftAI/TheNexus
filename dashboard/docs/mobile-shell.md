# Mobile shell: the dashboard is the Android app

Nexus-Mobile-Android (`/Users/robertwashko/Projects/Nexus-Mobile-Android`)
no longer ships its own screens. Since version 0.6.0 the app is a thin native
shell (`components/shell/dashboard-shell.tsx`) that renders this dashboard in
an Android WebView from the server URL configured in the app. Every route the
desktop has is the route the phone has; a dashboard change ships to the phone
with no native work. The native-side design, session priming and trust
boundary are documented in that repo's `docs/dashboard-shell.md`; this file
covers what the dashboard provides and how the responsive layer works.

## Entry point and connectivity

- The shell loads `<serverUrl>` from the app's connection settings. The
  verified deployment is the Cloudflare tunnel `https://nexus.vibeshiftai.com`
  (ingress `/api/*` and `/socket.io/*` to :4000, everything else to :3000).
  The phone is never assumed to reach `localhost`.
- Cloudflare Access is satisfied natively: the shell fetches `/api/health`
  with the app's Access service-token headers and the resulting
  `CF_Authorization` cookie lands in the WebView cookie jar before the first
  page load. The dashboard never sees those credentials.
- The WebView user agent carries a `NexusMobileShell/<version>` suffix.

## Shell contract (what this repo exposes)

| Piece | File | Role |
| --- | --- | --- |
| Detection | `src/lib/mobile-shell.ts` | `getMobileShell()` / `useMobileShell()` return the frozen `window.__NEXUS_MOBILE_SHELL__` object only when it exists for the current origin and `ReactNativeWebView.postMessage` is present. |
| Outbound messages | `src/lib/mobile-shell.ts` | `postToShell(message)` sends JSON to the shell. |
| Bridge | `src/components/mobile-shell-bridge.tsx` | Mounted in `src/app/layout.tsx`; renders nothing outside the shell. Posts `ready` on mount, `navigated` on every App Router change, `badge` with the pending inbox count; listens for the `nexus-mobile-navigate` event and pushes the sanitized path (hash-only changes update `location.hash` so `/inbox#<hitl id>` deep links resolve in place). |
| Sidebar entry | `src/components/nav-sidebar.tsx` | "Connection settings" (posts `open-settings`) appears only inside the shell, with the app version. |
| CSS hook | `src/app/globals.css` | `html[data-nexus-shell]` disables the tap highlight and overscroll glow. |

Messages, web to native: `ready`, `navigated {path}`, `badge {count}`,
`open-settings`, `open-external {url}`, `haptic {style}`, `reload`.
Native to web: a `nexus-mobile-navigate` `CustomEvent` whose `detail.path` is
a dashboard path. Both sides sanitize paths the same way (`sanitizeShellPath`):
must start with `/`, no `//` or `/\`, no control characters, no `:` in the
path segment, at most 2048 characters. The shell only honours messages from
frames on the configured origin, and the shell global is only defined when
`location.origin` matches, so foreign content gets no bridge.

## Responsive approach

One codebase, one breakpoint of new global rules. `src/app/globals.css`
adds, below 768px: `html { overflow-x: clip }`; `overflow-wrap: anywhere`
for `.whitespace-pre-wrap` blocks (long tokens in briefs and logs wrap;
Chrome on Android otherwise widens the layout viewport to fit them, which
also stretches fixed bars); `min-width: 0` for direct children of `.flex`
and `.grid`; horizontal scrolling for `pre`; and `flex-wrap` for the shared
"Header HUD" rows (`header > .container.h-16`, used by eleven pages) and
for rows of three or more buttons, so labels wrap to a second line instead
of being squeezed. A body-wide `overflow-wrap: anywhere` was tried and
rejected: squeezed navigation labels broke into single characters. That
lets the existing `sm:`/`md:`/`lg:` layouts collapse to one column instead
of pushing the page wider than the phone. Targeted follow-ups: the home
header wraps and "New Project" becomes icon-only on phones; the academy
search box takes its own line and skill rows wrap; the inbox header wraps
and its text-size control is `shrink-0`; the event ticker clips its marquee
and its spans are `shrink-0` so they cannot collapse and overlap.

When adding a flex row of `whitespace-nowrap` items, give the items
`shrink-0` or `truncate`; under the phone rule a nowrap item without either
will shrink and its text will overflow its box.

## Audit tool

`npm run audit:responsive` (`scripts/responsive-audit.mjs`) drives headless
Chrome over the Chrome DevTools Protocol, loads each route at each width,
records `document.documentElement.scrollWidth` versus the viewport, lists the
widest offending elements and writes `report.json` plus a screenshot per
route and width. Environment: `AUDIT_BASE` (default `http://localhost:3000`),
`AUDIT_OUT`, `AUDIT_ROUTES`, `AUDIT_WIDTHS` (default `390,1440`),
`AUDIT_SETTLE_MS`, `AUDIT_CHROME`, `AUDIT_STRICT=1` to exit non-zero on any
overflow, `AUDIT_ALL_OFFENDERS=1` to print every element past the viewport
(clipped and off-screen ones too), and `AUDIT_PRE_JS` to run an expression
before measuring, which is how a candidate CSS fix can be bisected without a
rebuild. Unbreakable text is invisible to the element scan; when the
reported width exceeds every listed element, suspect text overflow. Run it against a production build; the supervised `next dev` on
:3000 was observed serving a stale `globals.css` chunk:

```sh
cd dashboard
NEXT_DIST_DIR=.next-verify npm run build   # then drop the .next-verify include Next appends to tsconfig.json
NEXT_DIST_DIR=.next-verify npx next start -p 3055
AUDIT_BASE=http://localhost:3055 AUDIT_OUT=/tmp/audit npm run audit:responsive
```

## Visual checks, 2026-09-07

Document scroll width at a 390px viewport (390 means no horizontal
overflow). "Before" is the dashboard without this change; "after" is the
production build with it. All routes measured 1440/1440 at the desktop
width before and after.

| Route | Before | After |
| --- | --- | --- |
| `/` | 780 | 390 |
| `/task-board` | 390 | 390 |
| `/inbox` | 398 | 390 |
| `/ops` | 654 | 390 |
| `/council` | 390 | 390 |
| `/model-control` | 1260 | 390 |
| `/system-monitor` | 523 | 390 |
| `/activity` | 1931 | 390 |
| `/academy` | 624 | 390 |
| `/codex` | 886 | 390 |
| `/knowledge-ingestion` | 431 | 390 |
| `/intake-reports` | 390 | 390 |
| `/studio` | 390 | 390 |
| `/calendar` | 390 | 390 |
| `/mail` | 390 | 390 |
| `/project/<id>` | 740 | 390 |
| `/task/<id>` | 417 | 390 |

## Acceptance mapping (dashboard side)

1. Canonical UI, no parallel native screens: the app's legacy tab group now
   redirects every native route to `/shell`, which renders this dashboard;
   the only phone-specific code in this repo is the bridge listed above.
2. Desktop routes and actions on the phone: the routes in the table above are
   the desktop routes, loaded unchanged. Desktop regression check: the 1440
   audit column, `npm test`, and `NEXT_DIST_DIR=.next-verify npm run build`.
3. Auth, connectivity, back navigation, notifications, deep links, chat,
   voice, attachments: owned by the shell; see the mobile repo's
   `docs/dashboard-shell.md` for what was tested and what is device-only.
4. Tests, typecheck, build and the Android artifact: recorded in the task
   completion report and the mobile repo document.

## Known limitations

- Browser speech recognition (the Web Speech API) is not available inside
  Android WebView; microphone capture via `getUserMedia` depends on the
  WebView permission grant, which the shell gives to the configured host only.
  Device verification is still needed.
- File and image pickers, the soft keyboard, and predictive back are Android
  WebView behaviours that were not exercised in this environment.
- Phone layouts were verified for horizontal overflow and by screenshot
  review, not by a full interaction pass of every dialog and form.

## Evidence location

The Android half of this task lives in `/Users/robertwashko/Projects/Nexus-Mobile-Android`, which the Praxis task re-point endpoint cannot bind (it only accepts `/Volumes/Projects`). The mobile diff against that repo's HEAD is recorded in `docs/mobile-shell-evidence/` (README with stat and hashes, plus the full patch), and the new shell files are staged in the mobile repo so they are tracked there.
